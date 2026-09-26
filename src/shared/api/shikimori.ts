// Клиент Shikimori: публичные карточки и GraphQL с перебором зеркал; куки не шлём. Перебор зеркал,
// темп, пауза по 429 и выбор предпочтённого адреса собраны в askMirrors.

import { Bridge } from '@/bridge'
import { SHIKI_DOMAINS } from '../core/constants'
import {
  describeState,
  getHealth,
  isTroubled,
  registerProbe,
  reportError,
  reportStatus,
} from '../core/net-health'
import { Logger } from '../utils/logger'
import { MAX_RATE_RETRIES, RateLimitError, shikiLimiter } from './rate-limit'

/** Штрафная пауза после 429. */
const RATE_PAUSE_MS = 5000
/** Таймаут одного зеркала: дольше ждать нет смысла, лучше уйти на следующее. */
const MIRROR_TIMEOUT_MS = 5000
/** Таймаут запроса в GraphQL: одна пачка отвечает за пятьдесят тайтлов, пять секунд ей коротки. */
const GRAPHQL_TIMEOUT_MS = 8000
/** Ключ хранилища с рабочим зеркалом. */
const MIRROR_KEY = 'SHIKI_MIRROR'
/** Чем спрашиваем зеркало «ты живо?»: одна карточка — самый дешёвый ответ на всём пути. */
const PROBE_PATH = '/api/animes/1'

/** Зеркало, ответившее данными последним: пробуется первым и на сеанс, и в следующий запуск. */
let preferredDomain: string | null = null

/** Однократное чтение хранилища; промис, а не флаг: первые запросы уходят пачкой и ждут одно чтение. */
let preferredReady: Promise<void> | null = null

/** Имя источника для учёта зеркала; здесь, а не в net-health: тот адресов не знает. */
function netId(domain: string): string {
  return `shikimori:${domain}`
}

/** Читает рабочее зеркало из хранилища раз за сеанс; адрес мог исчезнуть из сборки — сверяется со списком. */
function loadPreferred(): Promise<void> {
  if (preferredReady) return preferredReady

  preferredReady = (async () => {
    try {
      const stored = await Bridge.storage.get<unknown>(MIRROR_KEY, '')
      const domain = typeof stored === 'string' ? stored : ''
      if (domain && SHIKI_DOMAINS.includes(domain)) {
        preferredDomain = domain
        Logger('API', `Shikimori: прошлый запуск ходил через ${domain}`)
      }
    } catch (e) {
      // Не беда: без памяти обход просто начнёт со стартового порядка.
      Logger('ERROR', 'Ошибка чтения рабочего зеркала Shikimori', e)
    }
  })()

  return preferredReady
}

/** Пишет рабочее зеркало или стирает память (пустая строка); ошибка записи не валит запрос. */
async function rememberPreferred(domain: string): Promise<void> {
  try {
    await Bridge.storage.set(MIRROR_KEY, domain)
  } catch (e) {
    Logger('ERROR', 'Ошибка записи рабочего зеркала Shikimori', e)
  }
}

/** Порядок перебора: предпочтённый в начало; отпавшие не исключаются — тайтл живёт на другом зеркале. */
function mirrorOrder(): string[] {
  const preferred = preferredDomain
  if (!preferred || !SHIKI_DOMAINS.includes(preferred)) return [...SHIKI_DOMAINS]
  return [preferred, ...SHIKI_DOMAINS.filter((d) => d !== preferred)]
}

/** Причина бесполезности Shikimori или null; сводится по И: пока отвечает хоть одно зеркало, данные будут. */
export function shikimoriTrouble(): string | null {
  let detail: string | null = null

  for (const domain of SHIKI_DOMAINS) {
    const id = netId(domain)
    if (!isTroubled(id)) return null
    if (detail === null) {
      const state = getHealth(id)?.state
      if (state) detail = describeState(state)
    }
  }

  return detail
}

