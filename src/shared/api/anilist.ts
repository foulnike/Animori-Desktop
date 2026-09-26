// Клиент AniList GraphQL: держатель общей паузы по лимиту и разбор ответов; тормоз живёт здесь —
// только клиент видит все запросы.

import { Bridge, BridgeHttpError, type HttpResponse } from '@/bridge'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import { anilistLimiter, MAX_RATE_RETRIES } from './rate-limit'

/** Идентификатор и ярлык источника в учёте состояния сети. */
export const NET_SOURCE_ANILIST = 'anilist:graphql'
export const NET_LABEL_ANILIST = 'AniList API'

/** Пауза по умолчанию, если сервер не прислал retry-after. */
const DEFAULT_RETRY_MS = 5000

/**
 * Первая пауза после отказа сервера и потолок роста: каждый следующий отказ удваивает её. Жёсткое значение
 * не годится обоим случаям — минутной аварии и отключению API на часы.
 */
const SERVER_FAIL_PAUSE_MS = 30000
const SERVER_FAIL_MAX_PAUSE_MS = 900000

/**
 * Порог ожидания внутри запроса: короткую паузу проще переждать на месте, длинную нельзя — обещание,
 * висящее пятнадцать минут, выглядит зависанием.
 */
const MAX_INLINE_WAIT_MS = 10000

/** Ключ хранилища для токена. Имя сохранено из монолита ради совместимости. */
const TOKEN_KEY = 'AL_TOKEN'

/**
 * Ключи хранилища отступа: два числа, а не одна запись — меняются и читаются по отдельности.
 */
const PAUSE_KEY = 'AL_PAUSE_UNTIL'
const STREAK_KEY = 'AL_FAIL_STREAK'

/** Unix-время, до которого запросы к AniList приостановлены. */
let alRateLimitPause = 0

/** Сколько отказов сервера подряд. Любой успешный ответ обнуляет. */
let serverFailStreak = 0

/** Копия токена в памяти: заполняется loadAlToken() до первого запроса. */
let alTokenCache = ''

/**
 * Есть ли пропуск у самой оболочки: в десктопе токен лежит в Rust и разметке не виден — без флажка клиент считал бы, что входа нет.
 */
let shellSigned = false

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Активна ли сейчас пауза: нужна очереди перевода — она не начинает пачку, пока сервер держит паузу.
 */
export function isAniListRateLimited(): boolean {
  return Date.now() < alRateLimitPause
}

/**
 * Сколько осталось до конца паузы: очередь засыпает ровно до её конца, а не просыпается каждую секунду ради журнала.
 */
export function anilistPauseRemaining(): number {
  return Math.max(0, alRateLimitPause - Date.now())
}

/** Число из хранилища. Чужая запись могла оказаться строкой или мусором. */
function numberFrom(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value

  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }

  return 0
}

/**
 * Пишет пару «отступ» целиком и никогда не отклоняется: порознь числа бессмысленны — запись удобство следующего запуска.
 */
function rememberBackOff(): void {
  void Bridge.storage.set(PAUSE_KEY, alRateLimitPause).catch((e: unknown) => {
    Logger('ERROR', 'Ошибка записи AL_PAUSE_UNTIL', e)
  })
  void Bridge.storage.set(STREAK_KEY, serverFailStreak).catch((e: unknown) => {
    Logger('ERROR', 'Ошибка записи AL_FAIL_STREAK', e)
  })
}

/**
 * Восстанавливает отступ после запуска: срок жив — встаём вместе с глубиной, срок прошёл — забываем (дверь могла
 * открыться). Потолок роста обязателен: запись «молчать до» из далёкого будущего заперла бы программу навсегда.
 */
export async function restoreAniListPause(): Promise<void> {
  try {
    const [storedPause, storedStreak] = await Promise.all([
      Bridge.storage.get<unknown>(PAUSE_KEY, 0),
      Bridge.storage.get<unknown>(STREAK_KEY, 0),
    ])

    const until = numberFrom(storedPause)
    const remaining = until - Date.now()

    if (remaining <= 0) {
      // Запись есть, но срок вышел: чистим, чтобы следующий запуск не читал старьё.
      if (until !== 0 || numberFrom(storedStreak) !== 0) {
        alRateLimitPause = 0
        serverFailStreak = 0
        rememberBackOff()
      }
      return
    }

    const capped = Math.min(remaining, SERVER_FAIL_MAX_PAUSE_MS)
    serverFailStreak = Math.max(0, Math.floor(numberFrom(storedStreak)))
    alRateLimitPause = Date.now() + capped
    anilistLimiter.pause(capped)

    Logger(
      'INFO',
      `AniList: отступ восстановлен, молчим ещё ${Math.round(capped / 1000)}с ` +
        `(отказов подряд до перезапуска: ${serverFailStreak})`,
    )
  } catch (e) {
    // Без восстановления программа работает как прежде: просто менее вежливо.
    Logger('ERROR', 'Ошибка чтения отступа AniList', e)
  }
}

