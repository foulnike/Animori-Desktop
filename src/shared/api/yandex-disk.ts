// Клиент Яндекс Диска: сеть и разбор ответов; что и когда уезжает, решают core/cloud-file.ts.
// Два шага (адрес живёт полчаса, ведёт на другой хост), копия — в app:, ссылка вместо входа.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'

/** Ресурсы Диска: и метаданные, и одноразовые адреса тел живут здесь. */
const API = 'https://cloud-api.yandex.net/v1/disk/resources'

/** Опубликованные ресурсы. Пропуск этим адресам не нужен и не передаётся. */
const PUBLIC_API = 'https://cloud-api.yandex.net/v1/disk/public/resources'

/**
 * Начало публичной ссылки Диска. Нужно, чтобы принять от человека один хвост
 * ссылки: на устройстве с пультом каждый лишний знак — лишняя минута.
 */
const SHARE_HOME = 'https://disk.yandex.ru'

/**
 * Корень папки приложения. Полный путь до файла собирает core/cloud.ts:
 * имя файла копии — дело формата, а не провайдера.
 */
export const DISK_APP_ROOT = 'app:'

/** Спросить адрес и метаданные — дело мгновенное; тело копии может быть большим. */
const LINK_TIMEOUT_MS = 20000
const BODY_TIMEOUT_MS = 60000

/**
 * Поля метаданных перечислены явно: иначе Диск шлёт полный объект ресурса с превью и правами.
 * Тип нужен ради одной проверки — не папка ли по ссылке.
 */
const FILE_FIELDS = 'name,size,modified,type,public_url'

/** Заголовки к публичным адресам: пропуска в них нет и быть не должно. */
const PUBLIC_HEADERS: Record<string, string> = { Accept: 'application/json' }

/** Что Диск знает о файле копии. Показывается человеку, программе не нужно. */
export interface DiskFileInfo {
  name: string
  bytes: number
  /** Время правки в виде ISO 8601, как его отдал Диск, или null. */
  modified: string | null
  /** Публичная ссылка на файл или null, если он не опубликован. */
  share: string | null
}

/** Исход обращения к Диску: отказ не исключение — экрану нужна фраза для человека, а не стек. */
export type DiskResult<T> = { ok: true; value: T } | { ok: false; problem: string }

/** Заголовки к API. Пропуск ходит только так: в адресе ему не место. */
function headers(token: string): Record<string, string> {
  return { Authorization: `OAuth ${token}`, Accept: 'application/json' }
}

/**
 * Путь Диска в виде значения параметра: приставку app: трогать нельзя — косая черта превратила бы её в папку
 * с двоеточием в имени. Для остальных путей вид с косой чертой равносилен «disk:/x» и короче при кодировании.
 */
function diskPath(path: string): string {
  if (path.startsWith(`${DISK_APP_ROOT}/`)) return encodeURIComponent(path)
  return encodeURIComponent(path.startsWith('/') ? path : `/${path}`)
}

/** Что сказал Диск словами: ключ ошибки в теле справочник обещает, но какой именно — нет. */
function said(text: string): string {
  try {
    const raw: unknown = JSON.parse(text)
    if (typeof raw !== 'object' || raw === null) return ''

    const body = raw as Record<string, unknown>
    for (const key of ['message', 'description', 'error']) {
      const value = body[key]
      if (typeof value === 'string' && value !== '') return value
    }
  } catch {
    // Не JSON — значит и сказать нечего.
  }
  return ''
}

/**
 * Ответ с кодом ошибки в человеческую фразу: поимённый разбор — не ради полноты, «507» ничего не говорит,
 * а «не хватает места» говорит всё. 403 назван прямо: у пропуска папки приложения других причин 403 нет.
 */
function problem(status: number, text: string, what: string): string {
  const words = said(text)
  const tail = words === '' ? '' : `: ${words}`

  if (status === 401) return 'Яндекс Диск не принял пропуск: он просрочен или введён с ошибкой'
  if (status === 403) {
    return `Яндекс Диск отказал в доступе: пропуск выдан без права на папку приложения${tail}`
  }
  if (status === 404) return `На Яндекс Диске этого нет${tail}`
  if (status === 409) return `Яндекс Диск не может это сделать сейчас${tail}`
  if (status === 413) return 'Копия больше, чем Яндекс Диск принимает одним файлом'
  if (status === 423) return 'Файл копии занят другой работой на Диске: повторите через минуту'
  if (status === 429) return 'Яндекс Диск просит сбавить темп: повторите через минуту'
  if (status === 507) return 'На Яндекс Диске не хватает места для копии'
  if (status >= 500) return `Яндекс Диск ответил ошибкой ${status}: это на их стороне`

  return `${what}: Яндекс Диск ответил ${status}${tail}`
}

