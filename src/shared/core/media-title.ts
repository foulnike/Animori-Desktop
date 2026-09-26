// Русские названия и описания: память, датасет, склад, затем сеть; пачечный путь наполняет только склад имён NAME1_.
// Отказы держатся отдельно (memory/names/noname): «имени нет» от датасета не глушит открытую карточку.

import { CACHE_TIME } from './constants'
import { lookupDatasetName } from './dataset-names'
import { dbGet, dbSet } from './db'
import { settings } from './settings'
import { fetchMalIds } from '../api/anilist-media'
import { fetchShikiNames, forgetShikiCards } from '../api/shikimori-media'
import { resolveTitle } from '../api/titles'
import { Logger } from '../utils/logger'
import type { MediaCacheRecord } from './types'

/**
 * Префикс склада карточек; цифра — версия формы (RU4 — описание с разметкой источника, хранение бессрочное).
 */
const KEY_PREFIX = 'RU4_'

/**
 * Префикс склада имён: отдельная запись — имён читаются тысячи за раз; датасет ложится в свой файл.
 */
const NAME_PREFIX = 'NAME1_'

/**
 * «Сеть спрашивали, русского имени нет»: без записей каждый запуск бил бы за теми же тысячами.
 */
const NONAME_PREFIX = 'NONAME1_'

/** Готовая русская карточка тайтла. */
export interface RussianTitle {
  russian: string
  /** Описание с разметкой источника: разбирается при показе. */
  description: string | null
  url: string
  /** Имя источника для подписи под описанием. */
  sourceName: string
  /** Оценка MAL из зеркала Шикимори, шкала 0..10. */
  score: number | null
  /** Распределение голосов Шикимори для их собственной средней. */
  rates: Array<{ name: string; value: number }> | null
}

/**
 * Три исхода, а не два: 'none' — перевода нет (английский текст показать можно), 'fail' — сбой (нельзя).
 */
export type RussianAskState =
  /** Карточка есть. */
  | 'ready'
  /** Источник спрошен и ответил, что перевода нет. */
  | 'none'
  /** До источника не дошли: сбой, обрыв, отказ по темпу. */
  | 'fail'

/** Ответ источника о русской карточке вместе с самим исходом. */
export interface RussianAsk {
  state: RussianAskState
  title: RussianTitle | null
}

/** Тайтл и его номер MAL: пачечным путям нужны оба сразу. */
interface TitlePair {
  mediaId: number
  malId: number
}

/**
 * Знание запуска про карточки; `null` — «спрашивали, перевода нет». Ответ датасета сюда не попадает.
 */
const memory = new Map<number, RussianTitle | null>()

/**
 * Имена, добытые попутно (поиск по Шикимори): держатся отдельно — голое имя не должно выдаваться за карточку.
 */
const names = new Map<number, string>()

/**
 * Кому имени нет вовсе: переживает запуски; спрашивают сюда только пачечные пути, карточка — нет.
 */
const noname = new Set<number>()

/**
 * Чьи ключи уже искали на складе: отсутствие там не значит «перевода нет» — сеть спросить стоит.
 */
const asked = new Set<number>()

/** Чьи имена уже искали на складе имён. Склады разные — и отметки разные. */
const askedNames = new Set<number>()

/** Чьи отказы уже искали на складе: чтение пустоты тоже стоит обращения. */
const askedNoname = new Set<number>()

/** Незавершённые добычи: два виджета часто просят один тайтл в один миг. */
const pending = new Map<number, Promise<RussianAsk>>()

function cacheKey(mediaId: number): string {
  return `${KEY_PREFIX}${mediaId}`
}

function nameKey(mediaId: number): string {
  return `${NAME_PREFIX}${mediaId}`
}

function nonameKey(mediaId: number): string {
  return `${NONAME_PREFIX}${mediaId}`
}

/** Читает карточку со склада. Протухшая запись считается отсутствующей. */
async function readCache(mediaId: number): Promise<RussianTitle | null> {
  asked.add(mediaId)

  const record = await dbGet<MediaCacheRecord<RussianTitle>>('mediaCache', cacheKey(mediaId))
  if (!record || typeof record.ts !== 'number') return null
  if (Date.now() - record.ts > CACHE_TIME) return null

  const data = record.data
  return data && typeof data.russian === 'string' && data.russian ? data : null
}

/** Кладёт карточку на склад. Отсутствие перевода на склад карточек не пишется. */
async function writeCache(mediaId: number, data: RussianTitle): Promise<void> {
  await dbSet('mediaCache', { key: cacheKey(mediaId), data, ts: Date.now() })
}

/** Читает имя со склада имён. Протухшая запись считается отсутствующей. */
async function readNameCache(mediaId: number): Promise<string | null> {
  askedNames.add(mediaId)

  const record = await dbGet<MediaCacheRecord<string>>('mediaCache', nameKey(mediaId))
  if (!record || typeof record.ts !== 'number') return null
  if (Date.now() - record.ts > CACHE_TIME) return null

  return typeof record.data === 'string' && record.data !== '' ? record.data : null
}

