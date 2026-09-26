// Клиент Kodik. Открытого API для ссылок нет — цепочка из трёх шагов (docs/ARCHITECTURE.md): поиск
// по номеру Шикимори → страница серии (подписи d_sign/pd_sign/ref_sign) → POST /ftor…

import { Bridge, type HttpResponse } from '@/bridge'
import { LIFE_VOICES_AIRING, LIFE_VOICES_FINISHED, isFresh } from '../core/cache-life'
import { dbGet, dbSet } from '../core/db'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import type { MediaCacheRecord } from '../core/types'
import type {
  PresenceMap,
  VideoEpisode,
  VideoRequest,
  VideoSource,
  VideoStream,
  VideoTrack,
  VideoVoice,
} from '../core/video'
import { kodikLimiter } from './rate-limit'

/** Ключ поиска: он же лежит в открытых плеерах на сайтах-партнёрах. */
const TOKEN = '16f20d024a6fa20700b389c44d9ab159'

const SEARCH_BASE = 'https://kodik-api.com'
const PLAYER_BASE = 'https://kodikplayer.com'

/** Имя источника для учёта доступности: net-health про адреса не знает. */
export const NET_SOURCE_KODIK = 'kodik'
export const NET_LABEL_KODIK = 'Kodik'

/** Страница серии рассчитана на браузер: без этих двух заголовков бывает заглушка. */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
const REFERER = PLAYER_BASE + '/'

const REQUEST_TIMEOUT_MS = 12000

/** Пауза ограничителю после 429. Джиттер разводит одновременные попытки. */
const RATE_PAUSE_MS = 1500

/** Сколько выборка озвучек живёт в памяти: за одно открытие её спросят трижды. */
const VOICES_MEMORY_MS = 600000

/** Ключ склада озвучек. Версия в имени: смена формы записи делает прежние негодными. */
const CACHE_PREFIX = 'KODIK1_'

/**
 * Потолок записи склада в строках серий: у долгоиграющих бывает 1000 серий в 5 озвучках — запись весит больше,
 * чем экономит; пусть поиск повторится.
 */
const CACHE_ROWS_MAX = 2000

/** Сколько записей просим в ответе о наличии: потолок службы — сотня, берём целиком — ответ читается до конца. */
const PRESENCE_LIMIT = 100

/** Дальше этой страницы ответ не дочитываем: тогда «нет» просто не ставится. */
const PRESENCE_PAGES = 3

/** Перебор сдвига шифра: все варианты, кроме тождественного. */
const SHIFTS: number[] = Array.from({ length: 25 }, (_, i) => i + 1)

/**
 * Русским именем считается только кириллица: латиница в title экран покажет и сама, а подменять ею русское имя
 * из датасета нельзя.
 */
const CYRILLIC = /[А-Яа-яЁё]/

/** Запись серии в ответе поиска: с with_episodes_data это объект, без него — строка. */
interface KodikEpisodeData {
  link?: string | null
  title?: string | null
}

type KodikEpisodeValue = string | KodikEpisodeData | null

interface KodikSeason {
  link?: string | null
  episodes?: Record<string, KodikEpisodeValue> | null
}

interface KodikTranslation {
  id?: number | null
  title?: string | null
}

/**
 * Сводка по тайтлу с with_material_data: поля объявлены только читаемые — остальные пришлось бы поддерживать без нужды.
 */
interface KodikMaterialData {
  anime_title?: string | null
  title?: string | null
  anime_description?: string | null
  description?: string | null
  episodes_aired?: number | null
  episodes_total?: number | null
}

interface KodikResult {
  id?: string | null
  type?: string | null
  link?: string | null
  /** Номер Шикимори: по нему оптовый ответ раскладывается обратно по тайтлам. */
  shikimori_id?: string | number | null
  translation?: KodikTranslation | null
  episodes_count?: number | null
  seasons?: Record<string, KodikSeason | null> | null
  material_data?: KodikMaterialData | null
}

interface KodikSearchResponse {
  results?: KodikResult[] | null
  /** Приезжает, когда записей больше запрошенного: готовый адрес следующей страницы. */
  next_page?: string | null
}

/** Ответ /ftor: карта высота → список адресов, где нужен первый. */
interface FtorLink {
  src?: string | null
}

interface FtorResponse {
  links?: Record<string, FtorLink[] | null> | null
}