/** Собирает абсолютный адрес для конкретного зеркала. */
function mirrorUrl(domain: string, path: string): string {
  return 'https://' + domain + path
}

/** Активна ли пауза по лимиту Shikimori: очередь перевода проверяет это перед каждой пачкой. */
export function isShikimoriRateLimited(): boolean {
  return shikiLimiter.isPaused()
}

/** Ставит паузу вручную (например, 429 увидел поиск персон). */
export function pauseShikimori(ms: number): void {
  shikiLimiter.pause(ms)
}

export interface ShikiResponse<T = unknown> {
  /** null означает "не найдено" либо полный сбой всех зеркал. */
  data: T | null
  /** Домен зеркала, ответившего успешно. */
  domain: string | null
}

/** Что именно отправляем на зеркало. Путь всегда без домена. */
interface MirrorRequest {
  method: 'GET' | 'POST'
  path: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
  /** Приписка к строке журнала: у GraphQL путь один на все запросы. */
  note?: string
}

/** Конверт ответа GraphQL. Ошибки при наличии данных — частичный ответ, а не сбой. */
interface GraphqlReply<T> {
  data?: T | null
  errors?: unknown
}

/**
 * Общий обход зеркал: слот темпа, отчёт о доступности, трактовка кодов, повтор по 429. `read` бросает
 * исключение на негодном ответе: это «беда ответа, не адреса». @param attempt — с нуля после 429.
 */
async function askMirrors<T>(
  req: MirrorRequest,
  read: (text: string) => T,
  attempt: number,
): Promise<ShikiResponse<T>> {
  const tail = req.note ? ` — ${req.note}` : ''
  Logger('API', `Запрос к Shikimori API: ${req.path}${tail}`)

  // Память зеркала читается до построения порядка: ради неё её и завели.
  await loadPreferred()

  let lastNotFound: ShikiResponse<T> | null = null
  let mirrorFailures = 0

  for (const domain of mirrorOrder()) {
    // Замер свой на каждое зеркало и включает ожидание слота: важно время очереди.
    const startedAt = Date.now()

    try {
      // Слот берём перед каждой отправкой: зеркала делят один бюджет, а не имеют по своему.
      await shikiLimiter.acquireSlot()

      const r = await Bridge.http.request({
        method: req.method,
        url: mirrorUrl(domain, req.path),
        headers: req.headers,
        body: req.body,
        timeoutMs: req.timeoutMs ?? MIRROR_TIMEOUT_MS,
        credentials: 'omit',
      })

      // Отчёт до разбора кодов: net-health игнорирует 429, а 404 трактует как «связь есть».
      reportStatus(netId(domain), `Shikimori (${domain})`, r.status, Date.now() - startedAt)

      if (r.status === 429) {
        // Паузу ставим всегда: она притормозит и поиск персон, и очередь перевода.
        shikiLimiter.pause(RATE_PAUSE_MS)

        if (attempt + 1 >= MAX_RATE_RETRIES) {
          Logger('ERROR', `Shikimori: лимит 429 не отпустил, запрос отменён: ${req.path}`, {
            domain,
            attempts: attempt + 1,
          })
          throw new RateLimitError('Shikimori', req.path)
        }

        Logger(
          'WARN',
          `Shikimori 429 (${domain}): пауза ${RATE_PAUSE_MS}мс, ` +
            `повтор ${attempt + 2}/${MAX_RATE_RETRIES} — ${req.path}`,
        )
        // Повтор пойдёт через шлюз и сам дождётся конца паузы.
        return await askMirrors<T>(req, read, attempt + 1)
      }

      // 404 — возможно удалён по РКН, пробуем следующее зеркало. Предпочтённым оно не становится.
      if (r.status === 404) {
        lastNotFound = { data: null, domain }
        continue
      }

      if (r.status !== 200) {
        throw new Error(`Shikimori HTTP ${r.status}`)
      }

      const data = read(r.text)

      // Отметка ставится после разбора тела: битое тело — беда ответа, а не адреса.
      if (preferredDomain !== domain) {
        preferredDomain = domain
        // Запись на диск не ждём: данные уже есть, а подсказка догонит сама.
        void rememberPreferred(domain)
        Logger('API', `Shikimori: рабочее зеркало — ${domain}`)
      }

      return { data, domain }
    } catch (e) {
      // Исчерпание повторов по 429 — не сбой зеркала: бюджет у них общий.
      if (e instanceof RateLimitError) throw e

      // Сеть, таймаут, неизвестный код или битый JSON — следующее зеркало ещё может ответить.
      mirrorFailures++

      // Отметка снимается сразу и с диска: иначе каждый запуск начинал бы с мёртвого адреса.
      if (preferredDomain === domain) {
        preferredDomain = null
        void rememberPreferred('')
        Logger('WARN', `Shikimori: зеркало ${domain} больше не предпочтительное`)
      }

      // reportError учитывает только транспорт и таймаут; ответ со статусом уже учтён выше.
      reportError(netId(domain), `Shikimori (${domain})`, e, Date.now() - startedAt)
      Logger('WARN', `Shikimori: зеркало ${domain} не ответило по ${req.path}`, e)
    }
  }

  if (lastNotFound) {
    // Для вызывающего это штатный исход, но в логе он должен быть виден: перевод не появится.
    Logger('WARN', `Shikimori: данных нет ни на одном зеркале (404): ${req.path}`)
    return lastNotFound
  }

  Logger('ERROR', `Все зеркала Shikimori недоступны для ${req.path}`, { mirrorFailures })
  throw new Error(`Все зеркала Shikimori недоступны для ${req.path}`)
}