/** Ставит паузу вручную. Существующая более долгая пауза не укорачивается. */
export function pauseAniList(ms: number): void {
  alRateLimitPause = Math.max(alRateLimitPause, Date.now() + ms)
  anilistLimiter.pause(ms)
  rememberBackOff()
}

export interface GraphQLResponse<T = unknown> {
  data?: T
  errors?: unknown
}

/**
 * Готовит клиент к работе (токен в память, отступ из прошлого запуска), один раз на старте; ошибки чтения запуск не роняют.
 */
export async function loadAlToken(): Promise<void> {
  try {
    const stored = await Bridge.storage.get<unknown>(TOKEN_KEY, '')
    alTokenCache = typeof stored === 'string' ? stored : ''
  } catch (e) {
    Logger('ERROR', 'Ошибка чтения AL_TOKEN', e)
    alTokenCache = ''
  }

  await restoreAniListPause()
}

/** Сохраняет токен: сначала в память, потом в хранилище. Никогда не отклоняется. */
export function setAlToken(token: string): void {
  alTokenCache = token
  void Bridge.storage.set(TOKEN_KEY, token).catch((e: unknown) => {
    Logger('ERROR', 'Ошибка записи AL_TOKEN', e)
  })
}

/**
 * Токен из настроек: его вписывают руками; второго источника нет — чужой сессии у своего окна не бывает.
 */
export function getAlToken(): string | null {
  return alTokenCache || null
}

/**
 * Сообщает, есть ли пропуск у оболочки; зовёт src/app/auth/session.ts. Сам токен не передаётся — пропуск не должен
 * появляться в разметке, а для выбора запроса достаточно самого факта.
 */
export function setShellSigned(value: boolean): void {
  if (shellSigned === value) return

  shellSigned = value
  Logger('INFO', `AniList: пропуск в оболочке ${value ? 'есть' : 'снят'}`)
}

/**
 * Есть ли чем подписать запрос: главный источник — пропуск оболочки, токен из настроек — второй. Спрашивают те,
 * кому без подписи идти в сеть незачем: список и очередь правок.
 */
export function canSignAniList(): boolean {
  return shellSigned || getAlToken() !== null
}

/**
 * Значение заголовка в любом регистре: мост в Rust имена понижает, обращение по точному имени не годится.
 */
function header(headers: Record<string, string>, name: string): string {
  const direct = headers[name]
  if (direct !== undefined) return direct

  const found = Object.keys(headers).find((key) => key.toLowerCase() === name)
  return found ? (headers[found] ?? '') : ''
}

/** Целое число из заголовка или NaN: сервер присылает их не в каждом ответе. */
function headerNumber(headers: Record<string, string>, name: string): number {
  const raw = header(headers, name)
  return raw ? parseInt(raw, 10) : NaN
}

/**
 * Заголовки разбора отказа; 403 у AniList двусмыслен (выключенный API, защита, запрет по стране): cf-* даёт защита,
 * retry-after — известный срок, живой остаток окна говорит, что дело не в частоте.
 */
const FAILURE_HEADERS: readonly string[] = [
  'cf-ray',
  'cf-mitigated',
  'cf-cache-status',
  'retry-after',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'server',
]

/**
 * Выписка заголовков отказа; отсутствующие не перечисляются — пустая выписка при 403 сообщает: отказало приложение сервера, а не Cloudflare.
 */
function failureDetails(headers: Record<string, string>): Record<string, string> {
  const details: Record<string, string> = {}

  for (const name of FAILURE_HEADERS) {
    const value = header(headers, name)
    if (value !== '') details[name] = value
  }

  return details
}

/**
 * Когда сбрасывается окно лимита (мс Unix). Заголовок бывает секундами Unix или остатком секунд: остаток — число
 * меньше 1e9 (Unix перевалил миллиард в 2001), иначе срок был бы пятидесятилетней давности.
 */
function readResetAt(headers: Record<string, string>): number {
  const reset = headerNumber(headers, 'x-ratelimit-reset')
  if (!Number.isFinite(reset) || reset <= 0) return NaN

  return reset > 1e9 ? reset * 1000 : Date.now() + reset * 1000
}

