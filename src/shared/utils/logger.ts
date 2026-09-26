// Ядро журнала: запись, кольцевой буфер в памяти и глобальные перехватчики ошибок.
// UI сюда не входит — связь через registerLogSink(); буфер один на все виды, ERROR вытесняется последним.

import { settings } from '@/core/settings'

export type LogType = 'INFO' | 'WARN' | 'ERROR' | 'DB' | 'API'

export interface LogEntry {
  id: number
  time: string
  /** URL-контекст (window.location.pathname на момент записи). */
  path: string
  type: LogType | string
  message: string
  details: unknown
  stack: string
}

/** Сколько записей всего живёт в памяти: буфер один на все виды записей. */
export const LOG_CAPACITY = 500

/** Сколько последних записей переживает переход между страницами (квота sessionStorage). */
const SESSION_KEEP = 200

/** Пауза между записями в sessionStorage. */
const FLUSH_DELAY_MS = 1000

export let scriptLogs: LogEntry[] = []

let flushTimer: ReturnType<typeof setTimeout> | null = null
let flushHooksInstalled = false

/**
 * Освобождает место под новую запись, если буфер полон.
 * Вытесняется самая старая запись не-ERROR; в буфере из одних ошибок — самая старая из них.
 */
function makeRoom(): void {
  while (scriptLogs.length >= LOG_CAPACITY) {
    const victim = scriptLogs.findIndex((x) => x.type !== 'ERROR')
    scriptLogs.splice(victim >= 0 ? victim : 0, 1)
  }
}

/** Сбрасывает хвост логов в sessionStorage прямо сейчас. */
function flushSessionLogs(): void {
  if (flushTimer) {
    clearTimeout(flushTimer)
    flushTimer = null
  }
  try {
    sessionStorage.setItem('animori_logs', JSON.stringify(scriptLogs.slice(-SESSION_KEEP)))
  } catch {
    /* квота исчерпана — игнор */
  }
}

/**
 * Планирует запись; повторные вызовы в пределах окна ничего не стоят.
 * При уходе со страницы хвост дописывается принудительно: иначе терялись бы последние секунды лога.
 */
function scheduleSessionFlush(): void {
  if (!flushHooksInstalled) {
    flushHooksInstalled = true
    window.addEventListener('pagehide', flushSessionLogs)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flushSessionLogs()
    })
  }
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushSessionLogs()
  }, FLUSH_DELAY_MS)
}

/**
 * Восстановление логов из sessionStorage после загрузки настроек и только при включённом логгере.
 * Хвост обрезается по SESSION_KEEP: в хранилище могут лежать записи прежней версии с другими лимитами.
 */
function restoreSessionLogs(): void {
  try {
    const savedLogs = sessionStorage.getItem('animori_logs')
    if (savedLogs) {
      const parsed = JSON.parse(savedLogs) as LogEntry[]
      scriptLogs = parsed.slice(-LOG_CAPACITY)
    }
  } catch (e) {
    // Logger может быть не готов — прямой console.warn.
    console.warn('[AniMori] Не удалось восстановить логи сессии', e)
  }
}

/**
 * Подписчик показа: получает каждую новую запись, пока открыт.
 * Один на всех — читателей журнала больше одного не бывает.
 */
let logSink: ((entry: LogEntry) => void) | null = null

export function registerLogSink(sink: ((entry: LogEntry) => void) | null): void {
  logSink = sink
}

/** Что уже накопилось: читателю нужен не только поток, но и предыстория. */
export function readLogs(): ReadonlyArray<LogEntry> {
  return scriptLogs
}

/** Забывает записи этого запуска вместе с их копией в памяти вкладки. */
export function clearLogs(): void {
  scriptLogs = []

  try {
    sessionStorage.removeItem('animori_logs')
  } catch {
    /* памяти вкладки может не быть — записи и так уже забыты */
  }
}

export function Logger(type: LogType | string, message: string, details: unknown = null): void {
  if (
    (globalThis as { __ANIMORI_LOGGER_ENABLED__?: boolean }).__ANIMORI_LOGGER_ENABLED__ === false
  ) {
    return
  }
  if (!settings.enableLogger) return

  let parsedDetails = details
  if (details instanceof Error) {
    parsedDetails = { name: details.name, message: details.message, stack: details.stack }
  }

  const d = new Date()
  const time = `${d.toLocaleTimeString('ru-RU', { hour12: false })}.${String(
    d.getMilliseconds(),
  ).padStart(3, '0')}`
  const path = window.location.pathname
  const stackLines =
    type === 'ERROR' || type === 'WARN' ? (new Error().stack ?? '').split('\n') : []
  const stack = stackLines.length > 2 ? stackLines.slice(2).join('\n') : ''

  const entry: LogEntry = {
    id: Date.now() + Math.random(),
    time,
    path,
    type,
    message,
    details: parsedDetails,
    stack,
  }

  makeRoom()
  scriptLogs.push(entry)

  scheduleSessionFlush()

  if (logSink) logSink(entry)
  if (type === 'ERROR') console.error(`[AniMori ERROR] ${message}`, details || '')
  else if (type === 'WARN') console.warn(`[AniMori WARN] ${message}`, details || '')
}

/**
 * Перехватчики ошибок и восстановление прошлой сессии: ставятся из start() после чтения настроек.
 * До настроек неизвестно, включён ли журнал; оба действия зависят от одного флага.
 */
export function installGlobalErrorHandlers(): void {
  if (!settings.enableLogger) return

  restoreSessionLogs()

  window.addEventListener('error', (e: ErrorEvent) => {
    Logger('ERROR', `Uncaught Error: ${e.message}`, {
      file: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error?.stack,
    })
  })

  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    Logger(
      'ERROR',
      `Unhandled Promise Rejection: ${e.reason}`,
      typeof e.reason === 'object' ? e.reason : { reason: e.reason },
    )
  })
}

/**
 * Вызывает fn (async ок), логируя ошибки в Logger('ERROR').
 * Пример: await safeCall(() => anilistQuery(query, vars, true), 'anilistQuery/Viewer')
 */
export async function safeCall<T>(
  fn: () => T | Promise<T>,
  context: string,
  { silent = false }: { silent?: boolean } = {},
): Promise<T | undefined> {
  try {
    return await fn()
  } catch (e) {
    const msg = e instanceof Error && e.message ? e.message : String(e)
    Logger('ERROR', `Ошибка в ${context}: ${msg}`, e)
    if (!silent) throw e
    return undefined
  }
}