/** Серия после разбора поиска: номер и адрес её страницы. */
interface KodikEpisodeRow {
  number: number
  link: string
  title?: string
}

/** Озвучка после разбора: у службы она и есть отдельная запись поиска. */
interface KodikVoiceRow {
  id: string
  label: string
  episodes: KodikEpisodeRow[]
}

/**
 * Сводка по тайтлу наружу. Любое поле вправе быть null: служба заполняет
 * material_data как придётся, и отсутствие имени — обычное дело, а не сбой.
 */
export interface KodikMaterial {
  russianTitle: string | null
  description: string | null
  episodesAired: number | null
  episodesTotal: number | null
}

/** Что даёт один ответ поиска: озвучки и сводка приезжают вместе. */
interface KodikFound {
  voices: KodikVoiceRow[]
  material: KodikMaterial | null
  /** Служба ответила разборчиво. Ложь означает молчание сети или мусор в теле: пустой список
   * озвучек в таком ответе не значит «озвучек нет» и на склад не ложится. */
  ok: boolean
}

/** Что лежит на складе: только озвучки с адресами серий, без сводки и описания. */
interface KodikVoicesRecord {
  voices: KodikVoiceRow[]
  /** Тайтл ещё выходит: состав серий прирастает, и срок записи короче. */
  airing: boolean
}

/** Ответ поиска в памяти запуска. */
interface FoundHeld {
  at: number
  found: KodikFound
  /** Запись пришла живым поиском: только у такой сводка означает ответ службы — складская её не хранит. */
  full: boolean
}

const foundMemory = new Map<number, FoundHeld>()
const pendingFound = new Map<number, Promise<KodikFound>>()

/** Удачный сдвиг прошлого разбора. Ноль — ещё ни разу не встречался. */
let knownShift = 0

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Общая отправка: никогда не отклоняется (любая неудача — null и журнал); коды вне 2xx разбираем сами. */
async function send(
  options: { method: 'GET' | 'POST'; url: string; headers?: Record<string, string>; body?: string },
  note: string,
): Promise<HttpResponse | null> {
  let res: HttpResponse
  // Замер идёт вместе с ожиданием слота: важно, сколько ждал экран.
  const startedAt = Date.now()
  try {
    await kodikLimiter.acquireSlot()

    res = await Bridge.http.request({
      method: options.method,
      url: options.url,
      headers: options.headers,
      body: options.body,
      timeoutMs: REQUEST_TIMEOUT_MS,
      credentials: 'omit',
    })
  } catch (e) {
    // Сюда приходит только транспортный сбой, таймаут или отмена.
    Logger('ERROR', `Kodik: сеть не дала ответ (${note})`, e)
    reportError(NET_SOURCE_KODIK, NET_LABEL_KODIK, e, Date.now() - startedAt)
    return null
  }

  reportStatus(NET_SOURCE_KODIK, NET_LABEL_KODIK, res.status, Date.now() - startedAt)

  if (res.status === 429) {
    // Пауза ставится ограничителю, а не нам: она притормозит и соседние запросы в очереди.
    const waitMs = RATE_PAUSE_MS + Math.floor(Math.random() * 500)
    kodikLimiter.pause(waitMs)

    Logger('ERROR', `Kodik: лимит 429, пауза ${waitMs}мс (${note})`)
    return null
  }

  if (res.status !== 200) {
    Logger('ERROR', `Kodik: HTTP ${res.status} (${note})`)
    return null
  }

  return res
}

function parseJson<T>(text: string, note: string): T | null {
  try {
    return JSON.parse(text) as T
  } catch (e) {
    Logger('ERROR', `Kodik: ответ не разобрался (${note})`, e)
    return null
  }
}

/** Адреса у службы приходят без схемы: //kodikplayer.com/seria/... */
function absolute(link: string): string {
  if (link.startsWith('//')) return 'https:' + link
  if (link.startsWith('/')) return PLAYER_BASE + link
  return link
}

/** Тело form-urlencoded своими руками: URLSearchParams в общем слое не объявлен. */
function formBody(fields: Record<string, string>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&')
}

/** Непустая строка или null: у службы пустое поле и отсутствие поля равнозначны. */
function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

/** Положительное число или null: нули у службы означают «неизвестно». */
function countOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
}

/**
 * Сводка из material_data: собирается по всем записям поиска — поле у одной озвучки бывает пустым, у соседней
 * полным; каждое берётся у первой записи, где оно есть, имя обязано быть кириллическим.
 */
