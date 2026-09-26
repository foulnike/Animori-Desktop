// Единая точка отбора взрослого содержимого: решает тумблер настроек, прячется карточка, а не плеер.
// Свой список тоже подчиняется; история не трогается.

import { settings } from './settings'

/** Жанры, которых не бывает при выключенном 18+. Имена серверные. */
const ADULT_GENRES: ReadonlySet<string> = new Set(['Hentai'])

/** Разделы справочника тэгов, закрытые целиком. */
const ADULT_TAG_GROUPS: ReadonlySet<string> = new Set(['Sexual Content'])

/** Тэги вне закрытых разделов, которым в меню отбора тоже не место. */
const ADULT_TAG_NAMES: ReadonlySet<string> = new Set([
  'Hentai',
  'Nudity',
  'Prostitution',
])

/** Показывать ли взрослое сейчас: читается в момент вопроса — тумблер действует сразу. */
export function adultShown(): boolean {
  return settings.showAdult === true
}

/** Пускать ли аниме в показ: неизвестный признак считается безопасным. */
export function adultAllowed(isAdult: boolean | null | undefined): boolean {
  if (isAdult !== true) return true
  return adultShown()
}

/** Пускать ли жанр в меню отбора: спрашивается серверным именем, не подписью. */
export function genreAllowed(genre: string): boolean {
  if (!ADULT_GENRES.has(genre)) return true
  return adultShown()
}

/** Пускать ли тэг в меню отбора: метка сервера, список имён и закрытые разделы. */
export function tagAllowed(tag: {
  name: string
  category?: string | null
  adult?: boolean | null
}): boolean {
  const blocked =
    tag.adult === true ||
    ADULT_TAG_NAMES.has(tag.name) ||
    (typeof tag.category === 'string' && ADULT_TAG_GROUPS.has(tag.category))

  if (!blocked) return true
  return adultShown()
}

/** Отсеивает запрещённое из готовой выдачи. Тот же массив, когда прятать нечего. */
export function keepAllowed<T>(
  items: readonly T[],
  isAdultOf: (item: T) => boolean | null | undefined,
): readonly T[] {
  if (adultShown()) return items
  return items.filter((item) => isAdultOf(item) !== true)
}

/** Сколько находок спрятано: нужно подписи под выдачей, чтобы не выглядело потерей. */
export function hiddenCount<T>(
  items: readonly T[],
  isAdultOf: (item: T) => boolean | null | undefined,
): number {
  if (adultShown()) return 0

  let hidden = 0
  for (const item of items) {
    if (isAdultOf(item) === true) hidden += 1
  }
  return hidden
}

/** Возраст допуска: то же число, что на серверной метке 18+. */
export const ADULT_AGE = 18

/** Полные годы на дату; `null` — дата негодна. Время — довод ради воспроизводимости теста. */
export function ageAt(birth: string | null | undefined, now: Date = new Date()): number | null {
  if (typeof birth !== 'string') return null

  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birth)
  if (hit === null) return null

  const year = Number(hit[1])
  const month = Number(hit[2])
  const day = Number(hit[3])
  if (month < 1 || month > 12 || day < 1 || day > 31) return null

  let age = now.getFullYear() - year
  const before =
    now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day)
  if (before) age -= 1

  return age < 0 ? null : age
}

/** Прошла ли проверка возраста: негодная дата — ответ «нет». */
export function adultByBirth(birth: string | null | undefined, now: Date = new Date()): boolean {
  const age = ageAt(birth, now)
  return age !== null && age >= ADULT_AGE
}