/** То же для чтения по ссылке: советы другие — пропуска нет, но есть чужая ссылка и суточный предел на скачивание. */
function publicProblem(status: number, text: string, what: string): string {
  const words = said(text)
  const tail = words === '' ? '' : `: ${words}`

  if (status === 404) return 'По этой ссылке ничего нет: проверьте её или опубликуйте копию заново'
  if (status === 429) {
    return 'Яндекс ограничил скачивание по этой ссылке: повторите позже или заберите копию пропуском'
  }
  if (status >= 500) return `Яндекс Диск ответил ошибкой ${status}: это на их стороне`

  return `${what}: Яндекс Диск ответил ${status}${tail}`
}

/**
 * Сорванный запрос в человеческую фразу: мост отклоняется только сетевым отказом, различаем одно — молчание
 * по таймауту (советы в этих случаях разные).
 */
function offline(e: unknown, what: string): string {
  const kind =
    typeof e === 'object' && e !== null && 'kind' in e ? (e as { kind: unknown }).kind : ''

  if (kind === 'timeout') return `${what}: Яндекс Диск не ответил вовремя`
  return `${what}: запрос до Яндекс Диска не дошёл — проверьте сеть`
}

/** Тело ответа объектом. Разбор один на всех, кто спрашивает метаданные. */
function bodyOf(text: string, what: string): DiskResult<Record<string, unknown>> {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return { ok: false, problem: `${what}: Яндекс Диск ответил не по форме` }
  }

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, problem: `${what}: Яндекс Диск ответил не по форме` }
  }

  return { ok: true, value: raw as Record<string, unknown> }
}

/**
 * Адрес тела из ответа-ссылки: шаблонный адрес отклоняем честно — подставлять значения в скобки здесь нечем.
 */
function hrefOf(text: string, what: string): DiskResult<string> {
  const body = bodyOf(text, what)
  if (!body.ok) return body

  const link = body.value as { href?: unknown; templated?: unknown }
  if (link.templated === true) {
    return { ok: false, problem: `${what}: Диск прислал шаблон адреса вместо адреса` }
  }
  if (typeof link.href !== 'string' || link.href === '') {
    return { ok: false, problem: `${what}: Диск не прислал адрес файла` }
  }

  return { ok: true, value: link.href }
}

/** Сведения о ресурсе из его метаданных. */
function fileOf(item: Record<string, unknown>): DiskFileInfo {
  const share = item.public_url

  return {
    name: typeof item.name === 'string' ? item.name : '',
    bytes: typeof item.size === 'number' ? item.size : 0,
    modified: typeof item.modified === 'string' ? item.modified : null,
    share: typeof share === 'string' && share !== '' ? share : null,
  }
}

/**
 * Одноразовый адрес для тела файла: Диск отвечает объектом Link, разбирает его hrefOf — тот же разбор у публичного
 * чтения.
 */
