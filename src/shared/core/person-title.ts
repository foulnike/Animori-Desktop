// Русские имена и описания людей: память, склад, затем сеть — зеркало media-title.ts, ключи от людей.
// Отказ тоже хранится (NOPERSON1_, неделя); рядом обратный указатель «номер Шикимори -> свой человек».

import { LIFE_PEOPLE, LIFE_PERSON_MISS, isFresh } from './cache-life'
import { dbGet, dbSet } from './db'
import type { PersonRef } from '../api/anilist-people'
import {
  fetchShikiPersonDetails,
  fetchShikiPersonREST,
  fetchShikiRoles,
  type PersonCandidate,
} from '../api/shikimori-people'
import { Logger } from '../utils/logger'
import { scoreNameMatch, type NameTarget } from '../utils/name-match'
import type { MediaCacheRecord } from './types'

/** Чем человек является в карточке тайтла: героем или автором. */
export type PersonKind = 'character' | 'staff'

/** Префиксы склада; цифра — версия формы (CHR3/STF4 — описание с разметкой, хранение бессрочное). */
const KEY_PREFIX: Record<PersonKind, string> = { character: 'CHR3_', staff: 'STF4_' }

/** Префикс отказов отдельным ключом: карточки читаются на каждый показ, мешать в них записи без имени нельзя. */
const MISS_PREFIX = 'NOPERSON1_'

/** Готовая русская карточка человека. */
export interface RussianPerson {
  russian: string
  /** Описание с разметкой источника: разбирается при показе. */
  description: string | null
  /** Номер у Шикимори: по нему добирается описание. */
  shikiId?: number
  /** Имя добыто списком ролей: описание ещё не спрашивали. */
  partial?: boolean
}

/** Человек в наших понятиях: вид карточки и опознанный человек AniList. */
export interface KnownPerson {
  kind: PersonKind
  person: PersonRef
}

/** Исход вопроса; `null` сам по себе ничего не значит — отказ разрешает показать ромаджи, недоезд нет. */
export type PersonAskState =
  /** Карточка есть. */
  | 'ready'
  /** Источник спрошен и ответил, что перевода нет. */
  | 'none'
  /** До источника не дошли: обрыв, отказ по темпу, чужая пятисотка. */
  | 'fail'

/** Ответ русского источника о человеке вместе с самим исходом. */
export interface PersonAnswer {
  state: PersonAskState
  person: RussianPerson | null
}

/** Знание этого запуска. `null` значит «спрашивали, перевода нет». */
const memory = new Map<string, RussianPerson | null>()

/** Обратный указатель: номер Шикимори -> кто это у нас; заполняется попутно. */
const byShiki = new Map<number, KnownPerson>()

/** Незавершённые добычи: плитка и окошко часто просят одного человека в один миг. */
const pending = new Map<string, Promise<PersonAnswer>>()

function memoryKey(kind: PersonKind, personId: number): string {
  return `${kind}:${personId}`
}

function cacheKey(kind: PersonKind, personId: number): string {
  return `${KEY_PREFIX[kind]}${personId}`
}

function missKey(kind: PersonKind, personId: number): string {
  return `${MISS_PREFIX}${memoryKey(kind, personId)}`
}

/** Кладёт карточку в память и заодно обратный указатель: забытый указатель ломает незаметно. */
function remember(kind: PersonKind, person: PersonRef, card: RussianPerson): void {
  memory.set(memoryKey(kind, person.personId), card)
  if (typeof card.shikiId === 'number' && card.shikiId > 0) {
    byShiki.set(card.shikiId, { kind, person })
  }
}

/** Читает карточку со склада. Протухшая запись считается отсутствующей. */
async function readCache(kind: PersonKind, personId: number): Promise<RussianPerson | null> {
  const key = cacheKey(kind, personId)

  const record = await dbGet<MediaCacheRecord<RussianPerson>>('mediaCache', key)
  if (!record || typeof record.ts !== 'number') return null
  if (!isFresh(key, record.ts, LIFE_PEOPLE)) return null

  const data = record.data
  return data && typeof data.russian === 'string' && data.russian ? data : null
}

/** Кладёт карточку на склад. */
async function writeCache(kind: PersonKind, personId: number, data: RussianPerson): Promise<void> {
  await dbSet('mediaCache', { key: cacheKey(kind, personId), data, ts: Date.now() })
}