function toMaterial(results: KodikResult[]): KodikMaterial | null {
  const found: KodikMaterial = {
    russianTitle: null,
    description: null,
    episodesAired: null,
    episodesTotal: null,
  }

  for (const item of results) {
    const data = item.material_data
    if (!data) continue

    if (found.russianTitle === null) {
      const name = textOrNull(data.anime_title) ?? textOrNull(data.title)
      if (name !== null && CYRILLIC.test(name)) found.russianTitle = name
    }

    found.description ??=
      textOrNull(data.anime_description) ?? textOrNull(data.description)
    found.episodesAired ??= countOrNull(data.episodes_aired)
    found.episodesTotal ??= countOrNull(data.episodes_total)
  }

  const empty =
    found.russianTitle === null &&
    found.description === null &&
    found.episodesAired === null &&
    found.episodesTotal === null

  return empty ? null : found
}

/**
 * Идёт ли тайтл: вышло меньше заявленного — идёт; неизвестно лишь одно — считаем идущим: короткий срок ошибается
 * лишним запросом, длинный — забытыми сериями.
 */
function looksAiring(material: KodikMaterial | null): boolean {
  const aired = material?.episodesAired ?? null
  const total = material?.episodesTotal ?? null
  if (aired === null || total === null) return true

  return aired < total
}

/** Ключ склада озвучек по номеру Шикимори. */
function voicesKey(shikimoriId: number): string {
  return CACHE_PREFIX + String(shikimoriId)
}

/**
 * Озвучки со склада. Пустая запись считается отсутствием: пустоту мы туда не
 * пишем, а значит она пришла из чужой версии формата.
 */
async function readVoices(shikimoriId: number): Promise<KodikVoiceRow[] | null> {
  const key = voicesKey(shikimoriId)

  try {
    const found = await dbGet<MediaCacheRecord<KodikVoicesRecord>>('mediaCache', key)
    if (!found) return null

    const rows = found.data.voices
    if (!Array.isArray(rows) || rows.length === 0) return null

    const life = found.data.airing === false ? LIFE_VOICES_FINISHED : LIFE_VOICES_AIRING
    if (!isFresh(key, found.ts, life)) return null

    return rows
  } catch (e) {
    // Склад — удобство, а не условие работы: без него просто спросим службу.
    Logger('WARN', `Kodik: склад не отдал озвучки ${shikimoriId}`, e)
    return null
  }
}

/**
 * Кладёт озвучки на склад. Ни описание, ни сводка туда не идут: они верны
 * на один запуск, а склад живёт неделями.
 */
function writeVoices(shikimoriId: number, found: KodikFound): void {
  if (!found.ok || found.voices.length === 0) return

  const rows = found.voices.reduce((sum, voice) => sum + voice.episodes.length, 0)
  if (rows > CACHE_ROWS_MAX) {
    Logger('WARN', `Kodik: озвучки ${shikimoriId} не легли на склад, строк ${rows}`)
    return
  }

  void dbSet('mediaCache', {
    key: voicesKey(shikimoriId),
    data: { voices: found.voices, airing: looksAiring(found.material) },
    ts: Date.now(),
  }).catch((e: unknown) => {
    Logger('WARN', `Kodik: склад не принял озвучки ${shikimoriId}`, e)
  })
}

/**
 * Значение var со страницы: пустая строка законна — страница без ссылающейся стороны кладёт ref = "" и подпись
 * ставит на пустой, поэтому [^"']* неотличим без плюса от «переменной нет».
 */
function pickVar(html: string, name: string): string | null {
  const found = new RegExp(`var\\s+${name}\\s*=\\s*["']([^"']*)["']`).exec(html)
  return found?.[1] ?? null
}

function pickInfo(html: string, name: string): string | null {
  const found = new RegExp(`vInfo\\.${name}\\s*=\\s*["']([^"']+)["']`).exec(html)
  return found?.[1] ?? null
}

/**
 * Собирает подписи со страницы: признаки из vInfo, а при его переименовании — из адреса страницы. Обязательны
 * только подписи и признаки; domain, pd и ref вправе быть пустыми — страница подписывает и пустую строку.
 */
