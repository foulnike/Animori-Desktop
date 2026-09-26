// Расписание выхода серий своего списка: отдельный запрос через `airingSchedules` — облик тайтла
// знает только ближайшую серию, календарю нужна неделя.
import { Logger } from '../utils/logger'

import { anilistQuery } from './anilist'

/** Потолок страницы у AniList. */
const PAGE_SIZE = 50

/** Сколько страниц терпим; четвёртая — защита от бесконечного круга на чужой ошибке в pageInfo. */
const PAGE_LIMIT = 4

/** Предохранитель от чужой ошибки в `pageInfo`; сколько тайтлов брать, решает вызывающий. */
const POPULAR_PAGE_LIMIT = 4

const SCHEDULE_QUERY = `query Week($from: Int, $to: Int, $ids: [Int], $page: Int) {
  Page(page: $page, perPage: ${PAGE_SIZE}) {
    pageInfo {
      hasNextPage
    }
    airingSchedules(
      airingAt_greater: $from
      airingAt_lesser: $to
      mediaId_in: $ids
      sort: TIME
    ) {
      airingAt
      episode
      mediaId
      media {
        isAdult
        title {
          romaji
          english
        }
      }
    }
  }
}`

const ONGOING_QUERY = `query Ongoing($page: Int) {
  Page(page: $page, perPage: ${PAGE_SIZE}) {
    pageInfo {
      hasNextPage
    }
    media(status: RELEASING, sort: POPULARITY_DESC, type: ANIME) {
      id
    }
  }
}`

/** Один выход: серия одного тайтла в назначенный срок. */
export interface AiringEntry {
  mediaId: number
  episode: number
  /** Срок выхода в секундах, как его отдаёт AniList и держит облик тайтла. */
  airingAt: number
  /** Название сервера: запасное к русскому имени, а для чужого тайтла — единственное. */
  romaji: string | null
  english: string | null
  /** Метка 18+: расписание спрашивается по номерам, облика у чужого тайтла нет. */
  isAdult: boolean
}

interface ScheduleAnswer {
  Page?: {
    pageInfo?: { hasNextPage?: boolean | null } | null
    airingSchedules?: Array<{
      airingAt?: number | null
      episode?: number | null
      mediaId?: number | null
      media?: {
        isAdult?: boolean | null
        title?: { romaji?: string | null; english?: string | null } | null
      } | null
    }> | null
  } | null
}

interface OngoingAnswer {
  Page?: {
    pageInfo?: { hasNextPage?: boolean | null } | null
    media?: Array<{ id?: number | null }> | null
  } | null
}

/** Строка, если она непустая: пустая строка названием не считается. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Расписание выхода для перечисленных тайтлов за окно `from`…`to` (секунды, как у AniList); срок нулём приходит
 * у служебных записей — такие пропускаем.
 */
export async function fetchAiringSchedules(
  mediaIds: number[],
  from: number,
  to: number,
): Promise<AiringEntry[]> {
  if (mediaIds.length === 0 || to <= from) return []

  const out: AiringEntry[] = []
  const seen = new Set<string>()

  for (let page = 1; page <= PAGE_LIMIT; page += 1) {
    const answer = await anilistQuery<ScheduleAnswer>(SCHEDULE_QUERY, {
      from,
      to,
      ids: mediaIds,
      page,
    })

    const box = answer.data?.Page
    const rows = box?.airingSchedules ?? []

    for (const row of rows) {
      const mediaId = typeof row.mediaId === 'number' ? row.mediaId : 0
      const airingAt = typeof row.airingAt === 'number' ? row.airingAt : 0
      if (mediaId <= 0 || airingAt <= 0) continue

      // Ключ по тайтлу и сроку: нумерация у повторов и спецвыпусков бывает нулевой и одинаковой.
      const key = `${mediaId}|${airingAt}`
      if (seen.has(key)) continue
      seen.add(key)

      const title = row.media?.title

      out.push({
        mediaId,
        episode: typeof row.episode === 'number' ? row.episode : 0,
        airingAt,
        romaji: text(title?.romaji),
        english: text(title?.english),
        // Неизвестный признак считается безопасным: хуже спрятать половину календаря из-за пустого поля.
        isAdult: row.media?.isAdult === true,
      })
    }

    if (box?.pageInfo?.hasNextPage !== true) break
    if (page === PAGE_LIMIT) {
      Logger('WARN', `Расписание: страниц больше ${PAGE_LIMIT}, остальное не взято`)
    }
  }

  return out
}

/** Номера идущих тайтлов, начиная с самых популярных; нужны глобальному показу календаря: всю
 * неделю окном взять нельзя (см. шапку), а верхушка популярности ложится на все семь дней. */
export async function fetchPopularOngoing(limit: number): Promise<number[]> {
  if (limit <= 0) return []

  const pages = Math.min(Math.ceil(limit / PAGE_SIZE), POPULAR_PAGE_LIMIT)
  const out: number[] = []
  const seen = new Set<number>()

  for (let page = 1; page <= pages; page += 1) {
    const answer = await anilistQuery<OngoingAnswer>(ONGOING_QUERY, { page })
    const box = answer.data?.Page
    const rows = box?.media ?? []

    for (const row of rows) {
      const id = typeof row.id === 'number' ? row.id : 0
      if (id <= 0 || seen.has(id)) continue

      seen.add(id)
      out.push(id)
      if (out.length >= limit) return out
    }

    if (box?.pageInfo?.hasNextPage !== true) break
  }

  return out
}
