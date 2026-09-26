// Главные работы автора: постеры для полки в его карточке.

import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'

/** Сколько работ просить: полка листается, но бесконечной ей быть незачем. */
const WORKS_LIMIT = 14

// Сортировка по популярности («главные» у AniList не выражены); вид вписан словом ANIME:
// карточки манги в приложении нет.
const STAFF_WORKS_QUERY = `query ($id: Int!, $perPage: Int!) {
  Staff(id: $id) {
    staffMedia(sort: [POPULARITY_DESC], type: ANIME, page: 1, perPage: $perPage) {
      edges {
        staffRole
        node {
          id
          isAdult
          seasonYear
          title {
            romaji
            english
          }
          coverImage {
            large
            medium
            color
          }
        }
      }
    }
  }
}`

/** Работа автора для полки постеров. */
export interface StaffWork {
  mediaId: number
  name: string
  /** Должность в этом тайтле как её назвал сервер, или `null`. */
  role: string | null
  year: number | null
  cover: string | null
  color: string | null
  isAdult: boolean
}

interface NodeReply {
  id?: number
  isAdult?: boolean | null
  seasonYear?: number | null
  title?: { romaji?: string | null; english?: string | null } | null
  coverImage?: { large?: string | null; medium?: string | null; color?: string | null } | null
}

interface WorksReply {
  Staff?: {
    staffMedia?: {
      edges?: Array<{ staffRole?: string | null; node?: NodeReply | null } | null> | null
    } | null
  } | null
}

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Целое положительное или `null`: чужие пустоты в нули превращать нельзя. */
function countOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null
}

/** Главные работы автора по его номеру; пустой список — штатный исход. Один тайтл — одна строка: грани склеиваются. */
export async function fetchStaffWorks(personId: number): Promise<StaffWork[]> {
  if (!Number.isFinite(personId) || personId <= 0) return []

  const reply = await anilistQuery<WorksReply>(
    STAFF_WORKS_QUERY,
    { id: personId, perPage: WORKS_LIMIT },
    false,
  )

  const edges = reply.data?.Staff?.staffMedia?.edges
  if (!Array.isArray(edges)) {
    Logger('WARN', `Работы автора ${personId}: пустой ответ`, reply.errors)
    return []
  }

  const byMedia = new Map<number, StaffWork>()

  for (const edge of edges) {
    const node = edge?.node
    if (!node || typeof node.id !== 'number') continue

    const role = textOrNull(edge?.staffRole)
    const seen = byMedia.get(node.id)

    if (seen) {
      // Вторая должность в том же тайтле дописывается к первой, а не заводит строку.
      if (role !== null && seen.role !== null && !seen.role.includes(role)) {
        seen.role = `${seen.role}, ${role}`
      } else if (role !== null && seen.role === null) {
        seen.role = role
      }
      continue
    }

    byMedia.set(node.id, {
      mediaId: node.id,
      name: textOrNull(node.title?.romaji) ?? textOrNull(node.title?.english) ?? `#${node.id}`,
      role,
      year: countOrNull(node.seasonYear),
      cover: textOrNull(node.coverImage?.large) ?? textOrNull(node.coverImage?.medium),
      color: textOrNull(node.coverImage?.color),
      isAdult: node.isAdult === true,
    })
  }

  const works = [...byMedia.values()]
  Logger('API', `Работы автора ${personId}: граней ${edges.length}, тайтлов ${works.length}`)
  return works
}