function readPage(html: string, pageUrl: string): PageFields | null {
  const path = /\/(video|seria|serial)\/(\d+)\/([0-9a-z]+)/i.exec(pageUrl)

  const fields: PageFields = {
    d: pickVar(html, 'domain') ?? pickVar(html, 'd') ?? '',
    dSign: pickVar(html, 'd_sign') ?? '',
    pd: pickVar(html, 'pd') ?? '',
    pdSign: pickVar(html, 'pd_sign') ?? '',
    ref: pickVar(html, 'ref') ?? '',
    refSign: pickVar(html, 'ref_sign') ?? '',
    type: pickInfo(html, 'type') ?? path?.[1] ?? '',
    id: pickInfo(html, 'id') ?? path?.[2] ?? '',
    hash: pickInfo(html, 'hash') ?? path?.[3] ?? '',
  }

  const needed: Array<keyof PageFields> = ['dSign', 'pdSign', 'refSign', 'type', 'id', 'hash']
  const empty = needed.filter((key) => fields[key] === '')

  if (empty.length > 0) {
    Logger('ERROR', `Kodik: на странице серии нет полей: ${empty.join(', ')}`, {
      length: html.length,
    })
    return null
  }

  return fields
}

/** Подписи и признаки со страницы серии — всё, что нужно для /ftor. */
interface PageFields {
  d: string
  dSign: string
  pd: string
  pdSign: string
  ref: string
  refSign: string
  type: string
  hash: string
  id: string
}

/** Что дал вопрос об одном номере: `found` — признак, а не множество (спрашиваем всегда про один номер). */
interface KodikSeen {
  found: boolean
  /** Ответ дочитан до последней страницы. Нет — «нет» из него не следует. */
  complete: boolean
}

/** Сдвиг латинских букв по кругу внутри своего регистра. */
function shiftLetters(text: string, by: number): string {
  return text.replace(/[a-zA-Z]/g, (letter) => {
    const limit = letter <= 'Z' ? 90 : 122
    const next = letter.charCodeAt(0) + by
    return String.fromCharCode(limit >= next ? next : next - 26)
  })
}

/** Свой base64: atob в общем слое не объявлен, а подключать DOM ради одной строки незачем. */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function fromBase64(text: string): string | null {
  let bits = 0
  let acc = 0
  let out = ''

  for (const letter of text) {
    if (letter === '=') break

    const value = B64.indexOf(letter)
    if (value < 0) return null

    acc = (acc << 6) | value
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out += String.fromCharCode((acc >> bits) & 255)
    }
  }

  return out
}

/**
 * Расшифровывает адрес из /ftor: изредка служба отдаёт его открытым — если в строке есть //, она уже адрес.
 */
function decodeLink(src: string): string | null {
  if (src.includes('//')) return src

  const order = knownShift > 0 ? [knownShift, ...SHIFTS.filter((k) => k !== knownShift)] : SHIFTS

  for (const by of order) {
    const plain = fromBase64(shiftLetters(src, by))
    if (plain === null || !plain.includes('.m3u8')) continue
    if (!plain.startsWith('//') && !plain.startsWith('http')) continue

    if (by !== knownShift) {
      Logger('API', `Kodik: сдвиг шифра сейчас ${by}`)
      knownShift = by
    }
    return plain
  }

  return null
}

/** Верить надо метке, а не длительности — час выдачи округляется вверх, запас разный. Нет подписи —
 * null: пусть плеер споткнётся об отказ CDN, чем мы придумаем срок. */
function expiryOf(url: string): number | null {
  const found = /:(\d{10})\//.exec(url)
  const stamp = found?.[1]
  if (stamp === undefined) return null

  const year = Number(stamp.slice(0, 4))
  const month = Number(stamp.slice(4, 6))
  const day = Number(stamp.slice(6, 8))
  const hour = Number(stamp.slice(8, 10))
  if (!Number.isFinite(year) || month < 1 || month > 12 || day < 1 || day > 31) return null

  return Date.UTC(year, month - 1, day, hour)
}

/**
 * Дорожки из ответа /ftor: один адрес часто лежит под двумя высотами (на замере 480 и 720 вели на 480.mp4) —
 * адреса сворачиваются, высотой берётся меньшая из заявленных.
 */