/** Кладёт имя на склад имён. Пустое имя записью не считается. */
async function writeNameCache(mediaId: number, russian: string): Promise<void> {
  if (russian === '') return

  await dbSet('mediaCache', { key: nameKey(mediaId), data: russian, ts: Date.now() })
}

/** Спрашивали ли сеть и получали ли отказ; читается раз за запуск — ответ прокрутки не меняется. */
async function readNoname(mediaId: number): Promise<boolean> {
  if (noname.has(mediaId)) return true
  if (askedNoname.has(mediaId)) return false

  askedNoname.add(mediaId)

  const record = await dbGet<MediaCacheRecord<number>>('mediaCache', nonameKey(mediaId))
  if (!record || typeof record.ts !== 'number') return false
  if (Date.now() - record.ts > CACHE_TIME) return false

  noname.add(mediaId)
  return true
}

/** Запоминает отказ сети навсегда; ответ датасета сюда не пишется — иначе прокрутка закрыла бы путь в рантайм. */
async function writeNoname(mediaId: number): Promise<void> {
  noname.add(mediaId)
  askedNoname.add(mediaId)

  await dbSet('mediaCache', { key: nonameKey(mediaId), data: 1, ts: Date.now() })
}

/** Добывает карточку из сети по уже известному номеру MAL. */
async function fetchByMal(mediaId: number, malId: number): Promise<RussianTitle | null> {
  const resolved = await resolveTitle(malId)

  if (!resolved || !resolved.russian) {
    // Сеть ответила отказом: это можно класть в память — карточка услышит то же.
    memory.set(mediaId, null)

    // Следующему запуску пригодится: сетки не пойдут, открытая карточка попробует.
    await writeNoname(mediaId)
    return null
  }

  const card: RussianTitle = {
    russian: resolved.russian,
    description: resolved.description,
    url: resolved.url,
    sourceName: resolved.sourceName,
    score: resolved.score,
    rates: resolved.rates,
  }

  memory.set(mediaId, card)

  // Один ответ наполняет оба склада: имя — сетке, описание — открытой карточке.
  await Promise.all([writeCache(mediaId, card), writeNameCache(mediaId, card.russian)])
  return card
}

/** Полный путь для одного тайтла: склад, соответствие MAL, источники. */
async function loadOne(mediaId: number): Promise<RussianTitle | null> {
  const cached = await readCache(mediaId)
  if (cached) {
    memory.set(mediaId, cached)
    return cached
  }

  const malId = (await fetchMalIds([mediaId])).get(mediaId)
  if (!malId) {
    memory.set(mediaId, null)
    return null
  }

  return await fetchByMal(mediaId, malId)
}

/**
 * Русская карточка с исходом: путь открытой карточки — единственный, кто не спрашивает отрицательные записи.
 */
export async function getRussianTitle(mediaId: number): Promise<RussianAsk> {
  if (memory.has(mediaId)) {
    const title = memory.get(mediaId) ?? null
    // Запомненное знание всегда исход: карточка или отказ источника; сбой в память не пишется.
    return { state: title === null ? 'none' : 'ready', title }
  }

  const inFlight = pending.get(mediaId)
  if (inFlight) return await inFlight

  const task = loadOne(mediaId)
    .then<RussianAsk>((title) => ({
      state: title === null ? 'none' : 'ready',
      title,
    }))
    .catch<RussianAsk>((e) => {
      // Сбой не запоминается и уходит своим исходом: «сети нет» и «перевода нет» — разное.
      Logger('WARN', `Русское название: добыть не вышло (тайтл ${mediaId})`, e)
      return { state: 'fail', title: null }
    })

  pending.set(mediaId, task)

  try {
    return await task
  } finally {
    pending.delete(mediaId)
  }
}

/** Запоминает имя, доставшееся даром с чужим ответом: выдача поиска выходит на русском сразу. */
export function rememberRussianName(mediaId: number, russian: string): void {
  const clean = russian.trim()
  if (clean === '') return

  names.set(mediaId, clean)
}

/**
 * Поднимает в память имена без сети: датасет, склад имён, склад карточек; в свою запись имя не переносится.
 */
export async function warmRussianNames(mediaIds: number[]): Promise<number> {
  let warmed = 0

  for (const mediaId of mediaIds) {
    if (memory.has(mediaId) || names.has(mediaId)) continue

    try {
      // Датасет первым: он полнее складов и читается из памяти запуска.
      const fromDataset = await lookupDatasetName(mediaId)
      if (fromDataset.kind === 'name') {
        names.set(mediaId, fromDataset.name)
        warmed++
        continue
      }
      if (fromDataset.kind === 'none') {
        // Память не трогаем: тут решается вопрос поиска, а не судьба открытой карточки; сети здесь нет.
        noname.add(mediaId)
        continue
      }

      // Склады спрашиваются по одному разу за запуск: чтений тут тысячи.
      const stored = askedNames.has(mediaId) ? null : await readNameCache(mediaId)
      if (stored !== null) {
        names.set(mediaId, stored)
        warmed++
        continue
      }

      const cached = asked.has(mediaId) ? null : await readCache(mediaId)
      if (!cached) continue

      memory.set(mediaId, cached)
      warmed++
    } catch (e) {
      // Склад мог не открыться: без него поиск обеднеет, но работать обязан.
      Logger('WARN', `Русские имена: склад не ответил по тайтлу ${mediaId}`, e)
      return warmed
    }
  }

  if (warmed > 0) Logger('DB', `Русские имена: без сети поднято ${warmed}`)
  return warmed
}

