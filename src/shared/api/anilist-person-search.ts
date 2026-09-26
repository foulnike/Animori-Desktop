// Поиск человека на AniList по имени (карточка по номеру — anilist-person.ts). Нужен ссылкам на
// людей из описаний: номера Шикимори никто не знает, мост — имя.

import { Logger } from '../utils/logger'
import { scoreNameMatch, type NameTarget } from '../utils/name-match'
import { anilistQuery } from './anilist'
import type { PersonRef } from './anilist-people'

/** Сколько кандидатов просим: похожих имён редко больше двух-трёх. */
const SEARCH_LIMIT = 6

/** Порог совпадения: тот же, что у поиска по имени во всём каталоге. */
const SEARCH_SCORE = 80

const CHARACTER_SEARCH_QUERY = `query ($search: String!, $limit: Int!) {
  Page(perPage: $limit) {
    characters(search: $search) {
      id
      siteUrl
      name {
        full
        native
      }
      image {
        large
        medium
      }
    }
  }
}`

const STAFF_SEARCH_QUERY = `query ($search: String!, $limit: Int!) {
  Page(perPage: $limit) {
    staff(search: $search) {
      id
      siteUrl
      name {
        full
        native
      }
      image {
        large
        medium
      }
    }
  }
}`

interface PersonReply {
  id?: number
  siteUrl?: string | null
  name?: { full?: string | null; native?: string | null } | null
  image?: { large?: string | null; medium?: string | null } | null
}

interface SearchReply {
  Page?: {
    characters?: Array<PersonReply | null> | null
    staff?: Array<PersonReply | null> | null
  } | null
}

/** Имена, с которыми идём искать. Оба могут быть пусты: тогда искать нечего. */
export interface PersonNameAsk {
  /** Латинское имя — главный запрос. */
  name: string | null
  /** Японское имя — второй заход и главный признак совпадения. */
  native: string | null
}

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Человек из ответа. Безымянный не годится: его нечем сверить с искомым. */
function readPerson(raw: PersonReply | null | undefined): PersonRef | null {
  if (!raw || typeof raw.id !== 'number') return null

  const name = textOrNull(raw.name?.full)
  if (name === null) return null

  return {
    personId: raw.id,
    name,
    native: textOrNull(raw.name?.native),
    image: textOrNull(raw.image?.large) ?? textOrNull(raw.image?.medium),
    siteUrl: textOrNull(raw.siteUrl),
  }
}

/** Один заход поиска. Отказ сети не беда: второе имя ещё может сработать. */
async function askAniList(kind: 'character' | 'staff', search: string): Promise<PersonRef[]> {
  const query = kind === 'character' ? CHARACTER_SEARCH_QUERY : STAFF_SEARCH_QUERY

  try {
    const reply = await anilistQuery<SearchReply>(query, { search, limit: SEARCH_LIMIT })
    const list = kind === 'character' ? reply.data?.Page?.characters : reply.data?.Page?.staff

    const found: PersonRef[] = []
    for (const raw of list ?? []) {
      const person = readPerson(raw)
      if (person !== null) found.push(person)
    }
    return found
  } catch (e) {
    Logger('WARN', `AniList: поиск человека не удался (${search})`, e)
    return []
  }
}

/** Лучший кандидат или `null`; скоринг симметричен: латиница с латиницей, кандзи с кандзи. */
function pickBest(list: PersonRef[], target: NameTarget): PersonRef | null {
  let best: PersonRef | null = null
  let bestScore = 0

  for (const cand of list) {
    const score = scoreNameMatch({ name: cand.name, japanese: cand.native }, target)
    if (score > bestScore) {
      bestScore = score
      best = cand
    }
  }

  return bestScore >= SEARCH_SCORE ? best : null
}

/** Ищет человека на AniList по именам с Шикимори. @param kind Кем он у нас откроется: персонажем
 * или автором. @param ask Латинское и японское имя; первое спрашивается раньше. */
export async function findAniListPerson(
  kind: 'character' | 'staff',
  ask: PersonNameAsk,
): Promise<PersonRef | null> {
  const target: NameTarget = { full: ask.name, native: ask.native }

  const tries: string[] = []
  for (const raw of [ask.name, ask.native]) {
    const clean = textOrNull(raw)
    if (clean !== null && !tries.includes(clean)) tries.push(clean)
  }
  if (tries.length === 0) return null

  for (const search of tries) {
    const found = pickBest(await askAniList(kind, search), target)
    if (found !== null) {
      Logger('API', `AniList: человек найден по имени «${search}»: ${found.name}`)
      return found
    }
  }

  Logger('WARN', `AniList: человек не найден по имени: ${tries.join(' / ')}`)
  return null
}
