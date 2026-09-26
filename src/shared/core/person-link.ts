// Ссылка на человека из описания: номер Шикимори -> наша карточка человека.
// Пути по возрастанию цены: память сопоставления, склад, сеть (Шикимори → поиск на AniList).

import type { PersonRef } from '../api/anilist-people'
import type { PersonTarget } from '../api/anilist-person'
import { findAniListPerson } from '../api/anilist-person-search'
import { fetchShikiPersonDetails } from '../api/shikimori-people'
import { Logger } from '../utils/logger'
import { CACHE_TIME } from './constants'
import { dbGet, dbSet } from './db'
import { peekPersonByShiki, rememberRussianPerson, type PersonKind } from './person-title'
import type { MediaCacheRecord } from './types'

/** Префиксы ключей на складе; цифра — версия формы записи, ключ обязан быть узнаваем. */
const KEY_PREFIX: Record<PersonKind, string> = { character: 'SHPC1_', staff: 'SHPS1_' }

/** Знание этого запуска: номер Шикимори -> готовая цель показа. */
const memory = new Map<string, PersonTarget>()

/** Незавершённые разрешения: двойное нажатие ждёт один ответ. */
const pending = new Map<string, Promise<PersonTarget | null>>()

function memoryKey(who: PersonKind, shikiId: number): string {
  return `${who}:${shikiId}`
}

function cacheKey(who: PersonKind, shikiId: number): string {
  return `${KEY_PREFIX[who]}${shikiId}`
}

/** Цель показа из человека AniList. */
function toTarget(who: PersonKind, person: PersonRef): PersonTarget {
  return { kind: who, ...person }
}

/** Читает соответствие со склада. Битая и протухшая запись — как отсутствующая. */
async function readCache(who: PersonKind, shikiId: number): Promise<PersonTarget | null> {
  const record = await dbGet<MediaCacheRecord<PersonTarget>>('mediaCache', cacheKey(who, shikiId))
  if (!record || typeof record.ts !== 'number') return null
  if (Date.now() - record.ts > CACHE_TIME) return null

  const data = record.data
  if (!data || typeof data.personId !== 'number' || data.personId <= 0) return null
  if (typeof data.name !== 'string' || data.name === '') return null

  return { ...data, kind: who }
}

/** Кладёт соответствие на склад: номера сторон не меняются никогда. */
async function writeCache(who: PersonKind, shikiId: number, data: PersonTarget): Promise<void> {
  await dbSet('mediaCache', { key: cacheKey(who, shikiId), data, ts: Date.now() })
}

/** Два шага по сети: детали у Шикимори дают имена, по ним ищется человек на AniList. */
async function resolveOverNet(who: PersonKind, shikiId: number): Promise<PersonTarget | null> {
  const details = await fetchShikiPersonDetails(
    who === 'character' ? 'characters' : 'people',
    shikiId,
  )
  if (details === null) {
    Logger('WARN', `Ссылка на человека: Шикимори не отдал детали ${shikiId}`)
    return null
  }

  const found = await findAniListPerson(who, { name: details.name, native: details.japanese })
  if (found === null) return null

  const target = toTarget(who, found)
  memory.set(memoryKey(who, shikiId), target)
  await writeCache(who, shikiId, target)

  // Русское имя уже в руках: отдаём складу, чтобы окошко открылось по-русски и не спрашивало дважды.
  if (details.russian) {
    await rememberRussianPerson(who, found, {
      russian: details.russian,
      description: details.description,
      shikiId: details.id,
    })
  }

  Logger('INFO', `Ссылка на человека: ${shikiId} -> ${found.personId} (${found.name})`)
  return target
}

/** Полный путь одного разрешения: память, склад, сеть. */
async function resolveOne(who: PersonKind, shikiId: number): Promise<PersonTarget | null> {
  // Быстрый путь: люди открытого тайтла уже сопоставлены складом карточек.
  const known = peekPersonByShiki(shikiId)
  if (known !== null && known.kind === who) {
    const target = toTarget(who, known.person)
    memory.set(memoryKey(who, shikiId), target)
    return target
  }

  const cached = await readCache(who, shikiId)
  if (cached !== null) {
    memory.set(memoryKey(who, shikiId), cached)
    return cached
  }

  return await resolveOverNet(who, shikiId)
}

/**
 * Карточка человека по номеру Шикимори или `null`. Промахи не запоминаются нарочно:
 * отказ бывает от лежащего зеркала, и одна неудача сделала бы ссылку внешней навсегда.
 */
export async function resolveShikiPerson(
  who: PersonKind,
  shikiId: number,
): Promise<PersonTarget | null> {
  if (!Number.isFinite(shikiId) || shikiId <= 0) return null

  const key = memoryKey(who, shikiId)

  const ready = memory.get(key)
  if (ready) return ready

  const inFlight = pending.get(key)
  if (inFlight) return await inFlight

  const task = resolveOne(who, shikiId).catch((e: unknown) => {
    Logger('WARN', `Ссылка на человека: разрешить ${who} ${shikiId} не вышло`, e)
    return null
  })

  pending.set(key, task)

  try {
    return await task
  } finally {
    pending.delete(key)
  }
}

/** Забывает знание запуска. Склад не трогается: его чистят из настроек. */
export function forgetPersonLinks(): void {
  memory.clear()
  pending.clear()
}