function toTracks(links: Record<string, FtorLink[] | null> | null | undefined): VideoTrack[] {
  const byUrl = new Map<string, number>()

  for (const [key, list] of Object.entries(links ?? {})) {
    const height = Number.parseInt(key, 10)
    const src = list?.[0]?.src
    if (!Number.isFinite(height) || typeof src !== 'string' || src === '') continue

    const plain = decodeLink(src)
    if (plain === null) {
      Logger('WARN', `Kodik: адрес ${key}p не расшифровался ни одним сдвигом`)
      continue
    }

    const url = absolute(plain)
    const known = byUrl.get(url)
    if (known === undefined || height < known) byUrl.set(url, height)
  }

  return [...byUrl.entries()]
    .map(([url, height]) => ({ height, url }))
    .sort((a, b) => b.height - a.height)
}

/** Серии одной записи поиска: сезоны по порядку, фильм — одной серией. */
function episodesOf(item: KodikResult): KodikEpisodeRow[] {
  const rows: KodikEpisodeRow[] = []
  const seasons = Object.entries(item.seasons ?? {}).sort(
    (a, b) => Number.parseInt(a[0], 10) - Number.parseInt(b[0], 10),
  )

  for (const [, season] of seasons) {
    for (const [key, value] of Object.entries(season?.episodes ?? {})) {
      const number = Number.parseInt(key, 10)
      const link = typeof value === 'string' ? value : (value?.link ?? '')
      const title = typeof value === 'string' ? null : (value?.title ?? null)
      if (!Number.isFinite(number) || link === '') continue
      if (rows.some((row) => row.number === number)) continue

      rows.push({ number, link, ...(title ? { title } : {}) })
    }
  }

  // Фильм сезонов не имеет вовсе: его адрес лежит в самой записи.
  if (rows.length === 0 && typeof item.link === 'string' && item.link !== '') {
    rows.push({ number: 1, link: item.link })
  }

  return rows.sort((a, b) => a.number - b.number)
}

/** Собирает озвучки из ответа поиска: запись на каждую озвучку своя. */
function toVoices(results: KodikResult[]): KodikVoiceRow[] {
  const rows = new Map<string, KodikVoiceRow>()

  for (const item of results) {
    const id = item.translation?.id
    const key = typeof id === 'number' ? String(id) : (item.translation?.title ?? '')
    if (key === '') continue

    const episodes = episodesOf(item)
    if (episodes.length === 0) {
      Logger('WARN', `Kodik: у записи ${item.id ?? key} нет ни одного адреса серии`)
      continue
    }

    const known = rows.get(key)
    const row = known ?? {
      id: key,
      label: item.translation?.title ?? `Озвучка ${key}`,
      episodes: [],
    }

    for (const episode of episodes) {
      if (!row.episodes.some((e) => e.number === episode.number)) row.episodes.push(episode)
    }

    row.episodes.sort((a, b) => a.number - b.number)
    rows.set(key, row)
  }

  // Самые полные озвучки выше: выбирать из пяти легче, когда первая годная.
  return [...rows.values()].sort((a, b) => b.episodes.length - a.episodes.length)
}

/** Ответ поиска по номеру Шикимори: десять минут в памяти целиком — озвучки и сводка едут одним
 * ответом. */
async function loadFound(shikimoriId: number): Promise<KodikFound> {
  const known = foundMemory.get(shikimoriId)
  if (known?.full && Date.now() - known.at < VOICES_MEMORY_MS) return known.found

  const pending = pendingFound.get(shikimoriId)
  if (pending) return pending

  const task = loadFoundUncached(shikimoriId)
  pendingFound.set(shikimoriId, task)

  try {
    const found = await task
    foundMemory.set(shikimoriId, { at: Date.now(), found, full: true })
    writeVoices(shikimoriId, found)
    return found
  } finally {
    pendingFound.delete(shikimoriId)
  }
}

async function loadFoundUncached(shikimoriId: number): Promise<KodikFound> {
  Logger('API', `Запрос Kodik для Shikimori ID: ${shikimoriId}`)

  const query = [
    'token=' + TOKEN,
    'shikimori_id=' + String(shikimoriId),
    'with_seasons=true',
    'with_episodes=true',
    'with_episodes_data=true',
    'with_material_data=true',
  ].join('&')

  const res = await send({ method: 'GET', url: `${SEARCH_BASE}/search?${query}` }, 'поиск')
  if (res === null) return { voices: [], material: null, ok: false }

  const found = parseJson<KodikSearchResponse>(res.text, 'поиск')
  if (found === null) return { voices: [], material: null, ok: false }

  const results = found.results ?? []

  return { voices: toVoices(results), material: toMaterial(results), ok: true }
}