async function linkFor(
  token: string,
  kind: 'upload' | 'download',
  path: string,
  extra: string,
  what: string,
): Promise<DiskResult<string>> {
  const url = `${API}/${kind}?path=${diskPath(path)}${extra}`

  try {
    const res = await Bridge.http.request({
      url,
      headers: headers(token),
      timeoutMs: LINK_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (!res.ok) return { ok: false, problem: problem(res.status, res.text, what) }

    return hrefOf(res.text, what)
  } catch (e) {
    Logger('WARN', `Яндекс Диск: адрес для ${kind} не получен`, e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Проверка пропуска: спрашивается папка приложения — самый дешёвый запрос, отвечающий на нужный вопрос.
 * Отсутствие папки тоже «годен»: её заведёт Диск сам, иначе честный пропуск выглядел бы негодным.
 */
export async function checkAccess(token: string): Promise<DiskResult<true>> {
  const what = 'Проверка пропуска'

  if (token.trim() === '') return { ok: false, problem: 'Пропуск Яндекс Диска не введён' }

  try {
    const res = await Bridge.http.request({
      url: `${API}?path=${diskPath(`${DISK_APP_ROOT}/`)}&fields=name`,
      headers: headers(token),
      timeoutMs: LINK_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (res.status === 404) {
      Logger('API', 'Яндекс Диск: пропуск принят, папки приложения ещё нет')
      return { ok: true, value: true }
    }

    if (!res.ok) return { ok: false, problem: problem(res.status, res.text, what) }

    Logger('API', 'Яндекс Диск: пропуск принят')
    return { ok: true, value: true }
  } catch (e) {
    Logger('WARN', 'Яндекс Диск: проверка пропуска не удалась', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Сведения о файле или null, если файла нет: отсутствие копии — законный ответ, а не отказ.
 */
export async function statFile(
  token: string,
  path: string,
): Promise<DiskResult<DiskFileInfo | null>> {
  const what = 'Сведения о копии'

  try {
    const res = await Bridge.http.request({
      url: `${API}?path=${diskPath(path)}&fields=${FILE_FIELDS}`,
      headers: headers(token),
      timeoutMs: LINK_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (res.status === 404) return { ok: true, value: null }
    if (!res.ok) return { ok: false, problem: problem(res.status, res.text, what) }

    const body = bodyOf(res.text, what)
    if (!body.ok) return body

    return { ok: true, value: fileOf(body.value) }
  } catch (e) {
    Logger('WARN', 'Яндекс Диск: сведения о файле не получены', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Кладёт текст файлом, всегда с перезаписью: копия одна, иначе два файла не различить.
 * Тело уходит по одноразовому адресу, пропуск для этого шага не нужен — он зашит в самом адресе.
 */
export async function uploadText(
  token: string,
  path: string,
  text: string,
): Promise<DiskResult<true>> {
  const what = 'Сохранение копии'

  const link = await linkFor(token, 'upload', path, '&overwrite=true', what)
  if (!link.ok) return link

  try {
    const res = await Bridge.http.request({
      method: 'PUT',
      url: link.value,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: text,
      timeoutMs: BODY_TIMEOUT_MS,
      credentials: 'omit',
    })

    // 201 — файл на месте, 202 — принят и вот-вот ляжет. Второе для нас
    // такой же успех: копия у Диска, а не у нас в памяти.
    if (res.status === 201 || res.status === 202) {
      Logger('API', `Яндекс Диск: копия сохранена (${text.length} знаков)`)
      return { ok: true, value: true }
    }

    return { ok: false, problem: problem(res.status, res.text, what) }
  } catch (e) {
    Logger('WARN', 'Яндекс Диск: тело копии не ушло', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Забирает текст файла: пропуск на втором шаге обязателен — в отличие от записи, адрес на чтение доступа сам
 * по себе не даёт (так велит справочник).
 */
export async function downloadText(token: string, path: string): Promise<DiskResult<string>> {
  const what = 'Чтение копии'

  const link = await linkFor(token, 'download', path, '', what)
  if (!link.ok) return link

  try {
    const res = await Bridge.http.request({
      url: link.value,
      headers: headers(token),
      timeoutMs: BODY_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (!res.ok) return { ok: false, problem: problem(res.status, res.text, what) }

    Logger('API', `Яндекс Диск: копия прочитана (${res.text.length} знаков)`)
    return { ok: true, value: res.text }
  } catch (e) {
    Logger('WARN', 'Яндекс Диск: тело копии не пришло', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Публикует копию и возвращает ссылку: publish отвечает адресом ресурса, public_url появляется в метаданных — за ними
 * второй запрос. Повторная публикация возвращает ту же ссылку, на этом держится кнопка «Показать ссылку».
 */
export async function shareFile(token: string, path: string): Promise<DiskResult<string>> {
  const what = 'Публикация копии'

  try {
    const res = await Bridge.http.request({
      method: 'PUT',
      url: `${API}/publish?path=${diskPath(path)}`,
      headers: headers(token),
      timeoutMs: LINK_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (!res.ok) return { ok: false, problem: problem(res.status, res.text, what) }
  } catch (e) {
    Logger('WARN', 'Яндекс Диск: публикация не удалась', e)
    return { ok: false, problem: offline(e, what) }
  }

  const info = await statFile(token, path)
  if (!info.ok) return info
  if (info.value === null) return { ok: false, problem: `${what}: копии на Диске нет` }
  if (info.value.share === null) {
    return { ok: false, problem: `${what}: Диск не прислал ссылку на файл` }
  }

  Logger('API', `Яндекс Диск: копия опубликована (${info.value.share})`)
  return { ok: true, value: info.value.share }
}

/** Снимает публикацию: сам файл остаётся, закрывается доступ по ссылке — старая не работает даже у знавших её. */
export async function unshareFile(token: string, path: string): Promise<DiskResult<true>> {
  const what = 'Закрытие ссылки'

  try {
    const res = await Bridge.http.request({
      method: 'PUT',
      url: `${API}/unpublish?path=${diskPath(path)}`,
      headers: headers(token),
      timeoutMs: LINK_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (!res.ok) return { ok: false, problem: problem(res.status, res.text, what) }

    Logger('API', 'Яндекс Диск: копия снята с публикации')
    return { ok: true, value: true }
  } catch (e) {
    Logger('WARN', 'Яндекс Диск: снять публикацию не удалось', e)
    return { ok: false, problem: offline(e, what) }
  }
}

/**
 * Ключ публикации: полная ссылка уходит как есть, хвост тоже — пультом 30 знаков не набрать.
 * Хвост без буквы неоднозначен (/i/ файл, /d/ папка): вариантов два, первым идёт файл.
 */
export function shareKeys(text: string): string[] {
  const line = text.trim()
  if (line === '') return []

  if (/^https?:\/\//i.test(line)) return [line]

  const tail = line.replace(/^\/+/, '')
  if (/^[id]\//i.test(tail)) return [`${SHARE_HOME}/${tail}`]

  return [`${SHARE_HOME}/i/${tail}`, `${SHARE_HOME}/d/${tail}`]
}

/**
 * Сведения о копии по ссылке — заодно проверка самой ссылки; пропуска нет, опубликованное Диск показывает любому.
 * Возвращается и подошедший ключ: перебор вариантов дело этого места, повторять его при чтении тела незачем.
 */
export async function publicInfo(
  link: string,
): Promise<DiskResult<{ key: string; file: DiskFileInfo }>> {
  const what = 'Сведения о копии по ссылке'

  const keys = shareKeys(link)
  if (keys.length === 0) return { ok: false, problem: 'Ссылка не введена' }

  let last = 'По этой ссылке ничего нет'

  for (const key of keys) {
    try {
      const res = await Bridge.http.request({
        url: `${PUBLIC_API}?public_key=${encodeURIComponent(key)}&fields=${FILE_FIELDS}`,
        headers: PUBLIC_HEADERS,
        timeoutMs: LINK_TIMEOUT_MS,
        credentials: 'omit',
      })

      // Не подошёл вид ссылки — пробуем следующий, а не сдаёмся: об отказе
      // говорим только когда кончились все варианты.
      if (res.status === 404) {
        last = publicProblem(404, res.text, what)
        continue
      }

      if (!res.ok) return { ok: false, problem: publicProblem(res.status, res.text, what) }

      const body = bodyOf(res.text, what)
      if (!body.ok) return body

      if (body.value.type === 'dir') {
        return { ok: false, problem: 'По ссылке лежит папка, а не файл копии' }
      }

      Logger('API', `Яндекс Диск: копия по ссылке найдена (${key})`)
      return { ok: true, value: { key, file: fileOf(body.value) } }
    } catch (e) {
      Logger('WARN', 'Яндекс Диск: сведения по ссылке не получены', e)
      return { ok: false, problem: offline(e, what) }
    }
  }

  return { ok: false, problem: last }
}

/**
 * Забирает текст копии по ключу публикации: два шага, пропуск не нужен ни на одном — и адрес тела,
 * и тело Диск отдаёт по ключу. Ключ берётся из publicInfo, там он уже проверен.
 */
export async function downloadPublic(key: string): Promise<DiskResult<string>> {
  const what = 'Чтение копии по ссылке'

  let href = ''

  try {
    const res = await Bridge.http.request({
      url: `${PUBLIC_API}/download?public_key=${encodeURIComponent(key)}`,
      headers: PUBLIC_HEADERS,
      timeoutMs: LINK_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (!res.ok) return { ok: false, problem: publicProblem(res.status, res.text, what) }

    const link = hrefOf(res.text, what)
    if (!link.ok) return link

    href = link.value
  } catch (e) {
    Logger('WARN', 'Яндекс Диск: адрес копии по ссылке не получен', e)
    return { ok: false, problem: offline(e, what) }
  }

  try {
    const res = await Bridge.http.request({
      url: href,
      headers: PUBLIC_HEADERS,
      timeoutMs: BODY_TIMEOUT_MS,
      credentials: 'omit',
    })

    if (!res.ok) return { ok: false, problem: publicProblem(res.status, res.text, what) }

    Logger('API', `Яндекс Диск: копия прочитана по ссылке (${res.text.length} знаков)`)
    return { ok: true, value: res.text }
  } catch (e) {
    Logger('WARN', 'Яндекс Диск: тело копии по ссылке не пришло', e)
    return { ok: false, problem: offline(e, what) }
  }
}