/** Разрешён ли Шикимори настройками: пачками умеет только он; кто отключил — отключил и для сеток. */
function shikimoriAllowed(): boolean {
  return settings.titlePrimary === 'shikimori' || settings.titleFallback === 'shikimori'
}

/**
 * Имена пачками: один запрос на пятьдесят тайтлов, только строка имени; «источник не ответил» не пишем, «нет» пишем вечно.
 */
async function namesInBulk(pairs: TitlePair[]): Promise<number> {
  const reply = await fetchShikiNames(pairs.map((pair) => pair.malId))
  let added = 0

  for (const pair of pairs) {
    try {
      const russian = reply.names.get(pair.malId)
      if (russian) {
        names.set(pair.mediaId, russian)
        await writeNameCache(pair.mediaId, russian)
        added++
        continue
      }

      if (reply.answered.has(pair.malId)) await writeNoname(pair.mediaId)
    } catch (e) {
      // Склад мог не открыться: имя всё равно уже в памяти запуска.
      Logger('WARN', `Русское имя: тайтл ${pair.mediaId} не лёг на склад`, e)
    }
  }

  return added
}

/** Прежний путь по одному через все источники: для тех, кто отключил Шикимори. */
async function namesOneByOne(pairs: TitlePair[]): Promise<number> {
  let added = 0

  for (const pair of pairs) {
    try {
      if (await fetchByMal(pair.mediaId, pair.malId)) added++
    } catch (e) {
      // Один упавший тайтл не повод бросать остальной экран без названий.
      Logger('WARN', `Русское имя: тайтл ${pair.mediaId} пропущен`, e)
    }
  }

  return added
}

/**
 * Готовит имена для видимого куска списка (датасет, склад имён, склад карточек); MAL и имена — пачками.
 */
export async function prefetchRussianNames(mediaIds: number[]): Promise<number> {
  const unknown: number[] = []
  let skipped = 0

  for (const mediaId of mediaIds) {
    if (memory.has(mediaId) || names.has(mediaId)) continue

    // Датасет раньше складов: он свежее и отвечает из памяти, не трогая ни диск, ни сеть.
    const fromDataset = await lookupDatasetName(mediaId)
    if (fromDataset.kind === 'name') {
      names.set(mediaId, fromDataset.name)
      continue
    }

    // Склад спрашивается раз за запуск: от повторного чтения ответ не меняется.
    const stored = askedNames.has(mediaId) ? null : await readNameCache(mediaId)
    if (stored !== null) {
      names.set(mediaId, stored)
      continue
    }

    const cached = asked.has(mediaId) ? null : await readCache(mediaId)
    if (cached) {
      memory.set(mediaId, cached)

      // Имя переносится в свою запись: следующий запуск возьмёт строку без описания с оценками.
      await writeNameCache(mediaId, cached.russian)
      continue
    }

    // Отрицательная запись последней: имя могло приехать на склад позже отказа — скажем, с поиском.
    if (await readNoname(mediaId)) {
      skipped++
      continue
    }

    unknown.push(mediaId)
  }

  if (unknown.length === 0) {
    if (skipped > 0) Logger('DB', `Русские имена: ${skipped} без перевода, сеть не трогаем`)
    return 0
  }

  const malIds = await fetchMalIds(unknown)
  const pairs: TitlePair[] = []

  for (const mediaId of unknown) {
    const malId = malIds.get(mediaId)
    if (!malId) {
      // Номера MAL нет — спрашивать не по чему; знание на склад, но не в память: пачечный путь не решает за карточку.
      await writeNoname(mediaId)
      continue
    }

    pairs.push({ mediaId, malId })
  }

  if (pairs.length === 0) {
    const noMal = unknown.length
    Logger('INFO', `Русские имена: соответствий MAL нет ни у одного из ${noMal}`)
    return 0
  }

  const added = shikimoriAllowed() ? await namesInBulk(pairs) : await namesOneByOne(pairs)

  const tail = skipped > 0 ? `, пропущено ${skipped}` : ''
  Logger('INFO', `Русские имена: добыто ${added} из ${unknown.length}${tail}`)
  return added
}

/** Русское название прямо сейчас: из полной карточки или попутное — строкам большего не надо. */
export function peekRussianName(mediaId: number): string | null {
  return memory.get(mediaId)?.russian ?? names.get(mediaId) ?? null
}

/** Забывает знание запуска. Склад не трогается: его чистят из настроек. */
export function forgetRussianTitles(): void {
  memory.clear()
  names.clear()
  noname.clear()
  asked.clear()
  askedNames.clear()
  askedNoname.clear()
  pending.clear()

  // Карточки Шикимори — тоже знание запуска, и лежат в чужом модуле; без этого «забыть всё» было бы неполным.
  forgetShikiCards()
}
