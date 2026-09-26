// Клиент anime365 / smotret-anime: русские названия и описания по MAL ID, только аниме.
// Источник нестабилен (403, Cloudflare 520-524): бэкофф, отсрочка зеркал, стоп на сессию.

import { Bridge, BridgeHttpError } from '@/bridge'
import { ANIME365_DOMAINS, ANIME365_FAIL_LIMIT } from '../core/constants'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import { MAX_RATE_RETRIES, anime365Limiter } from './rate-limit'

/** Коды soft-block: источник жив, но временно не отдаёт данные. */
const BLOCKED_STATUSES = [403, 502, 503, 520, 521, 522, 523, 524]

/** Штрафная пауза после 429. */
const RATE_PAUSE_MS = 5000
/** Бэкофф после soft-block. */
const BACKOFF_MS = 15000
/** Таймаут одного зеркала. */
const MIRROR_TIMEOUT_MS = 5000

/** Лёгкая форма ответа; при правке обязаны остаться data[0].titles.ru, .url, .descriptions[].value. */
const SERIES_FIELDS = 'titles,url,descriptions'

/** Сколько раз повторяем запрос к молчащему зеркалу, прежде чем идти к следующему. */
const SILENCE_RETRIES = 1

/** После скольких молчаний подряд адрес откладывается. */
const SILENCE_DEFER_LIMIT = 2

/** На сколько откладывается молчащее зеркало. */
const MIRROR_DEFER_MS = 10 * 60 * 1000

/** Счётчик и флаг приватные: наружу только геттеры, иначе UI сможет сбросить бэкофф. */
let anime365FailStreak = 0
let anime365Disabled = false

/** Молчания подряд по каждому адресу. Любой ответ обнуляет. */
const silenceStreak = new Map<string, number>()

/** До какого времени адрес отложен; только в памяти: доступность — свойство сети сейчас. */
const deferredUntil = new Map<string, number>()

/** Собирает абсолютный адрес для конкретного зеркала. */
function mirrorUrl(domain: string, path: string): string {
  return 'https://' + domain + path
}

/** Имя источника для учёта зеркала; здесь, а не в net-health: тот адресов не знает. */
function netId(domain: string): string {
  return `anime365:${domain}`
}

/** Отключён ли источник до конца сессии (для отображения в настройках). */
export function isAnime365Disabled(): boolean {
  return anime365Disabled
}

/** Активна ли пауза по лимиту или бэкоффу: очередь перевода спрашивает это наравне с Shikimori. */
export function isAnime365RateLimited(): boolean {
  return anime365Limiter.isPaused()
}

/** Текущая серия сбоев подряд. Читателя нет: инспектор журнала удалён. */
export function getAnime365FailStreak(): number {
  return anime365FailStreak
}

/** Отложенные сейчас зеркала. Читателя нет: инспектор журнала удалён. */
export function getAnime365DeferredDomains(): string[] {
  const now = Date.now()
  const list: string[] = []
  deferredUntil.forEach((until, domain) => {
    if (until > now) list.push(domain)
  })
  return list
}

/** Порядок перебора: сначала не отложенные; если отложены все — полный список. */
function pickDomains(): readonly string[] {
  const now = Date.now()
  const live = ANIME365_DOMAINS.filter((domain) => (deferredUntil.get(domain) ?? 0) <= now)
  return live.length > 0 ? live : ANIME365_DOMAINS
}

/** Адрес ответил: снимаем и счётчик молчаний, и отсрочку. */
function noteAnswer(domain: string): void {
  silenceStreak.delete(domain)
  if (deferredUntil.delete(domain)) {
    Logger('INFO', `anime365: зеркало ${domain} снова отвечает, отсрочка снята`)
  }
}

/** Адрес промолчал: копим счётчик и при переполнении откладываем. */
function noteSilence(domain: string): void {
  const streak = (silenceStreak.get(domain) ?? 0) + 1
  silenceStreak.set(domain, streak)

  if (streak < SILENCE_DEFER_LIMIT) return

  silenceStreak.set(domain, 0)
  deferredUntil.set(domain, Date.now() + MIRROR_DEFER_MS)
  Logger(
    'WARN',
    `anime365: зеркало ${domain} молчало ${SILENCE_DEFER_LIMIT} раза подряд — ` +
      `отложено на ${MIRROR_DEFER_MS / 60000} мин.`,
  )
}

/** Молчание, а не отказ: повторять осмысленно. Отмена сюда не входит — она наша собственная. */
function isSilence(e: unknown): boolean {
  return e instanceof BridgeHttpError && (e.kind === 'network' || e.kind === 'timeout')
}

/** Наша отмена при уходе со страницы: ни сбой источника, ни повод для повтора. */
function isAbort(e: unknown): boolean {
  return e instanceof BridgeHttpError && e.kind === 'abort'
}

/** Общая реакция на серию сбоев: бэкофф и, при переполнении счётчика, отключение. */
function registerFailure(): void {
  if (anime365FailStreak < ANIME365_FAIL_LIMIT) return
  anime365Disabled = true
  anime365Limiter.pause(BACKOFF_MS)
  Logger(
    'ERROR',
    'anime365 отключён на эту сессию после серии сбоев — цепочка уходит на фоллбэк/оригинал.',
  )
}

export interface Anime365Title {
  russian: string
  description: string
  url: string
  domain: string
}

interface Anime365Series {
  titles?: { ru?: string }
  descriptions?: Array<{ value?: string }>
  url?: string
}

/** Грузит русский тайтл и описание с anime365 по MAL ID. @param attempt Номер попытки после 429,
 * считая с нуля; служебный параметр рекурсии. */
