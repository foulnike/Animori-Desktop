// Выписки тайтлов AniList: по чужим номерам MAL (поиск на кириллице) и по своим (постеры списка).
// Одновременные просьбы уезжают одной пачкой: потолок страницы — пятьдесят тайтлов.

import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'
import { pickEntry, type PartEntry } from '../core/media-parts'
import type { MediaBrief } from './anilist-media'

/** Потолок страницы у AniList — пятьдесят записей за запрос. */
const LOOKUP_PAGE_SIZE = 50

/** Окно копления соседних просьб: полки экрана спрашивают вразброс по ближайшим тикам. */
const MERGE_WINDOW_MS = 50

/** Потолок копления: четыре полные страницы; большой список и так едет многими пачками. */
const MERGE_MAX_IDS = LOOKUP_PAGE_SIZE * 4

/** По какому полю сервер отбирает пачку: чужие номера MAL или свои номера. */
type LookupField = 'idMal_in' | 'id_in'

// Тело запроса одно на два пути: различается только поле отбора.
// Вид вписан словом ANIME: отбор по номерам чужой вид не исключает.
function lookupQuery(field: LookupField): string {
  return `query ($ids: [Int], $perPage: Int!) {
  Page(page: 1, perPage: $perPage) {
    media(${field}: $ids, type: ANIME) {
      id
      idMal
      format
      status
      episodes
      seasonYear
      averageScore
      isAdult
      nextAiringEpisode {
        episode
        airingAt
      }
      title {
        romaji
        english
        native
      }
      coverImage {
        large
        medium
        color
      }
    }
  }
}`
}

/** Ближайшая серия: номер и срок выхода в секундах. */
interface AiringReply {
  episode?: number | null
  airingAt?: number | null
}

interface MediaReply {
  id?: number
  idMal?: number | null
  format?: string | null
  status?: string | null
  episodes?: number | null
  seasonYear?: number | null
  averageScore?: number | null
  isAdult?: boolean | null
  nextAiringEpisode?: AiringReply | null
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null
  coverImage?: { large?: string | null; medium?: string | null; color?: string | null } | null
}

interface LookupReply {
  Page?: {
    media?: Array<MediaReply | null> | null
  } | null
}

/** Кто ждёт пачку: обещание одного вызова выписок. */
interface Waiter {
  resolve: (found: Map<number, MediaBrief>) => void
  reject: (reason: unknown) => void
}

/** Копящаяся пачка по одному полю отбора. */
interface Batch {
  ids: Set<number>
  waiters: Waiter[]
  timer: number
}

/** Незакрытые пачки: по одной на поле отбора; смешивать поля нельзя — числа значат разное. */
const batches = new Map<LookupField, Batch>()

/** Целое положительное или `null`: чужие пустоты в нули превращать нельзя. */
function countOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null
}

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Ответ сервера о одном тайтле в выписку показа: без номера — не запись; вид всегда аниме — сервер спрошен про него. */
function toBrief(item: MediaReply | null): MediaBrief | null {
  if (!item || typeof item.id !== 'number') return null

  return {
    mediaId: item.id,
    malId: countOrNull(item.idMal),
    type: 'ANIME',
    format: textOrNull(item.format),
    status: textOrNull(item.status),
    episodes: countOrNull(item.episodes),
    chapters: null,
    seasonYear: countOrNull(item.seasonYear),
    averageScore: countOrNull(item.averageScore),
    isAdult: item.isAdult === true,
    airingEpisode: countOrNull(item.nextAiringEpisode?.episode),
    airingAt: countOrNull(item.nextAiringEpisode?.airingAt),
    romaji: textOrNull(item.title?.romaji),
    english: textOrNull(item.title?.english),
    native: textOrNull(item.title?.native),
    cover: textOrNull(item.coverImage?.large) ?? textOrNull(item.coverImage?.medium),
    color: textOrNull(item.coverImage?.color),
    // Состояние списка приходит не отсюда: его знает память коллекции.
    ownEntry: null,
  }
}

/** Список без повторов и без мусора: серверу отправлять его и так пачками. */
function cleanIds(ids: number[]): number[] {
  return Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)))
}

/** Выписка в том виде, в каком её видит порядок записей одной части. */
interface PartBrief extends PartEntry {
  brief: MediaBrief
}

/** Выписка для правила выбора; даты начала нет (запрос лёгкий), года хватает — ничью решит номер. */
function toPart(brief: MediaBrief): PartBrief {
  return {
    id: brief.mediaId,
    status: brief.status,
    startDate:
      brief.seasonYear === null ? null : { year: brief.seasonYear, month: null, day: null },
    brief,
  }
}

