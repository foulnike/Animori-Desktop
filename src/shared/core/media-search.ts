// Поиск тайтлов: свой список и каталог, латиница и кириллица (каталог AniList кириллицу не знает).
// Здесь же отбор взрослого, порог длины слова и приведение набранного к одному виду — правило одно на все экраны.

import { fetchBriefsByMal } from '../api/anilist-lookup'
import { searchMedia, type MediaBrief, type SearchPage } from '../api/anilist-media'
import { hasCyrillic, searchShikimori } from '../api/shikimori-search'
import { Logger } from '../utils/logger'
import { adultAllowed, hiddenCount, keepAllowed } from './adult'
import { selectEntries } from './collection-view'
import { peekRussianName, rememberRussianName, warmRussianNames } from './media-title'
import type { SnapshotEntry } from './snapshot'

/** Потолок просмотра своего списка за поиск: отбор идёт в памяти и сети не трогает. */
const OWN_SCAN_LIMIT = 20000

// Слово короче трёх знаков само в сеть не едет: каталог по буквам отдаёт случайную горсть,
// и запрос занимает очередь темпа. Порог не запрет — по Enter экран спрашивает как есть.
export const MIN_WORD_LEN = 3

/** Приводит набранное к одному виду: края обрезаются, внутренние пробелы сводятся к одному. */
export function tidyWord(word: string): string {
  return word.trim().replace(/\s+/g, ' ')
}

/** Дорос ли набранный текст до самостоятельного похода в сеть. */
export function isSearchable(word: string): boolean {
  return tidyWord(word).length >= MIN_WORD_LEN
}

/** Одно слово к сравнению: регистр не важен, края и лишние пробелы убраны. */
function fold(text: string): string {
  return tidyWord(text).toLowerCase()
}

/** Есть ли слово в названии. Пустое название ничего не совпадает. */
function fits(title: string | null | undefined, needle: string): boolean {
  return typeof title === 'string' && title !== '' && fold(title).includes(needle)
}

/** Искать ли в каталоге через Шикимори; вынесено наружу для подписи под выдачей. */
export function isRussianWord(word: string): boolean {
  return hasCyrillic(word)
}

/** Признак взрослого у находки каталога. Одна выжимка на все пути отбора. */
function briefIsAdult(brief: MediaBrief): boolean {
  return brief.isAdult
}

/**
 * Убирает взрослое из страницы и правит числа: общее число сервера обнуляется, признак следующей страницы — серверный.
 */
function sift(page: SearchPage, word: string): SearchPage {
  const hidden = hiddenCount(page.items, briefIsAdult)
  if (hidden === 0) return page

  const items = keepAllowed(page.items, briefIsAdult) as MediaBrief[]
  Logger('INFO', `Поиск «${word}»: спрятано взрослых ${hidden} из ${page.items.length}`)

  return { items, hasNext: page.hasNext, total: null }
}

/** Что дал поиск по своему списку: что нашлось и сколько спрятал тумблер. */
export interface OwnSearch {
  /** Находки без спрятанного взрослого — в том порядке, в каком их показывают. */
  entries: SnapshotEntry[]
  /** Сколько находок спрятано; число честное снизу — считается по просмотренному до потолка. */
  hidden: number
}

/**
 * Поиск по своему списку: слово сверяется с русским, ромадзи и английским; взрослое отсеивается наравне с каталогом.
 */
export async function searchOwnList(word: string, limit: number): Promise<OwnSearch> {
  const needle = fold(word)
  if (needle === '') return { entries: [], hidden: 0 }

  const all = selectEntries({}, { key: 'updated' }, { limit: OWN_SCAN_LIMIT })

  // Склад имён поднимается только для русского слова: латиница есть в снимке.
  if (hasCyrillic(word)) {
    await warmRussianNames(all.map((entry) => entry.mediaId))
  }

  const entries: SnapshotEntry[] = []
  let hidden = 0

  for (const entry of all) {
    const russian = peekRussianName(entry.mediaId)
    if (!fits(russian, needle) && !fits(entry.romaji, needle) && !fits(entry.english, needle)) {
      continue
    }

    if (!adultAllowed(entry.isAdult)) {
      hidden += 1
      continue
    }

    entries.push(entry)
    if (entries.length >= limit) break
  }

  return { entries, hidden }
}

/**
 * Поиск по каталогу: латиница — прямо в AniList, русское — через Шикимори (вторая страница есть только у латиницы).
 */
export async function searchCatalog(word: string, page = 1): Promise<SearchPage | null> {
  const asked = tidyWord(word)
  if (asked === '') return { items: [], hasNext: false, total: 0 }

  if (!hasCyrillic(asked)) {
    const found = await searchMedia(asked, page)
    // Отказ сервера остаётся отказом: пустую страницу вместо него подсовывать нельзя.
    return found === null ? null : sift(found, asked)
  }

  // Второй страницы у русского пути нет, поэтому добор возвращает пустоту.
  if (page > 1) return { items: [], hasNext: false, total: null }

  const found = await searchShikimori(asked)
  if (found.length === 0) {
    Logger('API', `Поиск «${asked}»: Шикимори ничего не нашёл`)
    return { items: [], hasNext: false, total: 0 }
  }

  // Русские названия приехали вместе с находками: связь держится по номеру MAL.
  const russianByMal = new Map<number, string>()
  for (const row of found) {
    if (typeof row.russian === 'string' && row.russian !== '') {
      russianByMal.set(row.malId, row.russian)
    }
  }

  const items = await fetchBriefsByMal(found.map((row) => row.malId))

  // Имя уже в руках: запоминается и для спрятанного — настройку могут включить позже.
  for (const item of items) {
    if (item.malId === null) continue

    const russian = russianByMal.get(item.malId)
    if (russian) rememberRussianName(item.mediaId, russian)
  }

  Logger(
    'API',
    `Поиск «${asked}» через Шикимори: находок ${found.length}, в AniList есть ${items.length}`,
  )

  return sift({ items, hasNext: false, total: items.length }, asked)
}