/**
 * GET к Shikimori REST с перебором зеркал и повтором при 429. @param path — `/api/animes/123`
 * без домена; @param attempt — номер попытки после 429, служебный параметр рекурсии.
 */
export async function fetchShiki<T = unknown>(
  path: string,
  attempt = 0,
): Promise<ShikiResponse<T>> {
  return await askMirrors<T>({ method: 'GET', path }, (text) => JSON.parse(text) as T, attempt)
}

/**
 * POST в Shikimori GraphQL с тем же перебором зеркал и темпом: негодный ответ — пустой `data`,
 * GraphQL почти всегда отвечает 200. @param note — приписка для журнала.
 */
export async function fetchShikiGraphql<T = unknown>(
  query: string,
  variables: Record<string, unknown>,
  note?: string,
): Promise<ShikiResponse<T>> {
  return await askMirrors<T>(
    {
      method: 'POST',
      path: '/api/graphql',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables }),
      timeoutMs: GRAPHQL_TIMEOUT_MS,
      note,
    },
    (text) => {
      const reply = JSON.parse(text) as GraphqlReply<T>
      if (reply.data === undefined || reply.data === null) {
        throw new Error('Shikimori GraphQL: ответ без данных')
      }
      return reply.data
    },
    0,
  )
}

/** Проба одного зеркала: мимо askMirrors намеренно — пробе нельзя подменять ответ чужим адресом. */
async function probeMirror(domain: string): Promise<void> {
  const startedAt = Date.now()
  const label = `Shikimori (${domain})`

  try {
    await shikiLimiter.acquireSlot()

    const r = await Bridge.http.request({
      method: 'GET',
      url: mirrorUrl(domain, PROBE_PATH),
      timeoutMs: MIRROR_TIMEOUT_MS,
      credentials: 'omit',
    })

    reportStatus(netId(domain), label, r.status, Date.now() - startedAt)
  } catch (e) {
    // Отчёт — весь смысл пробы, наружу исключение не отдаём.
    reportError(netId(domain), label, e, Date.now() - startedAt)
  }
}

// Регистрация при загрузке модуля: экраны зеркалам сами не звонят.
for (const domain of SHIKI_DOMAINS) {
  registerProbe(netId(domain), `Shikimori (${domain})`, () => probeMirror(domain))
}
