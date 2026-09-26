// Даты просмотров из журнала изменений Shikimori: в закладках (anime_rates) дат нет вовсе.
// Поля target_type нет — тип берётся из target.url; глубокие страницы дают 200 и пустой массив.

import { Logger } from '../utils/logger'
import { shikiUserGet } from './shikimori-user'

/** Записей за страницу. Сервер отдаёт на одну больше — см. шапку файла. */
const PAGE_SIZE = 100

/** Потолок страниц: страж от журнала, который сервер вздумает отдавать вечно. */
const MAX_PAGES = 60

/** Пауза между страницами: журнал читается потоком, а не по кнопке. */
const PAGE_PAUSE_MS = 300

/** Сколько раз переждать 429 на одной странице, прежде чем сдаться. */
const RATE_RETRIES = 3

/** Пауза при 429: сервер сам просит подождать. */
const RATE_PAUSE_MS = 2000

/** Подписи, которыми кончают тайтл целиком; сравнение по началу строки: «Просмотрено и оценено на 7» — тоже конец. */
const END_WORDS = ['просмотрено', 'прочитано', 'пересмотрено', 'перечитано']

/**
 * Основы глаголов просмотра; список шире нужного нарочно — подписи сервер меняет без спроса. Существительных
 * («эпизод», «глава») нет: по ним за просмотр сходил бы «Сброшено число эпизодов».
 */
const WATCH_WORDS = [
  'смотр', // Смотрю, Просмотрено, Просмотрен 7-й эпизод
  'сматр', // Пересматриваю
  'прочит', // Прочитано, Прочитана 3-я глава
  'читаю', // Читаю
]

/** Дата просмотра одной цели. */
export interface HistoryDates {
  /** Самое раннее событие-просмотр, миллисекунды. null — просмотров не было. */
  start: number | null
  /** Самое позднее событие-завершение, миллисекунды. null — не завершали. */
  end: number | null
}

/** Итог чтения журнала: карта дат и то, чем обход кончился. */
export interface HistoryRead {
  /** Ключ — `anime:57334` или `manga:20`. Даты есть только у тронутых целей. */
  dates: Map<string, HistoryDates>
  /** Сколько записей журнала разобрано. */
  rows: number
  /** Сколько страниц прочитано. */
  pages: number
  /** Обход упёрся в потолок: часть журнала осталась непрочитанной. */
  truncated: boolean
}

/** Запись журнала в том виде, в каком её отдаёт сервер. */
interface HistoryReply {
  id?: number
  created_at?: string
  description?: string
  target?: {
    id?: number
    url?: string | null
  } | null
}

/** Разметку из подписи долой: «оценено на <b>7</b>» иначе не сравнить. */
function plain(description: string): string {
  return description
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Что это было: подпись может не говорить о просмотре вовсе — тогда запись пропускается. «Просмотрено» без числа —
 * тайтл закрыт целиком; «Просмотрено 7 эпизодов» — не завершение.
 */
function kindOf(description: string): 'start' | 'end' | null {
  const text = plain(description)
  if (text === '') return null

  const named = text.includes('эпизод') || text.includes('глав')
  if (!named && END_WORDS.some((word) => text.startsWith(word))) return 'end'

  return WATCH_WORDS.some((word) => text.includes(word)) ? 'start' : null
}

/** Тип цели по адресу карточки: `target_type` в ответе нет (см. шапку файла). */
function kindOfTarget(url: unknown): 'anime' | 'manga' | null {
  if (typeof url !== 'string') return null
  if (url.startsWith('/animes/')) return 'anime'
  if (url.startsWith('/mangas/')) return 'manga'

  return null
}

/** Миллисекунды из даты сервера. Нечитаемая дата даёт 0, а не «сейчас». */
function stampOf(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0

  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

/** Пауза. Отдельной функцией: её зовут из двух мест и по разным поводам. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Читает журнал и собирает даты начала и конца просмотра: начало — раннее событие, конец — позднее
 * завершение. Неудача возвращает то, что успели прочитать; @param userId — номер (ник меняется).
 */
export async function fetchShikiHistoryDates(
  userId: number,
  onPage?: (page: number) => void,
): Promise<HistoryRead> {
  const bounds = new Map<string, { start: number; end: number }>()
  const seen = new Set<number>()

  let rows = 0
  let pages = 0
  let truncated = true

  for (let page = 1; page <= MAX_PAGES; page++) {
    let reply: Awaited<ReturnType<typeof shikiUserGet<HistoryReply[]>>> | null = null

    for (let attempt = 0; attempt <= RATE_RETRIES; attempt++) {
      reply = await shikiUserGet<HistoryReply[]>(
        `/api/users/${userId}/history?limit=${PAGE_SIZE}&page=${page}`,
      )

      if (reply.status !== 429) break

      // Повтор без счётчика зациклился бы навсегда: сервер вправе держать паузу сколько угодно.
      Logger('WARN', `Шикимори: журнал, страница ${page} — 429, попытка ${attempt + 1}`)
      await sleep(RATE_PAUSE_MS)
    }

    if (reply === null) break

    if (reply.status === 403 || reply.status === 401) {
      Logger('WARN', 'Шикимори: журнал изменений закрыт для анонимного чтения')
      break
    }

    // Отказ значит «дальше не пойдём»: прочитанное остаётся, перенос продолжается.
    if (!reply.ok) {
      Logger('WARN', `Шикимори: журнал, страница ${page} — отказ ${reply.status}`)
      break
    }

    const chunk = reply.data
    if (!Array.isArray(chunk) || chunk.length === 0) {
      truncated = false
      break
    }

    let fresh = 0

    for (const row of chunk) {
      const id = typeof row.id === 'number' ? row.id : 0
      if (id !== 0) {
        if (seen.has(id)) continue
        seen.add(id)
      }

      fresh++
      rows++

      const target = row.target
      if (target === null || target === undefined) continue

      const kind = kindOfTarget(target.url)
      const malId = typeof target.id === 'number' ? target.id : 0
      if (kind === null || malId <= 0) continue

      const what = kindOf(row.description ?? '')
      if (what === null) continue

      const at = stampOf(row.created_at)
      if (at === 0) continue

      const key = `${kind}:${malId}`
      const bound = bounds.get(key)

      if (bound === undefined) {
        bounds.set(key, { start: what === 'start' ? at : 0, end: what === 'end' ? at : 0 })
        continue
      }

      if (what === 'start') bound.start = bound.start === 0 ? at : Math.min(bound.start, at)
      else bound.end = Math.max(bound.end, at)
    }

    pages = page

    // Страница целиком из уже виденного: обход вернулся на круг (перекрытие страниц).
    if (fresh === 0) {
      truncated = false
      break
    }

    // Неполная страница — последняя: лишний запрос за пустотой ни к чему.
    if (chunk.length < PAGE_SIZE) {
      truncated = false
      break
    }

    onPage?.(page)
    await sleep(PAGE_PAUSE_MS)
  }

  const dates = new Map<string, HistoryDates>()
  for (const [key, bound] of bounds) {
    dates.set(key, {
      start: bound.start === 0 ? null : bound.start,
      end: bound.end === 0 ? null : bound.end,
    })
  }

  Logger(
    'API',
    `Шикимори: журнал прочитан — записей ${rows}, страниц ${pages}, ` +
      `целей с датами ${dates.size}${truncated ? ' (обход упёрся в потолок)' : ''}`,
  )

  return { dates, rows, pages, truncated }
}