/** Свежий ли отказ на складе; сбой чтения — не отказ: лучше лишний запрос, чем латиница. */
async function readMiss(kind: PersonKind, personId: number): Promise<boolean> {
  const key = missKey(kind, personId)

  try {
    const record = await dbGet<MediaCacheRecord<{ miss: true }>>('mediaCache', key)
    if (!record || typeof record.ts !== 'number') return false

    return isFresh(key, record.ts, LIFE_PERSON_MISS)
  } catch (e) {
    Logger('WARN', `Русское имя: склад не отдал отказ (${memoryKey(kind, personId)})`, e)
    return false
  }
}

/** Кладёт отказ на склад, не роняя добычу: имя уже спрошено, неудачная запись стоит лишь завтрашнего запроса. */
async function writeMiss(kind: PersonKind, personId: number): Promise<void> {
  try {
    await dbSet('mediaCache', { key: missKey(kind, personId), data: { miss: true }, ts: Date.now() })
  } catch (e) {
    Logger('WARN', `Русское имя: склад не принял отказ (${memoryKey(kind, personId)})`, e)
  }
}

/** Строка или null (пустое равносильно отсутствию); разметка источника сохраняется — её разбирает rich-text. */
function textOrNull(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null

  const clean = text.trim()
  return clean === '' ? null : clean
}

/** Полный путь одного человека: склад, затем поиск Shikimori; исход возвращается вместе с карточкой. */
async function loadOne(
  kind: PersonKind,
  person: PersonRef,
  targetMalIds: number[],
): Promise<PersonAnswer> {
  const key = memoryKey(kind, person.personId)

  const cached = await readCache(kind, person.personId)
  if (cached) {
    remember(kind, person, cached)
    return { state: 'ready', person: cached }
  }

  // Отказ читается вторым: карточка старше отказа всегда важнее.
  if (await readMiss(kind, person.personId)) {
    memory.set(key, null)
    return { state: 'none', person: null }
  }

  const found = await fetchShikiPersonREST(
    kind === 'character' ? 'characters' : 'people',
    person.name,
    person.native,
    targetMalIds,
  )

  // Обрыв, темп и чужая пятисотка — недоезд, в память не идёт: сеть вернётся — спросим снова.
  if (found.status === 0 || found.status === 429 || found.status >= 500) {
    return { state: 'fail', person: null }
  }

  if (found.status !== 200 || !found.data?.russian) {
    // Источник ответил и русского имени не знает: это добытый ответ, и он хранится.
    memory.set(key, null)
    await writeMiss(kind, person.personId)
    return { state: 'none', person: null }
  }

  const card: RussianPerson = {
    russian: found.data.russian,
    description: textOrNull(found.data.description),
    shikiId: found.data.id,
  }

  remember(kind, person, card)
  await writeCache(kind, person.personId, card)
  return { state: 'ready', person: card }
}

/**
 * Русская карточка человека или `null`; повторные вызовы ждут тот же ответ. `targetMalIds` — гард против тёзок.
 */
export async function askRussianPerson(
  kind: PersonKind,
  person: PersonRef,
  targetMalIds: number[] = [],
): Promise<PersonAnswer> {
  const key = memoryKey(kind, person.personId)
  if (memory.has(key)) {
    const known = memory.get(key) ?? null
    // Запомненное знание всегда исход: карточка или добытый отказ; недоезд в память не пишется.
    return { state: known === null ? 'none' : 'ready', person: known }
  }

  const inFlight = pending.get(key)
  if (inFlight) return await inFlight

  const task = loadOne(kind, person, targetMalIds).catch((e) => {
    // Сбой не запоминается в памяти: сеть вернётся — спросим снова.
    Logger('WARN', `Русское имя: добыть не вышло (${person.name})`, e)
    return { state: 'fail' as const, person: null }
  })

  pending.set(key, task)

  try {
    return await task
  } finally {
    pending.delete(key)
  }
}

export async function getRussianPerson(
  kind: PersonKind,
  person: PersonRef,
  targetMalIds: number[] = [],
): Promise<RussianPerson | null> {
  const answer = await askRussianPerson(kind, person, targetMalIds)
  return answer.person
}

/**
 * Русские имена состава одним запросом ролей; карточки помечаются `partial`, описание добирается при открытии.
 */
