// Проверки счёта серий (`core/media-looks`): счёт вышедшего и знаменатель полосы — разные числа.
// «Стальной шар»: две записи AniList, знаменатель 11, вышедшее 0 — «Вышло» не у знаменателя.

import { describe, expect, it } from 'vitest'

import { partsAired, partsCeiling } from '@/core/media-looks'

/** Анонс: итог объявлен, ближайшая серия первая. Ни одной вышедшей. */
const SOON = { episodes: 11, airingEpisode: 1 }

/** Онгоинг: итога нет, ближайшая серия пятая — значит, вышло четыре. */
const RUNNING = { episodes: null, airingEpisode: 5 }

/** Завершённый: ближайшей серии нет, итог назван. */
const DONE = { episodes: 12, airingEpisode: null }

describe('счёт серий', () => {
  it('у анонса вышедших нет, хотя итог объявлен', () => {
    expect(partsAired(SOON)).toBe(0)
  })

  it('у анонса знаменатель — объявленный итог, а не ноль', () => {
    expect(partsCeiling(SOON)).toBe(11)
  })

  it('у онгоинга вышедшее — номер ближайшей серии без единицы', () => {
    expect(partsAired(RUNNING)).toBe(4)
    expect(partsCeiling(RUNNING)).toBe(4)
  })

  it('у завершённого вышедшее не выдумывается', () => {
    // Идущего нет — сервер о выходе не говорит, и надписи быть не должно.
    expect(partsAired(DONE)).toBeNull()
    expect(partsCeiling(DONE)).toBe(12)
  })

  it('пустой облик — пустой ответ', () => {
    expect(partsAired(null)).toBeNull()
    expect(partsCeiling(null)).toBeNull()
  })

  it('ноль не подменяется итогом, а итог — нулём', () => {
    // Вторая серия на подходе, первая вышла: ровно одна.
    expect(partsAired({ episodes: 11, airingEpisode: 2 })).toBe(1)

    // Анонс без объявленного итога: знаменателя нет, вышедших ноль.
    expect(partsCeiling({ episodes: null, airingEpisode: 1 })).toBeNull()
    expect(partsAired({ episodes: null, airingEpisode: 1 })).toBe(0)
  })
})
