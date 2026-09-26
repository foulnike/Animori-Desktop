// Загрузка датасета названий из выпусков animori-data: опись и два файла.
// Только сеть и байты в данные: хранение — core/dataset-names.ts; поля повторяют scripts/build-names.mjs.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'
import { githubLimiter } from './rate-limit'

/** Постоянный адрес файлов последнего выпуска; зеркала нет: jsDelivr выпуски не раздаёт (docs/DATA.md). */
const RELEASE_BASE = 'https://github.com/foulnike/animori-data/releases/latest/download'

/** Таймауты: опись крошечная, файлы — до полутора мегабайтов в сжатом виде. */
const INDEX_TIMEOUT_MS = 15000
const FILE_TIMEOUT_MS = 60000

/** Строка описи о файле выпуска: имя, размер и отпечаток сжатого тела. */
export interface DatasetFileRef {
  name: string
  bytes: number
  sha256: string
}

/** Опись выпуска. Единственный файл, который клиент тянет на каждой проверке. */
export interface DatasetIndex {
  version: number
  builtAt: string
  source: string
  sourceTag: string
  license: string
  files: DatasetFileRef[]
}

/**
 * Исход вопроса об описи: «тот же выпуск» (304) и «спросить не удалось» — разные события, второе не вправе сдвигать
 * час следующей проверки.
 */
export type DatasetIndexAnswer =
  /** Опись приехала и разобрана. `etag` пуст, если сервер его не дал. */
  | { kind: 'index'; index: DatasetIndex; etag: string }
  /** 304: тот же файл, что и в прошлую проверку. Тела в ответе нет вовсе. */
  | { kind: 'same' }
  /** Не достучались, ответ не тот или опись не разобрана. */
  | { kind: 'fail' }

/** Запись имени в файле titles. Поле id — номер Шикимори, он же номер MAL. */
export interface DatasetTitleRow {
  id: number
  name: string
  /** Пустая строка — ответ «русского имени нет», а не пропуск записи. */
  russian: string
  kind: string
  aired_on: string | null
  score: string | null
}

/** Распакованный файл имён. */
export interface DatasetTitlesPayload {
  v: number
  tag: string
  builtAt: string
  count: number
  titles: DatasetTitleRow[]
}

/** Распакованный файл карты: пара — [номер MAL, номер AniList]. */
export interface DatasetMapPayload {
  v: number
  tag: string
  builtAt: string
  count: number
  pairs: Array<[number, number]>
}

/** Годна ли опись: без даты сборки и списка файлов она бесполезна. */
function parseIndex(raw: unknown): DatasetIndex | null {
  if (typeof raw !== 'object' || raw === null) return null

  const candidate = raw as Partial<DatasetIndex>
  if (typeof candidate.builtAt !== 'string' || candidate.builtAt === '') return null
  if (!Array.isArray(candidate.files)) return null

  const files: DatasetFileRef[] = []
  for (const item of candidate.files) {
    if (!item || typeof item !== 'object') return null
    const row = item as Partial<DatasetFileRef>
    if (typeof row.name !== 'string' || row.name === '') return null
    if (typeof row.sha256 !== 'string' || row.sha256 === '') return null
    files.push({
      name: row.name,
      bytes: typeof row.bytes === 'number' ? row.bytes : 0,
      sha256: row.sha256,
    })
  }

  return {
    version: typeof candidate.version === 'number' ? candidate.version : 0,
    builtAt: candidate.builtAt,
    source: typeof candidate.source === 'string' ? candidate.source : '',
    sourceTag: typeof candidate.sourceTag === 'string' ? candidate.sourceTag : '',
    license: typeof candidate.license === 'string' ? candidate.license : '',
    files,
  }
}

/** base64 обратно в байты (мост ходит только так); тип ArrayBuffer нужен digest() и Blob. */
function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const raw = atob(text)
  const bytes = new Uint8Array(raw.length)
  for (let at = 0; at < raw.length; at++) bytes[at] = raw.charCodeAt(at)
  return bytes
}

/** Шестнадцатиричный отпечаток тела: сверка с описью до распаковки. */
async function sha256Hex(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  let hex = ''
  for (const byte of digest) hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** Распаковка gzip штатным потоком WebView2: сторонней библиотеки нет сознательно. */
async function gunzipText(packed: Uint8Array<ArrayBuffer>): Promise<string> {
  const stream = new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

/**
 * Опись последнего выпуска: с `knownEtag` запрос идёт с If-None-Match, код 304 проверяется ДО `res.ok` — у него
 * `ok` ложно. Хранения отпечатка здесь нет: память между запусками живёт в core/dataset-names.ts.
 */
export async function fetchDatasetIndex(knownEtag?: string | null): Promise<DatasetIndexAnswer> {
  const url = `${RELEASE_BASE}/index.json`
  const headers = knownEtag ? { 'If-None-Match': knownEtag } : undefined

  try {
    await githubLimiter.acquireSlot()
    const res = await Bridge.http.request({
      url,
      headers,
      timeoutMs: INDEX_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (res.status === 304) {
      Logger('DB', 'Датасет: опись не менялась (304)')
      return { kind: 'same' }
    }

    if (!res.ok) {
      Logger('WARN', `Датасет: опись ответила ${res.status}`)
      return { kind: 'fail' }
    }

    const index = parseIndex(JSON.parse(res.text))
    if (!index) {
      Logger('WARN', 'Датасет: опись не разобрана', res.text.slice(0, 200))
      return { kind: 'fail' }
    }

    // Ключи заголовков приведены к нижнему регистру самим мостом (IBridge.ts).
    return { kind: 'index', index, etag: res.headers['etag'] ?? '' }
  } catch (e) {
    Logger('WARN', 'Датасет: опись не загрузилась', e)
    return { kind: 'fail' }
  }
}

/** Файл выпуска распакованным или null; отпечаток сверяется до распаковки. */
export async function fetchDatasetPayload(file: DatasetFileRef): Promise<unknown | null> {
  const url = `${RELEASE_BASE}/${file.name}`

  try {
    await githubLimiter.acquireSlot()
    const res = await Bridge.http.requestBytes({
      url,
      timeoutMs: FILE_TIMEOUT_MS,
      credentials: 'omit',
    })
    if (!res.ok) {
      Logger('WARN', `Датасет: ${file.name} ответил ${res.status}`)
      return null
    }

    const packed = fromBase64(res.bytesBase64)

    const digest = await sha256Hex(packed)
    if (digest !== file.sha256) {
      Logger('WARN', `Датасет: отпечаток ${file.name} не сошёлся с описью`)
      return null
    }

    return JSON.parse(await gunzipText(packed)) as unknown
  } catch (e) {
    Logger('WARN', `Датасет: ${file.name} не загрузился или не разобрался`, e)
    return null
  }
}