export async function prefetchRussianPeople(
  malId: number,
  entries: Array<{ kind: PersonKind; person: PersonRef }>,
): Promise<Array<{ kind: PersonKind; person: PersonRef }>> {
  // Память и склад первыми: знакомые не ждут сети, полные карточки не подменяются частичными.
  const todo: typeof entries = []
  for (const entry of entries) {
    const key = memoryKey(entry.kind, entry.person.personId)
    if (memory.has(key)) continue

    const cached = await readCache(entry.kind, entry.person.personId)
    if (cached) {
      remember(entry.kind, entry.person, cached)
      continue
    }

    // Свежий отказ — такой же ответ склада, как карточка: в добор он не идёт.
    if (await readMiss(entry.kind, entry.person.personId)) {
      memory.set(key, null)
      continue
    }

    todo.push(entry)
  }
  if (todo.length === 0) return []

  const roles = await fetchShikiRoles(malId, 'animes')
  if (!roles) return todo

  const left: typeof todo = []
  let added = 0

  for (const entry of todo) {
    const pool = entry.kind === 'character' ? roles.characters : roles.people
    const target: NameTarget = { full: entry.person.name, native: entry.person.native }

    // Порог 55: кандидаты уже ограничены составом этого тайтла.
    let best: PersonCandidate | null = null
    let bestScore = 0
    for (const cand of pool) {
      const score = scoreNameMatch(cand, target)
      if (score > bestScore) {
        bestScore = score
        best = cand
      }
    }

    if (!best || bestScore < 55 || typeof best.russian !== 'string' || best.russian === '') {
      left.push(entry)
      continue
    }

    const card: RussianPerson = {
      russian: best.russian,
      description: null,
      shikiId: best.id,
      partial: true,
    }
    remember(entry.kind, entry.person, card)
    await writeCache(entry.kind, entry.person.personId, card)
    added++
  }

  Logger('INFO', `Русские имена списком ролей: ${added} из ${todo.length}`)
  return left
}

/** Полная карточка с описанием; частичная добирает описание одним запросом по известному номеру. */
export async function askRussianPersonFull(
  kind: PersonKind,
  person: PersonRef,
  targetMalIds: number[] = [],
): Promise<PersonAnswer> {
  const key = memoryKey(kind, person.personId)
  const known = memory.get(key)

  if (known && !known.partial) return { state: 'ready', person: known }

  if (known?.partial && known.shikiId) {
    const details = await fetchShikiPersonDetails(
      kind === 'character' ? 'characters' : 'people',
      known.shikiId,
    )

    // Детали не доехали — отдаём имя из списка ролей; исход всё равно недоезд (описание добыть можно повтором).
    if (!details) return { state: 'fail', person: known }

    const full: RussianPerson = {
      russian: details.russian ?? known.russian,
      description: textOrNull(details.description),
      shikiId: known.shikiId,
    }
    remember(kind, person, full)
    await writeCache(kind, person.personId, full)
    return { state: 'ready', person: full }
  }

  return await askRussianPerson(kind, person, targetMalIds)
}

/** Что известно сейчас, без ожидания: для плитки и шапки окошка; нет перевода — показываем ромаджи. */
export function peekRussianPerson(kind: PersonKind, personId: number): RussianPerson | null {
  return memory.get(memoryKey(kind, personId)) ?? null
}

/** Кто это у нас по номеру Шикимори: быстрый путь для ссылок из описания, без сети. */
export function peekPersonByShiki(shikiId: number): KnownPerson | null {
  return byShiki.get(shikiId) ?? null
}

/**
 * Кладёт готовое соответствие со стороны; полная карточка не подменяется частичной — описание терять нельзя.
 */
export async function rememberRussianPerson(
  kind: PersonKind,
  person: PersonRef,
  card: RussianPerson,
): Promise<void> {
  if (card.russian.trim() === '') return

  const known = memory.get(memoryKey(kind, person.personId))
  if (known && !known.partial && card.partial === true) {
    // Указатель всё равно полезен: номер Шикимори мог быть ещё неизвестен.
    remember(kind, person, known)
    return
  }

  remember(kind, person, card)
  await writeCache(kind, person.personId, card)
}

/** Забывает знание запуска. Склад не трогается: его чистят из настроек. */
export function forgetRussianPeople(): void {
  memory.clear()
  byShiki.clear()
  pending.clear()
}