/** Учит ограничитель по заголовкам (потолок, остаток, сброс): возврат штатных 90 после техработ не
 * требует правки. */
function learnRateHeaders(headers: Record<string, string>): void {
  const limit = headerNumber(headers, 'x-ratelimit-limit')
  if (Number.isFinite(limit) && limit > 0) anilistLimiter.applyCeiling(limit)

  const remaining = headerNumber(headers, 'x-ratelimit-remaining')
  if (!Number.isFinite(remaining)) return

  const resetAt = readResetAt(headers)

  if (remaining > 0) {
    if (Number.isFinite(resetAt)) anilistLimiter.applyRemaining(remaining, resetAt)
    return
  }

  // Окно выбрано до конца: ждём сброса, не дожидаясь 429.
  const untilReset = Number.isFinite(resetAt) ? resetAt - Date.now() : NaN
  const wait = Number.isFinite(untilReset) && untilReset > 0 ? untilReset : DEFAULT_RETRY_MS
  anilistLimiter.pause(Math.min(wait + 500, 60000))
}

/**
 * Сколько ждать после 429: retry-after бывает секундами или датой по HTTP.
 * Дата молча подменялась дефолтом — сервер называл срок, а мы шли раньше, чем позвали.
 */
function readRetryAfter(headers: Record<string, string>): number {
  const raw = header(headers, 'retry-after').trim()
  if (raw === '') return DEFAULT_RETRY_MS

  // Вид «секунды». Number, а не parseInt: «120abc» — мусор, принимать его за две минуты хуже, чем не понять.
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000

  // Вид «дата»: срок считается от неё, а не от текущего мгновения.
  const until = Date.parse(raw)
  if (Number.isFinite(until)) {
    const wait = until - Date.now()
    // Названный срок уже прошёл: идти можно, но не в тот же миг — часы у нас и у сервера расходятся.
    return wait > 0 ? wait : DEFAULT_RETRY_MS
  }

  return DEFAULT_RETRY_MS
}

/**
 * Отказ ли это со стороны сервера, после которого надо отступить.
 * 403 включён сознательно: именно им AniList отвечал, когда выключал API целиком.
 */
function isServerFailure(status: number): boolean {
  return status === 403 || status === 408 || status >= 500
}

/**
 * Ставит растущую паузу после отказа сервера и возвращает её длину.
 * Журналится только вход в отступ: при лежачем API каждый отказ вытеснял из журнала всё.
 */
function backOffAfterServerFailure(status: number): number {
  const wasIdle = !isAniListRateLimited()

  serverFailStreak++
  const pause = Math.min(
    SERVER_FAIL_PAUSE_MS * Math.pow(2, serverFailStreak - 1),
    SERVER_FAIL_MAX_PAUSE_MS,
  )
  pauseAniList(pause)

  if (wasIdle) {
    Logger(
      'ERROR',
      `AniList отвечает ${status}: запросы приостановлены на ${Math.round(pause / 1000)}с ` +
        `(отказов подряд: ${serverFailStreak})`,
    )
  }

  return pause
}

/** GraphQL-запрос к AniList с паузой после 429 и ограниченными повторами. @param useAuth
 * Подписывать ли пропуском (подставляет мост); без него просьба понижается до публичного. */
