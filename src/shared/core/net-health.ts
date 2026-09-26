// Учёт доступности источников: исходы запросов от api/* — интерфейсу и тосту; имён хостов здесь нет.
// Суждение одно (getOutage) и проба одна (runProbes); источник регистрирует короткий запрос через registerProbe.

import { BridgeHttpError } from '@/bridge'
import { Logger } from '../utils/logger'

/** Состояние источника; разница `unreachable` и `forbidden` прикладная: совет про VPN уместен только в первом. */
export type NetState = 'unknown' | 'ok' | 'unreachable' | 'forbidden' | 'serverError'

/** Запись об одном источнике. `label` задаёт сам клиент — он же виден в таблице. */
export interface NetSourceHealth {
  id: string
  label: string
  state: NetState
  /** Когда состояние стало таким. Не обновляется при повторе того же исхода. */
  since: number
  /** Когда источник отвечал в последний раз, в любом смысле. */
  lastSeenAt: number
  /** Сколько неудач подряд. Любой успех обнуляет. */
  failStreak: number
  /** Код последнего ответа, если ответ вообще был. */
  lastStatus?: number
  /** Время последнего запроса в миллисекундах, если вызывающий его замерил. */
  lastLatencyMs?: number
  /** Короткая причина для таблицы: `timeout`, `network`, `HTTP 403` и так далее. */
  lastDetail?: string
}

/** Сколько неудач подряд — повод говорить с человеком: одна ошибка ничего не значит. */
export const FAIL_STREAK_THRESHOLD = 2

/** Окно, в котором недоступность разных источников считается одним событием. */
export const OUTAGE_WINDOW_MS = 60000

/** Сколько разных недоступных источников в окне считается общей бедой. */
export const OUTAGE_SOURCE_THRESHOLD = 2

/** Не чаще этого срока пускаем ручную проверку: человек жмёт кнопку несколько раз подряд. */
export const PROBE_COOLDOWN_MS = 10000

const sources = new Map<string, NetSourceHealth>()

type Listener = (snapshot: NetSourceHealth[]) => void
const listeners = new Set<Listener>()

function ensure(id: string, label: string): NetSourceHealth {
  const existing = sources.get(id)
  if (existing) {
    // Метка может уточниться позже: клиент отчитался раньше проверки сети.
    if (label && existing.label !== label) existing.label = label
    return existing
  }

  const created: NetSourceHealth = {
    id,
    label: label || id,
    state: 'unknown',
    since: Date.now(),
    lastSeenAt: 0,
    failStreak: 0,
  }
  sources.set(id, created)
  return created
}

function notify(): void {
  if (listeners.size === 0) return
  const snapshot = listHealth()
  listeners.forEach((listener) => {
    try {
      listener(snapshot)
    } catch (e) {
      // Один сломанный подписчик не должен ломать учёт и остальных подписчиков.
      Logger('ERROR', 'Подписчик net-health упал', e)
    }
  })
}

/** Применяет исход к записи; в журнал пишется только СМЕНА состояния. */
function apply(
  id: string,
  label: string,
  state: Exclude<NetState, 'unknown'>,
  detail?: string,
  status?: number,
  latencyMs?: number,
): void {
  const record = ensure(id, label)
  const previous = record.state

  record.lastSeenAt = Date.now()
  record.lastDetail = detail
  record.lastStatus = status
  record.lastLatencyMs = latencyMs

  if (state === 'ok') record.failStreak = 0
  else record.failStreak += 1

  if (previous !== state) {
    record.state = state
    record.since = Date.now()

    if (state === 'ok') {
      if (previous !== 'unknown') {
        Logger('INFO', `Сеть: ${record.label} снова отвечает`)
      }
    } else {
      Logger('WARN', `Сеть: ${record.label} — ${describeState(state)}`, {
        detail: detail ?? null,
        status: status ?? null,
      })
    }
  }

  notify()
}

