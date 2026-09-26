// Общий ограничитель темпа к внешним источникам: один на источник (лимит по IP, зеркала делят
// бюджет).

/**
 * Потолок повторов после 429: один покрывает случайное совпадение, дальше уместен отступ, а не череда попыток
 * (три повтора превращали вопрос в четыре запроса — и как раз в момент, когда сервер уже сказал «слишком часто»).
 */
export const MAX_RATE_RETRIES = 1

/**
 * Единый режим темпа: пять в секунду и шестьдесят в минуту — ниже потолков Shikimori (5/сек и 90/мин), запас сознательный.
 */
export const API_MIN_INTERVAL_MS = 300
export const API_WINDOW_MS = 60000
export const API_MAX_PER_WINDOW = 60

/**
 * Начало и предохранитель для AniList: настоящий потолок придёт в заголовках; сейчас сервис деградированные 30,
 * штатные 90 вернутся без наших правок.
 */
export const ANILIST_START_PER_WINDOW = 30
export const ANILIST_MAX_PER_WINDOW = 90

/** Ниже этого потолок не урезается: иначе серия 429 остановила бы работу вовсе. */
export const RATE_FLOOR_PER_WINDOW = 6

/** На сколько закрывается рост потолка после урезания: ответ техработ называет прежний потолок и тут же отвечает 429. */
export const CEILING_RECOVERY_MS = 300000

/** Окно учёта общего залпа. Секунда — то, чем мерят частоту чужие лимиты. */
export const BURST_WINDOW_MS = 1000

/**
 * Сколько запросов ко всем источникам в секунду: 3 на старте (замер: холодный запуск слал 11 и первым ловил отказ
 * нужный), 8 в обычной работе.
 */
export const BURST_START_LIMIT = 3
export const BURST_LIMIT = 8

/** Сколько держится строгий стартовый режим. Считается от загрузки модуля. */
export const STARTUP_WINDOW_MS = 10000

/** Отказ по исчерпанию повторов на 429; отдельный тип, чтобы перебор зеркал не проглотил его своим catch. */
export class RateLimitError extends Error {
  constructor(source: string, target: string) {
    // Число отдельно от слова: при MAX_RATE_RETRIES = 1 прежняя строка читалась бы как опечатка.
    super(`${source}: лимит запросов не отпустил, повторов было ${MAX_RATE_RETRIES} (${target})`)
    this.name = 'RateLimitError'
  }
}

/** Незавершённые вопросы по ключу; общий тип Promise<unknown> — вид ответа известен только в once(). */
const inFlight = new Map<string, Promise<unknown>>()

/**
 * Один поход за раз на ключ: второй такой же вопрос получает тот же промис (ключ задаёт вызывающий).
 * Отказ склеивается вместе с успехом — четыре одинаковых отказа это четыре запроса в закрытую дверь; ключ отпускается в любом исходе.
 */
export function once<T>(key: string, task: () => Promise<T>): Promise<T> {
  const running = inFlight.get(key)
  if (running !== undefined) return running as Promise<T>

  let started: Promise<T>
  try {
    started = task()
  } catch (e) {
    // Задача, упавшая до первого ожидания, ключ за собой не запирает.
    return Promise.reject(e)
  }

  // Тип указан явно: без него вывод пошёл бы по кругу через собственный обработчик и получилась неявная any.
  const guarded: Promise<T> = started.finally(() => {
    // Сравнение обязательно: пока мы ждали, в карте мог появиться более свежий поход с тем же ключом.
    if (inFlight.get(key) === guarded) inFlight.delete(key)
  })

  inFlight.set(key, guarded)
  return guarded
}

/** Сколько вопросов сейчас в пути. Только для сводки: в решениях не участвует. */
export function inFlightCount(): number {
  return inFlight.size
}

/**
 * Когда загрузился модуль = когда началась работа программы: события «программа проснулась» у ядра нет.
 */
const bootedAt = Date.now()

/** Отметки стартов по всем источникам вместе за последнюю секунду. */
const burstSends: number[] = []

/** Действующий потолок залпа: стартовый режим строже обычного. */
function burstLimit(now: number): number {
  return now - bootedAt < STARTUP_WINDOW_MS ? BURST_START_LIMIT : BURST_LIMIT
}