/**
 * Озвучки по номеру Шикимори: память запуска, затем склад, затем служба. Складская запись и есть экономия —
 * адреса страниц серий постоянны, повторное открытие обходится без поиска.
 */
async function loadVoices(shikimoriId: number): Promise<KodikVoiceRow[]> {
  const known = foundMemory.get(shikimoriId)
  if (known && Date.now() - known.at < VOICES_MEMORY_MS) return known.found.voices

  const stored = await readVoices(shikimoriId)
  if (stored !== null) {
    // В память складская запись ложится с пометкой «сводки нет»: иначе
    // kodikMaterial счёл бы её ответом службы и вернул бы пустое имя.
    foundMemory.set(shikimoriId, {
      at: Date.now(),
      found: { voices: stored, material: null, ok: true },
      full: false,
    })
    return stored
  }

  const found = await loadFound(shikimoriId)
  return found.voices
}

/**
 * Один вопрос об одном номере: знает ли служба такой тайтл — без сезонов, серий и сводки; номер уходит по одному
 * нарочно (перечень не принимается ни в одной форме, см. шапку). null — служба не ответила вовсе, а не «нет».
 */
async function askOne(id: number): Promise<KodikSeen | null> {
  let found = false
  const query = [
    'token=' + TOKEN,
    'shikimori_id=' + String(id),
    'limit=' + String(PRESENCE_LIMIT),
  ].join('&')

  let url = `${SEARCH_BASE}/search?${query}`
  let answered = false

  for (let page = 0; page < PRESENCE_PAGES && url !== ''; page += 1) {
    const res = await send({ method: 'GET', url }, 'наличие')
    if (res === null) return answered ? { found, complete: false } : null

    answered = true

    const body = parseJson<KodikSearchResponse>(res.text, 'наличие')
    if (body === null) return { found, complete: false }

    for (const item of body.results ?? []) {
      if (Number(item.shikimori_id) === id) found = true
    }

    url = typeof body.next_page === 'string' ? body.next_page : ''
  }

  // Осталась непрочитанная страница: найденному верим, ненайденному — нет.
  return { found, complete: url === '' }
}

/** Наличие входа про нескольких: ключ — номер Шикимори, невысказанных номеров в ответе нет. */
export async function kodikPresence(ids: readonly number[]): Promise<Map<number, boolean>> {
  const out = new Map<number, boolean>()
  const queue = [...new Set(ids.filter((id) => Number.isFinite(id) && id > 0))]

  for (const id of queue) {
    const answer = await askOne(id)
    if (answer === null) continue

    if (answer.found) out.set(id, true)
    else if (answer.complete) out.set(id, false)
  }

  return out
}

/**
 * Сводка по тайтлу: своих запросов не делает — отдаёт полученное или тянет тот же поиск, что нужен для озвучек.
 * Null — тайтл не известен или material_data пуст (не сбой); склад сводку не хранит — протухшее описание хуже.
 */
export async function kodikMaterial(shikimoriId: number): Promise<KodikMaterial | null> {
  if (!Number.isFinite(shikimoriId) || shikimoriId <= 0) return null

  const found = await loadFound(shikimoriId)
  return found.material
}

/** Подписи со страницы серии. Запрашивается в последний момент и не кэшируется. */
async function loadPageFields(pageUrl: string): Promise<PageFields | null> {
  const res = await send(
    { method: 'GET', url: pageUrl, headers: { 'User-Agent': UA, Referer: REFERER } },
    'страница серии',
  )
  if (res === null) return null

  return readPage(res.text, pageUrl)
}

/** Сами адреса: подписи едут тем же видом, что их отправляет сам плеер. */
async function askFtor(pageUrl: string, fields: PageFields): Promise<VideoTrack[]> {
  const body = formBody({
    d: fields.d,
    d_sign: fields.dSign,
    pd: fields.pd,
    pd_sign: fields.pdSign,
    ref: fields.ref,
    ref_sign: fields.refSign,
    bad_user: 'false',
    cdn_is_working: 'true',
    type: fields.type,
    hash: fields.hash,
    id: fields.id,
  })

  const res = await send(
    {
      method: 'POST',
      url: PLAYER_BASE + '/ftor',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': UA,
        Referer: pageUrl,
      },
      body,
    },
    'ссылки',
  )
  if (res === null) return []

  const found = parseJson<FtorResponse>(res.text, 'ссылки')
  const tracks = toTracks(found?.links)

  // Отказ подписи и пустой ответ извне выглядят одинаково: пишем различимое.
  if (tracks.length === 0) {
    Logger('WARN', 'Kodik: /ftor ответил без пригодных адресов', {
      length: res.text.length,
      keys: Object.keys(found?.links ?? {}),
    })
  }

  return tracks
}

