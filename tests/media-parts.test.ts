// Проверки порядка записей одной части (`core/media-parts`). Правило одно на всё приложение: им
// выбирается запись для плитки франшизы, поиска, импорта списка Шикимори и ссылок в описании.

import { describe, expect, it } from 'vitest'

import { orderParts, pickEntry, startStamp, type PartEntry } from '@/core/media-parts'

function part(id: number, status: string | null, year: number | null, month: number | null = null, day: number | null = null): PartEntry {
  return { id, status, startDate: year === null ? null : { year, month, day } }
}

/** Вышедший первый этап «Стального шара». */
const STAGE_1 = part(190327, 'FINISHED', 2026, 3, 19)

/** Ещё не вышедшие второй с третьим: обещаны на сентябрь 2026. */
const STAGE_2 = part(210482, 'NOT_YET_RELEASED', 2026, 9, 25)

/** Четыре фильма «Карманов лета»: все вышли, все 2025 года. */
const FILM_1 = part(195230, 'FINISHED', 2025, 8, 15)
const FILM_2 = part(206609, 'FINISHED', 2025, 8, 22)

describe('порядок записей одной части', () => {
  it('вышедшая идёт впереди обещанной', () => {
    expect(orderParts(STAGE_2, STAGE_1)).toBeGreaterThan(0)
    expect(orderParts(STAGE_1, STAGE_2)).toBeLessThan(0)
  })

  it('при равном состоянии решает начало выпуска', () => {
    expect(orderParts(FILM_1, FILM_2)).toBeLessThan(0)
  })

  it('при равных датах решает номер записи', () => {
    const a = part(100, 'FINISHED', 2025, 8, 15)
    const b = part(200, 'FINISHED', 2025, 8, 15)

    expect(orderParts(b, a)).toBeGreaterThan(0)
    expect(orderParts(a, b)).toBeLessThan(0)
  })

  it('порядок не зависит от того, как служба перечислила ответ', () => {
    const straight = [STAGE_1, STAGE_2].sort(orderParts).map((entry) => entry.id)
    const reversed = [STAGE_2, STAGE_1].sort(orderParts).map((entry) => entry.id)

    expect(straight).toEqual([190327, 210482])
    expect(reversed).toEqual([190327, 210482])
  })
})

describe('начало выпуска числом', () => {
  it('полная дата считается по году, месяцу и дню', () => {
    expect(startStamp({ year: 2026, month: 3, day: 19 })).toBe(20260319)
  })

  it('неизвестные месяц и день считаются поздними', () => {
    // Запись с одной датой года вперёд записи с полной датой того же года
    // не идёт: год 2026 без месяца — это «когда-то в 2026».
    expect(startStamp({ year: 2026, month: null, day: null })).toBe(20261231)
    expect(startStamp({ year: 2026, month: 3, day: null })).toBe(20260331)
  })

  it('записи без даты спешить некуда', () => {
    expect(startStamp(null)).toBe(Number.MAX_SAFE_INTEGER)
    expect(startStamp({ year: 0, month: null, day: null })).toBe(Number.MAX_SAFE_INTEGER)
  })
})

describe('запись, которой часть представлена', () => {
  it('своя запись берётся, даже если она ещё не вышла', () => {
    // Человек открыл карточку второго этапа — плитка обязана показать её же,
    // иначе «вы здесь» не появится нигде.
    expect(pickEntry([STAGE_1, STAGE_2], 210482)?.id).toBe(210482)
  })

  it('без своей берётся первая по порядку', () => {
    expect(pickEntry([STAGE_2, STAGE_1], null)?.id).toBe(190327)
    expect(pickEntry([STAGE_2, STAGE_1], 999999)?.id).toBe(190327)
  })

  it('у части из четырёх фильмов берётся ранний', () => {
    const films = [FILM_2, part(206610, 'FINISHED', 2025, 8, 29), FILM_1]

    expect(pickEntry(films, null)?.id).toBe(195230)
  })

  it('пустой список — представлять нечем', () => {
    expect(pickEntry([], null)).toBeNull()
  })
})