/** Убирает отметки, вышедшие за окно учёта залпа. */
function trimBurst(now: number): void {
  while (burstSends.length > 0 && now - (burstSends[0] ?? 0) >= BURST_WINDOW_MS) {
    burstSends.shift()
  }
}

/**
 * Сколько ждать, чтобы не превысить залп; прибавка 10 мс — от дребезга на границе окна.
 */
function burstWait(now: number): number {
  trimBurst(now)

  if (burstSends.length < burstLimit(now)) return 0

  const oldest = burstSends[0] ?? now
  return Math.max(1, BURST_WINDOW_MS - (now - oldest) + 10)
}

/** Отмечает состоявшийся старт в общем учёте залпа. */
function noteBurst(at: number): void {
  burstSends.push(at)
}

/** Сколько запросов ушло за последнюю секунду всем источникам вместе; только для сводки журнала. */
export function globalBurstCount(): number {
  const now = Date.now()
  trimBurst(now)
  return burstSends.length
}

/** Действует ли ещё строгий стартовый режим залпа. Для той же сводки. */
export function inStartupWindow(): boolean {
  return Date.now() - bootedAt < STARTUP_WINDOW_MS
}

export interface RateLimiterOptions {
  /** Имя источника — попадает в текст ошибок. */
  name: string
  /** Минимальный промежуток между стартами двух запросов. */
  minIntervalMs: number
  /** Длина скользящего окна учёта. */
  windowMs: number
  /** Сколько запросов допускается внутри окна до первого ответа сервера. */
  maxPerWindow: number
  /** Предохранитель: выше этого не подниматься, что бы ни сказал сервер. */
  maxCeiling?: number
  /** Считать интервал от потолка, а не брать из minIntervalMs. */
  deriveInterval?: boolean
}

/**
 * Снимок состояния источника для читателя бюджета (экран журнала #/log): сколько потрачено и сколько осталось.
 */
export interface RateLimiterStats {
  /** Имя источника — то же, что в текстах ошибок. */
  name: string
  /** Запросов внутри окна учёта прямо сейчас. */
  inWindow: number
  /** Действующий потолок за окно: меняется по заголовкам и после 429. */
  ceiling: number
  /** Сколько ещё можно отправить до конца окна. */
  remaining: number
  /** Длина окна учёта: без неё остаток нечем истолковать. */
  windowMs: number
  /** Действующий промежуток между стартами двух запросов. */
  intervalMs: number
  /** Осталось до конца паузы; ноль — паузы нет. */
  pauseRemaining: number
  /** Слотов выдано с запуска программы. Это и есть счёт нашего расхода. */
  sentTotal: number
  /** Когда уходил последний запрос. Ноль — ни одного за сессию. */
  lastSentAt: number
  /**
   * Промежуток по остатку окна из заголовков (ноль — сервер молчал): в журнале видна разница с нашим расчётом.
   */
  pacedIntervalMs: number
}

export interface RateLimiter {
  readonly name: string
  /** Ждёт своей очереди на отправку. Возврат = разрешение отправить один запрос. */
  acquireSlot: () => Promise<void>
  /** Ставит источник на паузу (обычно после 429). Паузы не сокращаются, только продлеваются. */
  pause: (ms: number) => void
  /** Активна ли пауза. Очередь перевода спрашивает это перед каждой пачкой. */
  isPaused: () => boolean
  /** Сколько миллисекунд осталось до конца паузы. */
  pauseRemaining: () => number
  /** Потолок по заголовкам: выше предохранителя обрезается, во время восстановления рост игнорируется. */
  applyCeiling: (limit: number) => void
  /** Остаток окна и сброс (Unix-мс): интервал = (сброс − сейчас) / остаток — запросы растягиваются до конца окна. */
  applyRemaining: (remaining: number, resetAt: number) => void
  /** Урезает потолок вдвое после 429 и закрывает его рост на время восстановления. */
  reduceCeiling: () => void
  /** Снимок состояния, только чтение. Читатель — экран журнала (#/log). */
  stats: () => RateLimiterStats
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Перечень созданных ограничителей: запись идёт из мастерской — без перечня сводка журнала показала бы ноль и выглядела правдой.
 */
const allLimiters: RateLimiter[] = []

/** Снимок по всем источникам сразу. Порядок — как создавались. */
export function collectRateStats(): RateLimiterStats[] {
  return allLimiters.map((limiter) => limiter.stats())
}

/** Создаёт независимый ограничитель темпа для одного источника. */
export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { name, minIntervalMs, windowMs, maxPerWindow, maxCeiling, deriveInterval } = options

