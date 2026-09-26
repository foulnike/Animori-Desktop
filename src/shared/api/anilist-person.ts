// Карточка персонажа или автора по запросу: открывается из PeopleBox.
import { anilistQuery } from './anilist'
import type { PersonRef } from './anilist-people'
import { Logger } from '@/utils/logger'

/** Тип, переданный из плитки в PeopleBox. */
export type PersonTarget = { kind: 'character' | 'staff' } & PersonRef

const CHARACTER_CARD_QUERY = `
  query ($id: Int!) {
    Character(id: $id) {
      id
      name { full native alternative }
      image { large }
      description(asHtml: false)
      gender
      age
      dateOfBirth { year month day }
      siteUrl
      media(page: 1, perPage: 8, sort: [POPULARITY_DESC]) {
        edges {
          characterRole
          voiceActors(sort: [RELEVANCE, ID]) {
            id
            name { full native }
            language
            image { large medium }
            siteUrl
          }
          node {
            id
            title { romaji english }
            coverImage { medium }
            type
          }
        }
      }
    }
  }
`

const STAFF_CARD_QUERY = `
  query ($id: Int!) {
    Staff(id: $id) {
      id
      name { full native alternative }
      image { large }
      description(asHtml: false)
      primaryOccupations
      languageV2
      dateOfBirth { year month day }
      dateOfDeath { year month day }
      homeTown
      siteUrl
    }
  }
`

export interface CharacterCard {
  id: number
  name: { full: string; native: string | null; alternative: string[] | null }
  image: { large: string | null } | null
  description: string | null
  gender: string | null
  age: string | null
  dateOfBirth: { year: number | null; month: number | null; day: number | null } | null
  siteUrl: string
  media: {
    edges: Array<{
      characterRole: string | null
      voiceActors: Array<{
        id: number
        name: { full: string; native: string | null }
        language: string | null
        image: { large: string | null; medium: string | null } | null
        siteUrl: string
      }>
      node: {
        id: number
        title: { romaji: string | null; english: string | null }
        coverImage: { medium: string | null } | null
        type: string | null
      }
    }>
  } | null
}

export interface StaffCard {
  id: number
  name: { full: string; native: string | null; alternative: string[] | null }
  image: { large: string | null } | null
  description: string | null
  primaryOccupations: string[] | null
  languageV2: string | null
  dateOfBirth: { year: number | null; month: number | null; day: number | null } | null
  dateOfDeath: { year: number | null; month: number | null; day: number | null } | null
  homeTown: string | null
  siteUrl: string
}

/** Исход вопроса о карточке: `none` — «такого нет», `fail` — запрос не доехал. */
export interface PersonAsk<T> {
  state: 'ready' | 'none' | 'fail'
  card: T | null
}

/** Один повтор закрывает почти все обрывы и отказы по темпу. */
const CARD_TRIES = 2

/** Пауза перед повтором: отпускает и короткий обрыв, и всплеск 429. */
const CARD_PAUSE_MS = 900

function nap(ms: number): Promise<void> {
  return new Promise((allow) => setTimeout(allow, ms))
}

/** Вопрос с повтором на сбое: сбой не ответ, правда выяснится через секунду. */
async function askWithRetry<T>(
  tag: string,
  ask: () => Promise<T | null>,
): Promise<PersonAsk<T>> {
  for (let tryNo = 1; ; tryNo += 1) {
    try {
      const card = await ask()
      return { state: card === null ? 'none' : 'ready', card }
    } catch (e) {
      if (tryNo >= CARD_TRIES) {
        Logger('WARN', `${tag}: карточка не доехала`, e)
        return { state: 'fail', card: null }
      }

      Logger('WARN', `${tag}: повторяем`, e)
      await nap(CARD_PAUSE_MS)
    }
  }
}

export async function fetchCharacterCard(id: number): Promise<PersonAsk<CharacterCard>> {
  return await askWithRetry(`Персонаж ${id}`, async () => {
    const reply = await anilistQuery<{ Character: CharacterCard }>(CHARACTER_CARD_QUERY, { id })
    const data = reply?.data?.Character ?? null
    Logger('API', `Персонаж ${id}: ${data?.name.full ?? 'нет данных'}`)
    return data
  })
}

export async function fetchStaffCard(id: number): Promise<PersonAsk<StaffCard>> {
  return await askWithRetry(`Автор ${id}`, async () => {
    const reply = await anilistQuery<{ Staff: StaffCard }>(STAFF_CARD_QUERY, { id })
    const data = reply?.data?.Staff ?? null
    Logger('API', `Автор ${id}: ${data?.name.full ?? 'нет данных'}`)
    return data
  })
}
