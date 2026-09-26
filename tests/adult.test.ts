// Проверки отбора взрослого: возраст по дате рождения и условие «прятать». Две вещи здесь стоят
// проверок отдельно от экранов.

import { beforeEach, describe, expect, it } from 'vitest'

import { ADULT_AGE, adultByBirth, ageAt, hiddenCount, keepAllowed } from '@/core/adult'
import { matchesEntry } from '@/core/collection-view'
import { settings } from '@/core/settings'
import type { SnapshotEntry } from '@/core/snapshot'

/** Запись снимка: для отбора важно только поле «взрослый». */
function entry(mediaId: number, isAdult: boolean): SnapshotEntry {
  return {
    mediaId,
    status: 'watching',
    score10: 0,
    progress: 0,
    repeat: 0,
    startedAt: null,
    completedAt: null,
    notes: null,
    updatedAt: 0,
    isAdult,
  }
}

beforeEach(() => {
  // Тумблер читается в момент вопроса, поэтому его достаточно выставить
  // в самом объекте настроек: отдельного пути для проверок у него нет.
  settings.showAdult = false
})

describe('ageAt', () => {
  it('считает полные годы, а не разницу годов', () => {
    // День рождения сегодня: восемнадцать уже есть.
    expect(ageAt('2008-09-18', new Date(2026, 8, 18))).toBe(18)
  })

  it('не засчитывает год, если день рождения ещё впереди', () => {
    // Разница годов здесь ровно восемнадцать, а полных лет — семнадцать.
    expect(ageAt('2008-09-19', new Date(2026, 8, 18))).toBe(17)
  })

  it('засчитывает год, если день рождения был вчера', () => {
    expect(ageAt('2008-09-17', new Date(2026, 8, 18))).toBe(18)
  })

  it('разбирается с 29 февраля', () => {
    // В невисокосном году дня рождения ещё не было, а в марте он уже прошёл.
    expect(ageAt('2008-02-29', new Date(2026, 1, 28))).toBe(17)
    expect(ageAt('2008-02-29', new Date(2026, 2, 1))).toBe(18)
  })

  it('отвечает null на негодную дату', () => {
    expect(ageAt('', new Date(2026, 8, 18))).toBeNull()
    expect(ageAt(null, new Date(2026, 8, 18))).toBeNull()
    expect(ageAt(undefined, new Date(2026, 8, 18))).toBeNull()
    expect(ageAt('18.09.2008', new Date(2026, 8, 18))).toBeNull()
    expect(ageAt('2008-13-01', new Date(2026, 8, 18))).toBeNull()
    expect(ageAt('2008-09-32', new Date(2026, 8, 18))).toBeNull()
  })

  it('отвечает null на дату из будущего', () => {
    expect(ageAt('2030-01-01', new Date(2026, 8, 18))).toBeNull()
  })
})

describe('adultByBirth', () => {
  it('пускает ровно в восемнадцать', () => {
    expect(adultByBirth('2008-09-18', new Date(2026, 8, 18))).toBe(true)
  })

  it('не пускает за день до восемнадцати', () => {
    expect(adultByBirth('2008-09-19', new Date(2026, 8, 18))).toBe(false)
  })

  it('на негодной дате отвечает «нет», а не «да»', () => {
    // Ошибка здесь пускала бы вперёд, а не назад, — и это не тот случай,
    // где можно ошибиться в чужую пользу.
    expect(adultByBirth('', new Date(2026, 8, 18))).toBe(false)
    expect(adultByBirth(null, new Date(2026, 8, 18))).toBe(false)
    expect(adultByBirth('не дата', new Date(2026, 8, 18))).toBe(false)
  })

  it('возраст показа — восемнадцать', () => {
    expect(ADULT_AGE).toBe(18)
  })
})

describe('keepAllowed и hiddenCount', () => {
  const items = [entry(1, false), entry(2, true), entry(3, true)]

  it('при включённом тумблере отдаёт всё и ничего не считает скрытым', () => {
    settings.showAdult = true

    expect(keepAllowed(items, (item) => item.isAdult)).toHaveLength(3)
    expect(hiddenCount(items, (item) => item.isAdult)).toBe(0)
  })

  it('при выключенном прячет взрослое и говорит, сколько спрятал', () => {
    expect(keepAllowed(items, (item) => item.isAdult).map((item) => item.mediaId)).toEqual([1])
    expect(hiddenCount(items, (item) => item.isAdult)).toBe(2)
  })
})

describe('условие hideAdult в отборе коллекции', () => {
  it('при выключенном тумблере прячет взрослую запись', () => {
    expect(matchesEntry(entry(2, true), { hideAdult: true })).toBe(false)
    expect(matchesEntry(entry(1, false), { hideAdult: true })).toBe(true)
  })

  it('при включённом тумблере не прячет ничего', () => {
    settings.showAdult = true

    expect(matchesEntry(entry(2, true), { hideAdult: true })).toBe(true)
  })

  it('без условия взрослая запись проходит: на этом стоят внутренние вопросы', () => {
    // «Есть ли запись у этого тайтла» спрашивается тем же отбором, и прятать
    // там значит соврать о своём же списке.
    expect(matchesEntry(entry(2, true), {})).toBe(true)
    expect(matchesEntry(entry(2, true))).toBe(true)
  })
})