  /** Выше этого потолок не поднимется даже по словам сервера. */
  const hardMax = Math.max(maxPerWindow, maxCeiling ?? maxPerWindow)

  /** Действующий потолок за окно: меняется по заголовкам и после 429. */
  let ceiling = maxPerWindow
  /** До этого времени потолок не повышается после урезания. */
  let ceilingLockedUntil = 0
  /** Unix-время, до которого запросы к источнику приостановлены. */
  let pausedUntil = 0
  /** Время последней выдачи слота. */
  let lastSentAt = 0
  /** Сколько слотов выдано за всю сессию. Только для сводки, в решениях не участвует. */
  let sentTotal = 0
  /** Промежуток, посчитанный по остатку окна. Ноль — сервер про остаток молчал. */
  let pacedIntervalMs = 0
  /** До какого времени действует промежуток по остатку: дальше окно сбрасывается. */
  let pacedUntil = 0
  /** Отметки выдач за последнее окно. */
  const recentSends: number[] = []
  /** Очередь ожидающих: без шлюза два параллельных вызова займут один слот; ответа не ждём — один медленный застопорит всех. */
  let gate: Promise<void> = Promise.resolve()

  /** Промежуток от потолка: размазывает разрешённое число запросов по окну. */
  function derivedInterval(): number {
    if (!deriveInterval) return minIntervalMs
    return Math.max(minIntervalMs, Math.ceil(windowMs / Math.max(1, ceiling)))
  }

  /**
   * Действующий промежуток: более осторожный из двух расчётов — наш от потолка и по остатку; последний названный
   * напрямую был бы ошибкой: свежее окно с большим остатком разрешило бы идти без промежутка.
   */
  function currentInterval(): number {
    const base = derivedInterval()
    if (pacedIntervalMs > 0 && Date.now() < pacedUntil) return Math.max(base, pacedIntervalMs)
    return base
  }

  /**
   * Сколько отметок в окно попадает: считается заново — чистка идёт только внутри выдачи, а сводка из-за
   * вчерашнего хвоста показывала бы израсходованным уже пустое окно.
   */
  function countInWindow(now: number): number {
    let count = 0
    for (const at of recentSends) {
      if (now - at < windowMs) count++
    }
    return count
  }

  async function acquireSlot(): Promise<void> {
    const previous = gate
    let release: () => void = () => undefined
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous

    try {
      for (;;) {
        const now = Date.now()

        // Чистим отметки, вышедшие за окно.
        while (recentSends.length > 0 && now - (recentSends[0] ?? 0) >= windowMs) {
          recentSends.shift()
        }

        const waits: number[] = []
        const interval = currentInterval()
        const sinceLast = now - lastSentAt
        if (sinceLast < interval) waits.push(interval - sinceLast)
        if (now < pausedUntil) waits.push(pausedUntil - now)
        if (recentSends.length >= ceiling) {
          waits.push(windowMs - (now - (recentSends[0] ?? now)) + 50)
        }

        // Общий залп: свой бюджет может быть свободен, а квартира — уже шумной.
        const burst = burstWait(now)
        if (burst > 0) waits.push(burst)

        if (waits.length === 0) {
          lastSentAt = Date.now()
          recentSends.push(lastSentAt)
          noteBurst(lastSentAt)
          sentTotal++
          return
        }

        await sleep(Math.max(...waits))
      }
    } finally {
      release()
    }
  }