export async function fetchAnime365ByMal(
  malId: number | null,
  attempt = 0,
): Promise<Anime365Title | null> {
  if (!malId) return null // без номера MAL спрашивать нечего
  if (anime365Disabled) return null // отключён на сессию

  Logger('API', `Запрос к anime365 API: myAnimeListId=${malId}`)

  // Счётчик накручивается один раз в конце: это сбой вызова, а не каждого адреса.
  let callFailed = false

  for (const domain of pickDomains()) {
    for (let tryNo = 0; tryNo <= SILENCE_RETRIES; tryNo++) {
      // Замер на каждую попытку свой и включает ожидание слота.
      const startedAt = Date.now()

      try {
        // Слот берём перед каждой отправкой: ограничитель сам учтёт интервал, окно и паузу.
        await anime365Limiter.acquireSlot()

        const res = await Bridge.http.request({
          method: 'GET',
          url: mirrorUrl(
            domain,
            `/api/series?myAnimeListId=${malId}&limit=1&fields=${SERIES_FIELDS}`,
          ),
          timeoutMs: MIRROR_TIMEOUT_MS,
          credentials: 'omit',
        })

        // Отчёт до разбора кодов, одним вызовом на все ветки: net-health разберёт статус сам.
        reportStatus(netId(domain), `anime365 (${domain})`, res.status, Date.now() - startedAt)

        if (res.status === 429) {
          noteAnswer(domain) // ответ пришёл: адрес жив, дело в темпе
          anime365Limiter.pause(RATE_PAUSE_MS)

          if (attempt + 1 >= MAX_RATE_RETRIES) {
            Logger('ERROR', `anime365: лимит 429 не отпустил, запрос отменён (malId=${malId})`, {
              domain,
              attempts: attempt + 1,
            })
            return null // -> resolveTitle: фоллбэк
          }

          Logger(
            'WARN',
            `anime365 429 (${domain}): пауза ${RATE_PAUSE_MS}мс, ` +
              `повтор ${attempt + 2}/${MAX_RATE_RETRIES} — malId=${malId}`,
          )
          // Повтор сам дождётся конца паузы в acquireSlot() — второго sleep не нужно.
          return fetchAnime365ByMal(malId, attempt + 1)
        }

        // 403/503 + Cloudflare (520-524) — soft-block, а не «нет данных».
        if (BLOCKED_STATUSES.includes(res.status)) {
          noteAnswer(domain) // отказал осознанно, значит на связи
          anime365FailStreak++
          anime365Limiter.pause(BACKOFF_MS)
          Logger(
            'WARN',
            `anime365 недоступен: HTTP ${res.status} (${domain}). ` +
              `Сбой ${anime365FailStreak}/${ANIME365_FAIL_LIMIT}, бэкофф ${BACKOFF_MS}мс.`,
          )
          registerFailure()
          return null // -> resolveTitle: фоллбэк
        }

        noteAnswer(domain)

        // Всё прочее, кроме 200 и 404, уходит в catch этого же зеркала.
        if (res.status !== 200 && res.status !== 404) {
          throw new Error(`anime365 HTTP ${res.status}`)
        }

        anime365FailStreak = 0 // успех или 404 — сброс

        // 404 — источник ответил, данных просто нет.
        if (res.status === 404) {
          Logger('WARN', `anime365: тайтл не найден (404, ${domain}): malId=${malId}`)
          return null
        }

        const body = JSON.parse(res.text) as { data?: Anime365Series[] }
        const item = body.data?.[0]
        if (item) {
          let desc = ''
          if (Array.isArray(item.descriptions)) {
            const d = item.descriptions.find((x) => x && x.value)
            if (d?.value) desc = d.value
          }
          return {
            russian: item.titles?.ru ?? '',
            description: desc,
            url: item.url || mirrorUrl(domain, '/'),
            domain,
          }
        }

        // 200, но пусто: тоже штатный исход, но в журнале он должен быть виден.
        Logger('WARN', `anime365: пустой ответ без данных (${domain}): malId=${malId}`)
        return null
      } catch (e) {
        // Уход со страницы: перебор прекращаем, сбоем не считаем.
        if (isAbort(e)) {
          Logger('WARN', `anime365: запрос отменён (${domain}): malId=${malId}`)
          return null
        }

        // Состояние меняют только транспорт и таймаут; ответ со статусом уже учтён выше.
        reportError(netId(domain), `anime365 (${domain})`, e, Date.now() - startedAt)

        if (isSilence(e)) {
          noteSilence(domain)

          if (tryNo < SILENCE_RETRIES) {
            Logger(
              'WARN',
              `anime365: зеркало ${domain} промолчало (${String(e)}), ` +
                `повторная попытка — malId=${malId}`,
            )
            continue // тот же адрес, новый слот
          }

          Logger(
            'WARN',
            `anime365: зеркало ${domain} молчит после ${SILENCE_RETRIES + 1} попыток ` +
              `(${String(e)}) — malId=${malId}`,
          )
          callFailed = true
          break // следующее зеркало
        }

        // Ответ был, но сломался разбор или пришёл неизвестный код: повторять нечего.
        Logger('WARN', `Сбой запроса к зеркалу anime365: ${domain} (${String(e)})`)
        callFailed = true
        break
      }
    }
  }

  if (callFailed) {
    anime365FailStreak++
    Logger(
      'ERROR',
      `Все зеркала anime365 недоступны для malId=${malId}. ` +
        `Сбой ${anime365FailStreak}/${ANIME365_FAIL_LIMIT}.`,
    )
    registerFailure()
  }

  return null
}