/** Человеческое название состояния. Используется и в журнале, и в таблице проверки. */
export function describeState(state: NetState): string {
  switch (state) {
    case 'ok':
      return 'ответил'
    case 'unreachable':
      return 'не отвечает'
    case 'forbidden':
      return 'отклонил запрос'
    case 'serverError':
      return 'ошибка на стороне сервиса'
    default:
      return 'не проверялся'
  }
}

/**
 * Сообщает об ответе с кодом: 403/451 — `forbidden`, 5xx — `serverError`, 404 — связь есть; 401 и 429 игнорируются.
 */
export function reportStatus(id: string, label: string, status: number, latencyMs?: number): void {
  if (status === 401 || status === 429) return

  if (status === 403 || status === 451) {
    apply(id, label, 'forbidden', `HTTP ${status}`, status, latencyMs)
    return
  }

  if (status >= 500) {
    apply(id, label, 'serverError', `HTTP ${status}`, status, latencyMs)
    return
  }

  apply(id, label, 'ok', `HTTP ${status}`, status, latencyMs)
}

/** Транспортный сбой; `abort` игнорируется — это наше поведение при навигации, а не отказ сети. */
export function reportError(id: string, label: string, error: unknown, latencyMs?: number): void {
  if (error instanceof BridgeHttpError) {
    if (error.kind === 'abort') return
    apply(id, label, 'unreachable', error.kind, undefined, latencyMs)
    return
  }

  // Не ошибка транспорта — значит, ответ был, а сломался разбор. Состояние не трогаем.
}

/** Явный успешный отчёт без кода ответа — для случаев вроде кэша или кадра. */
export function reportOk(id: string, label: string, latencyMs?: number): void {
  apply(id, label, 'ok', undefined, undefined, latencyMs)
}

/** Состояние одного источника или `undefined`, если о нём ещё никто не отчитывался. */
export function getHealth(id: string): NetSourceHealth | undefined {
  const record = sources.get(id)
  return record ? { ...record } : undefined
}

/** Копия всего состояния. Копия, а не ссылки: интерфейс не должен править учёт. */
export function listHealth(): NetSourceHealth[] {
  return Array.from(sources.values(), (record) => ({ ...record }))
}

/** Пора ли говорить про конкретный источник: спрашивает виджет вместо показа пустоты. */
export function isTroubled(id: string): boolean {
  const record = sources.get(id)
  if (!record) return false
  return (
    record.state !== 'ok' &&
    record.state !== 'unknown' &&
    record.failStreak >= FAIL_STREAK_THRESHOLD
  )
}

/** Похоже ли на общую беду: считаются только `unreachable` — разные причины VPN не лечат. */
export function looksLikeOutage(now = Date.now()): boolean {
  let count = 0
  sources.forEach((record) => {
    if (record.state !== 'unreachable') return
    if (record.failStreak < FAIL_STREAK_THRESHOLD) return
    if (now - record.lastSeenAt > OUTAGE_WINDOW_MS) return
    count += 1
  })
  return count >= OUTAGE_SOURCE_THRESHOLD
}

/** Метки источников, из-за которых сработал `looksLikeOutage`. Для текста тоста. */
export function troubledLabels(now = Date.now()): string[] {
  const labels: string[] = []
  sources.forEach((record) => {
    if (record.state === 'ok' || record.state === 'unknown') return
    if (record.failStreak < FAIL_STREAK_THRESHOLD) return
    if (now - record.lastSeenAt > OUTAGE_WINDOW_MS) return
    labels.push(record.label)
  })
  return labels
}

/** Причина беды; разделение ради совета: при `blocked` туннель скорее навредит, при `service` ждать сервису. */
export type NetOutageReason = 'none' | 'network' | 'blocked' | 'service'

/** Единое суждение об аварии: один ответ на вопрос, который задают все экраны. */
export interface NetOutage {
  /** Есть ли о чём говорить с человеком прямо сейчас. */
  active: boolean
  /** Почему так решено. */
  reason: NetOutageReason
  /** Метки пострадавших источников — готовый текст для тоста. */
  labels: string[]
  /** Когда началось: самая ранняя смена состояния среди пострадавших. */
  since: number
}

