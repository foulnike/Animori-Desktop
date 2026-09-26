// Поиск тайтлов по русскому слову у Shikimori (каталог AniList кириллицу не понимает).
// Повтор слова в сеть не едет: находки живут в памяти запуска четверть часа.

import { LIFE_SEARCH } from '../core/cache-life'
import { Logger } from '../utils/logger'
import { fetchShiki } from './shikimori'

/** Сколько находок просить у Шикимори за раз: больше на одну страницу не нужно. */
export const SHIKI_SEARCH_LIMIT = 20

/** Сколько разных слов помнить. Переполнение вытесняет самое давнее. */
const MEMORY_MAX = 30

/** Строка ответа поиска. Полей у Шикимори много, нам хватает номера и имён. */
interface ShikiSearchRow {
  id?: number
  name?: string | null
  russian?: string | null
}

/** Одна находка Шикимори. Номер здесь — номер MyAnimeList, они совпадают. */
export interface ShikiFound {
  malId: number
  russian: string | null
  name: string | null
}

/** Память находок: приведённое слово → что нашлось и когда. */
const memory = new Map<string, { at: number; found: ShikiFound[] }>()

/** Есть ли в слове кириллица: русское слово идёт в Шикимори, латиница — прямо в каталог AniList. */
export function hasCyrillic(word: string): boolean {
  return /[\u0400-\u04FF]/.test(word)
}

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Приведение слова к одному написанию: регистр, края, сдвоенные пробелы. */
function fold(word: string): string {
  return word.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** Кладёт находки в память и держит её в оговорённом размере. */
function remember(key: string, found: ShikiFound[]): void {
  // Повторная запись переставляет слово в конец: вытесняется давно не спрошенное.
  memory.delete(key)
  memory.set(key, { at: Date.now(), found })

  while (memory.size > MEMORY_MAX) {
    const oldest = memory.keys().next()
    if (oldest.done) break

    memory.delete(oldest.value)
  }
}

/** Забывает найденное по словам: ручная чистка склада обязана забывать ответы источника. */
export function forgetShikiSearch(): void {
  memory.clear()
}

/**
 * Ищет тайтлы по слову у Шикимори; порядок находок сохраняется. Повтор того же слова в пределах четверти часа
 * отвечает из памяти запуска. Взрослое из выдачи не вырезается: отбор — дело пункта 3.8; раздел всегда аниме.
 */
export async function searchShikimori(word: string): Promise<ShikiFound[]> {
  const asked = word.trim()
  if (asked === '') return []

  const key = fold(asked)
  const kept = memory.get(key)

  if (kept && Date.now() - kept.at < LIFE_SEARCH) {
    Logger('API', `Поиск у Шикимори «${asked}»: ответ из памяти, находок ${kept.found.length}`)

    // Наружу уходит копия: перестановки у зовущего не должны портить память.
    return kept.found.slice()
  }

  // Раздел вписан словом: аниме и манга у Шикимори — разные разделы, чужой номер увёл бы выписку не туда.
  const path =
    `/api/animes?search=${encodeURIComponent(asked)}` +
    `&limit=${SHIKI_SEARCH_LIMIT}&censored=false`

  const reply = await fetchShiki<ShikiSearchRow[]>(path)
  const rows = Array.isArray(reply.data) ? reply.data : []
  const found: ShikiFound[] = []

  for (const row of rows) {
    if (!row || typeof row.id !== 'number' || row.id <= 0) continue

    found.push({
      malId: row.id,
      russian: textOrNull(row.russian),
      name: textOrNull(row.name),
    })
  }

  remember(key, found)

  Logger('API', `Поиск у Шикимори «${asked}»: нашлось ${found.length}`)
  return found
}