/** Источник целиком. В реестр он попадает из api/video-sources.ts, а не отсюда. */
export const kodikSource: VideoSource = {
  id: 'kodik',
  label: NET_LABEL_KODIK,

  async listVoices(req: VideoRequest): Promise<VideoVoice[]> {
    // Вход у службы только по номеру Шикимори: поиск по названию уводит в чужой сезон.
    const id = req.shikimoriId
    if (id === null || id <= 0) {
      Logger('WARN', `Kodik: у тайтла ${req.anilistId} нет номера Шикимори`)
      return []
    }

    const rows = await loadVoices(id)
    return rows.map((row) => ({ id: row.id, label: row.label, episodes: row.episodes.length }))
  },

  /**
   * Вопрос о наличии стоит запроса на тайтл, и это честно: оптовой формы нет, а обещать 'batch' значило бы врать —
   * слой показа по метке отправил бы пачку, которую служба встретит отказом.
   */
  presenceCost: 'each',

  async askPresence(reqs: readonly VideoRequest[]): Promise<PresenceMap> {
    // Номер Шикимори — единственный вход. Тайтл без него службе не адресуем:
    // его отсутствие в ответе означало бы лишь то, что мы не смогли спросить.
    const byShiki = new Map<number, number[]>()

    for (const req of reqs) {
      const id = req.shikimoriId
      if (id === null || id <= 0) continue

      const known = byShiki.get(id)
      if (known) known.push(req.anilistId)
      else byShiki.set(id, [req.anilistId])
    }

    const out: PresenceMap = new Map()
    if (byShiki.size === 0) return out

    const answer = await kodikPresence([...byShiki.keys()])

    for (const [shikimoriId, state] of answer) {
      for (const anilistId of byShiki.get(shikimoriId) ?? []) out.set(anilistId, state)
    }

    return out
  },

  async listEpisodes(req: VideoRequest, voiceId: string): Promise<VideoEpisode[]> {
    const id = req.shikimoriId
    if (id === null || id <= 0) return []

    const rows = await loadVoices(id)
    const row = rows.find((r) => r.id === voiceId)

    // Отрезки заставки и титров служба держит на странице серии, а не в поиске:
    // читать их сейчас значило бы скачать страницу каждой серии заранее.
    return (row?.episodes ?? []).map((episode) => ({
      number: episode.number,
      ...(episode.title ? { title: episode.title } : {}),
    }))
  },

  async resolve(req: VideoRequest, voiceId: string, episode: number): Promise<VideoStream | null> {
    const id = req.shikimoriId
    if (id === null || id <= 0) return null

    const rows = await loadVoices(id)
    const row = rows.find((r) => r.id === voiceId)
    const found = row?.episodes.find((e) => e.number === episode)

    if (!found) {
      Logger('WARN', `Kodik: у озвучки ${voiceId} нет серии ${episode}`)
      return null
    }

    const pageUrl = absolute(found.link)

    try {
      const fields = await loadPageFields(pageUrl)
      if (fields === null) return null

      const tracks = await askFtor(pageUrl, fields)
      const preferred = tracks[0]
      if (preferred === undefined) {
        Logger('WARN', `Kodik: ответ по серии ${episode} без ни одного годного адреса`)
        return null
      }

      return { source: 'kodik', tracks, preferred, expiresAt: expiryOf(preferred.url) }
    } catch (e) {
      // Цепочка длинная, и любой её шаг вправе рассыпаться: молча не уйдёт.
      Logger('ERROR', `Kodik: цепочка серии ${episode} не прошла: ${describe(e)}`, e)
      return null
    }
  },
}

/** Только для проверок и кнопки очистки: память сама себя не чистит, склад сносит своя кнопка. */
export function forgetKodikVoices(): void {
  foundMemory.clear()
  pendingFound.clear()
  knownShift = 0
}