/** Правило простое намеренно: массовая недоступность — сеть, отказ впустить — блокировка; сеть побеждает. */
export function getOutage(now = Date.now()): NetOutage {
  const labels: string[] = []
  let since = 0
  let unreachable = 0
  let forbidden = 0
  let serverError = 0

  sources.forEach((record) => {
    if (record.state === 'ok' || record.state === 'unknown') return
    if (record.failStreak < FAIL_STREAK_THRESHOLD) return
    if (now - record.lastSeenAt > OUTAGE_WINDOW_MS) return

    labels.push(record.label)
    since = since === 0 ? record.since : Math.min(since, record.since)

    if (record.state === 'unreachable') unreachable += 1
    else if (record.state === 'forbidden') forbidden += 1
    else serverError += 1
  })

  if (labels.length === 0) return { active: false, reason: 'none', labels: [], since: 0 }

  let reason: NetOutageReason = 'service'
  if (unreachable >= OUTAGE_SOURCE_THRESHOLD) reason = 'network'
  else if (unreachable > 0) reason = 'network'
  else if (forbidden > 0 && serverError === 0) reason = 'blocked'

  return { active: true, reason, labels, since }
}

/** Проба источника: короткий запрос, отчитывающийся через reportStatus/reportError; итог читается из учёта. */
export type NetProbe = () => Promise<void>

interface ProbeEntry {
  label: string
  run: NetProbe
}

const probes = new Map<string, ProbeEntry>()

/** Текущий прогон, если он идёт. Второй запрос получает тот же промис. */
let probeRun: Promise<NetSourceHealth[]> | null = null

/** Когда закончился прошлый прогон: от него считается пауза между проверками. */
let lastProbeAt = 0

/**
 * Регистрирует пробу (зовёт api/*, не экран) и возвращает функцию отказа — временная проба убирает себя сама.
 */
export function registerProbe(id: string, label: string, run: NetProbe): () => void {
  probes.set(id, { label, run })
  // Источник должен появиться в таблице до первой проверки: строка «не проверялся»
  // честнее, чем пустое место, из которого не видно, кого мы вообще опрашиваем.
  ensure(id, label)
  notify()

  return () => {
    if (probes.get(id)?.run === run) probes.delete(id)
  }
}

/** Идёт ли сейчас прогон проб. Кнопка «Проверить сейчас» смотрит сюда. */
export function isProbing(): boolean {
  return probeRun !== null
}

/** Сколько осталось до следующей разрешённой проверки. Ноль — можно проверять. */
export function probeCooldownRemaining(now = Date.now()): number {
  return Math.max(0, PROBE_COOLDOWN_MS - (now - lastProbeAt))
}

/**
 * Прогоняет пробы; повторный вызов получает тот же промис, частый — текущее состояние без запросов.
 */
export function runProbes(ids?: readonly string[]): Promise<NetSourceHealth[]> {
  if (probeRun) return probeRun

  const now = Date.now()
  if (lastProbeAt !== 0 && now - lastProbeAt < PROBE_COOLDOWN_MS) {
    return Promise.resolve(listHealth())
  }

  const chosen = Array.from(probes.entries()).filter(([id]) => !ids || ids.includes(id))
  if (chosen.length === 0) return Promise.resolve(listHealth())

  Logger('INFO', `Сеть: проверка источников (${chosen.length})`)
  // Сообщаем подписчикам о начале: интерфейсу нужно показать, что идёт проверка.
  notify()

  probeRun = Promise.all(
    chosen.map(async ([, entry]) => {
      try {
        await entry.run()
      } catch (e) {
        // Отказ пробы — это её отчёт, а не наша ошибка: состояние уже записано
        // самим клиентом. Здесь остаётся только не уронить остальные пробы.
        Logger('WARN', `Сеть: проба «${entry.label}» не удалась`, e)
      }
    }),
  )
    .then(() => listHealth())
    .finally(() => {
      probeRun = null
      lastProbeAt = Date.now()
      notify()
    })

  return probeRun
}

/** Подписка на изменения; возвращённый отказ обязан быть вызван в registerShutdownTask. */
export function subscribeNetHealth(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