/** Обход пачками по полю отбора. Запрос без ключа: личного в ответе нет, а подпись тратит личный темп. */
async function lookupBriefs(field: LookupField, wanted: number[]): Promise<MediaBrief[]> {
  const query = lookupQuery(field)
  const found: MediaBrief[] = []

  for (let from = 0; from < wanted.length; from += LOOKUP_PAGE_SIZE) {
    const chunk = wanted.slice(from, from + LOOKUP_PAGE_SIZE)
    const reply = await anilistQuery<LookupReply>(query, {
      ids: chunk,
      perPage: LOOKUP_PAGE_SIZE,
    })

    const media = reply.data?.Page?.media
    if (!Array.isArray(media)) {
      // Пачка потеряна, но соседние могут дойти: обрывать обход незачем.
      Logger('WARN', `Выписки: пустой ответ на пачку из ${chunk.length}`, reply.errors)
      continue
    }

    for (const item of media) {
      const brief = toBrief(item)
      if (brief) found.push(brief)
    }
  }

  return found
}

/**
 * Закрывает копившуюся пачку и раздаёт ответ всем ждущим картой; отказ тоже общий. Одному номеру MAL могут отвечать
 * несколько записей (раздробленная франшиза) — выбирает pickEntry.
 */
async function flushBatch(field: LookupField): Promise<void> {
  const batch = batches.get(field)
  if (!batch) return

  // Снята сразу: просьбы, пришедшие во время запроса, начнут свою пачку.
  batches.delete(field)
  window.clearTimeout(batch.timer)

  const wanted = Array.from(batch.ids)

  try {
    const groups = new Map<number, PartBrief[]>()
    for (const brief of await lookupBriefs(field, wanted)) {
      const key = field === 'idMal_in' ? brief.malId : brief.mediaId
      if (key === null) continue

      const part = toPart(brief)
      const list = groups.get(key)
      if (list) list.push(part)
      else groups.set(key, [part])
    }

    const byKey = new Map<number, MediaBrief>()
    for (const [key, list] of groups) {
      const found = pickEntry(list, null)
      if (found !== null) byKey.set(key, found.brief)
    }

    for (const waiter of batch.waiters) waiter.resolve(byKey)
  } catch (e) {
    for (const waiter of batch.waiters) waiter.reject(e)
  }
}

/** Ставит номера в общую очередь и ждёт общий ответ; повторяющиеся номера уезжают один раз. */
function askLater(field: LookupField, wanted: number[]): Promise<Map<number, MediaBrief>> {
  return new Promise<Map<number, MediaBrief>>((resolve, reject) => {
    let batch = batches.get(field)

    if (!batch) {
      batch = {
        ids: new Set<number>(),
        waiters: [],
        timer: window.setTimeout(() => {
          void flushBatch(field)
        }, MERGE_WINDOW_MS),
      }
      batches.set(field, batch)
    }

    for (const id of wanted) batch.ids.add(id)
    batch.waiters.push({ resolve, reject })

    // Пачка распухла сверх потолка — едет не дожидаясь окна.
    if (batch.ids.size >= MERGE_MAX_IDS) void flushBatch(field)
  })
}

/** Выписки тайтлов по номерам MAL; порядок ответа — порядок спрошенных: сортировка поиска живёт у того, кто искал. */
export async function fetchBriefsByMal(malIds: number[]): Promise<MediaBrief[]> {
  const wanted = cleanIds(malIds)
  if (wanted.length === 0) return []

  const byMal = await askLater('idMal_in', wanted)

  // Порядок собирается по списку спрошенного: так лучшая находка останется сверху.
  const ordered: MediaBrief[] = []
  for (const malId of wanted) {
    const brief = byMal.get(malId)
    if (brief) ordered.push(brief)
  }

  Logger('API', `Выписки по MAL: спросили ${wanted.length}, нашли ${ordered.length}`)
  return ordered
}

/**
 * Выписки по своим номерам AniList — спискам: снимок держит состояние записей, обложки и вид идут
 * пачками. Порядок — по списку спрошенного: пачка общая, сервер сбил бы порядок плиток.
 */
export async function fetchBriefsByIds(mediaIds: number[]): Promise<MediaBrief[]> {
  const wanted = cleanIds(mediaIds)
  if (wanted.length === 0) return []

  const byId = await askLater('id_in', wanted)

  const found: MediaBrief[] = []
  for (const mediaId of wanted) {
    const brief = byId.get(mediaId)
    if (brief) found.push(brief)
  }

  Logger('API', `Выписки по номерам: спросили ${wanted.length}, нашли ${found.length}`)
  return found
}