export async function anilistQuery<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
  useAuth = false,
  attempt = 0,
): Promise<GraphQLResponse<T>> {
  const remaining = anilistPauseRemaining()
  if (remaining > 0) {
    // Длинную паузу не высиживаем внутри вызова — см. MAX_INLINE_WAIT_MS.
    if (remaining > MAX_INLINE_WAIT_MS) {
      throw new Error(`AniList недоступен, повтор через ${Math.ceil(remaining / 1000)}с`)
    }
    await sleep(remaining + Math.floor(Math.random() * 500))
  }

  // Подписать нечем: мост на такую просьбу отказывает целиком, и запрос,
  // которому пропуск был нужен лишь для своей закладки, не ушёл бы вовсе.
  const signed = useAuth && canSignAniList()
  if (useAuth && !signed) {
    Logger('API', 'AniList: вход не выполнен, запрос идёт без подписи')
  }

  Logger('API', 'GraphQL запрос (AniList)', {
    query: query.substring(0, 100) + '...',
    variables,
    useAuth: signed,
  })

  // Разрешение на отправку: сам темп знает только ограничитель.
  await anilistLimiter.acquireSlot()

  const startTime = performance.now()
  const startedAt = Date.now()

  let res: HttpResponse
  try {
    // Адрес, заголовки и пропуск — забота моста: в десктопе запрос идёт из Rust.
    res = await Bridge.anilist.query(JSON.stringify({ query, variables }), signed)
  } catch (e) {
    // Отказ не от сети, а от самого моста: например, пропуск стёрли между проверкой и отправкой.
    // Паузу ставить нельзя — она глушит и публичные запросы, а сервер тут ни при чём.
    if (!(e instanceof BridgeHttpError)) {
      Logger('ERROR', 'AniList: мост отклонил запрос', e)
      throw e instanceof Error ? e : new Error(String(e))
    }

    // Сеть упала — тот же отступ, иначе очередь крутит пачки вхолостую всё время без сети.
    reportError(NET_SOURCE_ANILIST, NET_LABEL_ANILIST, e, Date.now() - startedAt)
    backOffAfterServerFailure(0)
    Logger('ERROR', 'AniList Network Error', e)
    throw new Error('AniList Network Error')
  }

  // Учёт состояния до разбора кодов: факт ответа важен сам по себе.
  reportStatus(NET_SOURCE_ANILIST, NET_LABEL_ANILIST, res.status, Date.now() - startedAt)

  // Потолок, остаток окна и время сброса читаются из любого ответа, включая ошибки.
  learnRateHeaders(res.headers)

  if (res.status === 429) {
    const waitTime = readRetryAfter(res.headers)

    // Пауза ставится через общий вход: он же кладёт её в хранилище — перезапуск во время лимита не начнёт с чистого листа.
    pauseAniList(waitTime + 500)

    // Потолок был завышен: урезаем его и не верим росту ближайшие минуты.
    anilistLimiter.reduceCeiling()

    // Пауза ставится даже при исчерпанных повторах: остальные вызовы не должны добивать сервер.
    if (attempt >= MAX_RATE_RETRIES) {
      Logger('ERROR', `AniList Rate Limit 429: повторы исчерпаны (${MAX_RATE_RETRIES})`, res)
      throw new Error('AniList Rate Limit: повторы исчерпаны')
    }

    // Назначенный срок длиннее порога — не высиживаем: пауза уже стоит, а висящее полминуты обещание выглядит зависанием.
    if (waitTime > MAX_INLINE_WAIT_MS) {
      const seconds = Math.ceil(waitTime / 1000)
      Logger('ERROR', `AniList Rate Limit 429: сервер назвал ${seconds}с — ждём вне запроса`, res)
      throw new Error(`AniList Rate Limit: повтор через ${seconds}с`)
    }

    Logger(
      'ERROR',
      `AniList Rate Limit 429! Ожидание ${waitTime}ms (повтор ${attempt + 1} из ${MAX_RATE_RETRIES})`,
      res,
    )
    await sleep(waitTime + 500 + Math.floor(Math.random() * 500))
    return anilistQuery<T>(query, variables, useAuth, attempt + 1)
  }

  if (res.status !== 200) {
    // Сервер лежит или закрылся — отступаем, а не пробуем снова через полсекунды.
    if (isServerFailure(res.status)) {
      // Выписка до отступа и при каждом отказе: различия между ними и говорят, что происходит; затопить её нечем — дальше пауза.
      Logger('ERROR', `AniList ${res.status}: заголовки отказа`, failureDetails(res.headers))

      const pause = backOffAfterServerFailure(res.status)
      throw new Error(`AniList недоступен (${res.status}), пауза ${Math.round(pause / 1000)}с`)
    }

    Logger('ERROR', `AniList API Error HTTP ${res.status}`, res.text)
    throw new Error(`Error ${res.status}`)
  }

  // Сервер ответил — серия прервана; запись обновляется тут же, чтобы завтрашний запуск не отступал от вчерашней аварии.
  if (serverFailStreak > 0) {
    Logger('INFO', `AniList снова отвечает (отказов подряд было: ${serverFailStreak})`)
    serverFailStreak = 0
    rememberBackOff()
  }

  const timeTaken = Math.round(performance.now() - startTime)
  Logger('API', `[DONE] GraphQL запрос (AniList) выполнен за ${timeTaken}ms`)

  // Раньше битый JSON падал внутри onload и обещание не завершалось никогда.
  let payload: GraphQLResponse<T>
  try {
    payload = JSON.parse(res.text) as GraphQLResponse<T>
  } catch (e) {
    Logger('ERROR', 'AniList: не удалось разобрать ответ', e)
    throw new Error('AniList: некорректный ответ сервера')
  }

  if (payload.errors) {
    const message = JSON.stringify(payload.errors)
    Logger('ERROR', 'AniList GraphQL Error', payload.errors)
    throw new Error(`AniList GraphQL Error: ${message}`)
  }

  return payload
}