  const limiter: RateLimiter = {
    name,
    acquireSlot,
    pause(ms: number): void {
      pausedUntil = Math.max(pausedUntil, Date.now() + ms)
    },
    isPaused(): boolean {
      return Date.now() < pausedUntil
    },
    pauseRemaining(): number {
      return Math.max(0, pausedUntil - Date.now())
    },
    applyCeiling(limit: number): void {
      if (!Number.isFinite(limit) || limit <= 0) return

      const next = Math.min(Math.floor(limit), hardMax)
      if (next === ceiling) return

      // Снижение принимаем всегда, рост — только когда восстановление закончилось.
      if (next > ceiling && Date.now() < ceilingLockedUntil) return

      ceiling = Math.max(RATE_FLOOR_PER_WINDOW, next)
    },
    applyRemaining(remaining: number, resetAt: number): void {
      if (!Number.isFinite(remaining) || !Number.isFinite(resetAt)) return

      const now = Date.now()
      const span = resetAt - now

      // Сброс назван в прошлом: окно уже новое, и старый расчёт про него врёт.
      if (span <= 0) {
        pacedIntervalMs = 0
        pacedUntil = 0
        return
      }

      // Остаток исчерпан — это пауза, а не темп; делить на нуль нельзя, а на единицу — значит разрешить несуществующий запрос.
      if (remaining <= 0) return

      // Слишком далёкий сброс — разошедшиеся часы; горизонт ограничен двумя окнами учёта.
      const horizon = Math.min(span, windowMs * 2)
      const paced = Math.ceil(horizon / remaining)

      pacedIntervalMs = Math.min(paced, windowMs)
      pacedUntil = now + horizon
    },
    reduceCeiling(): void {
      ceiling = Math.max(RATE_FLOOR_PER_WINDOW, Math.floor(ceiling / 2))
      ceilingLockedUntil = Date.now() + CEILING_RECOVERY_MS
    },
    stats(): RateLimiterStats {
      const now = Date.now()
      const inWindow = countInWindow(now)
      const paced = pacedIntervalMs > 0 && now < pacedUntil ? pacedIntervalMs : 0

      return {
        name,
        inWindow,
        ceiling,
        remaining: Math.max(0, ceiling - inWindow),
        windowMs,
        intervalMs: currentInterval(),
        pauseRemaining: Math.max(0, pausedUntil - now),
        sentTotal,
        lastSentAt,
        pacedIntervalMs: paced,
      }
    },
  }

  allLimiters.push(limiter)

  return limiter
}

/** Общий для shikimori.ts и shikimori-people.ts; shikimori-user.ts идёт мимо — там единичные кнопочные запросы. */
export const shikiLimiter = createRateLimiter({
  name: 'Shikimori',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/** Режим тот же, что у Shikimori: источники стоят в одной цепочке резолва — иначе фоллбэк обгоняет основной. */
export const anime365Limiter = createRateLimiter({
  name: 'anime365',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/** Бюджет отдельный от Shikimori (другой IP-счёт), темп низкий — страховка от всплеска при переборе страниц. */
export const animeThemesLimiter = createRateLimiter({
  name: 'AnimeThemes',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/**
 * Единственный с плавающим потолком и темпом по остатку: только AniList присылает заголовки; интервал от потолка — всплеск ловит 429 даже в лимите.
 */
export const anilistLimiter = createRateLimiter({
  name: 'AniList',
  minIntervalMs: 100,
  windowMs: API_WINDOW_MS,
  maxPerWindow: ANILIST_START_PER_WINDOW,
  maxCeiling: ANILIST_MAX_PER_WINDOW,
  deriveInterval: true,
})

/** Опись и файлы датасета названий: до трёх запросов на запуск; отдельный источник держится ради инварианта 1 — слот берёт каждый вызов. */
export const githubLimiter = createRateLimiter({
  name: 'GitHub',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/** Aniliberty: открытый API без потолка; темп общий из вежливости — открытие плеера стоит двух запросов подряд. */
export const anilibertyLimiter = createRateLimiter({
  name: 'Aniliberty',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})

/** Kodik: серия стоит трёх запросов (поиск, страница, /ftor); свой бюджет — ради соседей, плеер не тормозит перевод имён. */
export const kodikLimiter = createRateLimiter({
  name: 'Kodik',
  minIntervalMs: API_MIN_INTERVAL_MS,
  windowMs: API_WINDOW_MS,
  maxPerWindow: API_MAX_PER_WINDOW,
})
