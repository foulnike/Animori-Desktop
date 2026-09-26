// Проверки россыпи на плашке приветствия (`app/screens/home-spray`): число цветков обязано расти
// вместе со свободным местом, цветок не обязан залезать на строку или на розетку.

import { describe, expect, it } from 'vitest'

import { sprayGrains, type KeepOut } from '@/app/screens/home-spray'

/** Плашка широкого окна: 1760 × 210. */
const WIDE_W = 1760
const WIDE_H = 210

/** Плашка узкого окна: 972 × 197. */
const TIGHT_W = 972
const TIGHT_H = 197

/** Строка с кнопками: левый верх плашки. */
const TEXT: KeepOut = { x: 44, y: 40, w: 592, h: 90 }

describe('sprayGrains', () => {
  it('гуще там, где больше свободного места', () => {
    const wide = sprayGrains(WIDE_W, WIDE_H, [TEXT])
    const tight = sprayGrains(TIGHT_W, TIGHT_H, [TEXT])

    expect(wide.length).toBeGreaterThan(tight.length)
    expect(wide.length).toBeGreaterThan(6)
  })

  it('реже, когда строка длиннее', () => {
    const short = sprayGrains(WIDE_W, WIDE_H, [TEXT])
    const long = sprayGrains(WIDE_W, WIDE_H, [{ ...TEXT, h: 170 }])

    expect(long.length).toBeLessThan(short.length)
  })

  it('не залезает ни на строку, ни на розетку', () => {
    const rose: KeepOut = { x: 1400, y: -40, w: 300, h: 300 }
    const grains = sprayGrains(WIDE_W, WIDE_H, [TEXT, rose])

    expect(grains.length).toBeGreaterThan(0)
    for (const grain of grains) {
      const box = { x: grain.left, y: grain.top, w: grain.size, h: grain.tall }
      for (const shut of [TEXT, rose]) {
        const apart =
          box.x + box.w < shut.x ||
          box.x > shut.x + shut.w ||
          box.y + box.h < shut.y ||
          box.y > shut.y + shut.h
        expect(apart).toBe(true)
      }
    }
  })

  it('повторный расчёт того же размера не переставляет россыпь', () => {
    const first = sprayGrains(WIDE_W, WIDE_H, [TEXT])
    const again = sprayGrains(WIDE_W, WIDE_H, [TEXT])

    expect(again).toEqual(first)
  })

  it('на вырожденной плашке россыпи нет', () => {
    expect(sprayGrains(0, 0, [])).toEqual([])
    expect(sprayGrains(1760, 0, [])).toEqual([])
  })

  it('каждый цветок двигается и движение у него своё', () => {
    const grains = sprayGrains(WIDE_W, WIDE_H, [TEXT])
    const keys = new Set<number>()
    const paces = new Set<number>()

    for (const grain of grains) {
      keys.add(grain.key)
      paces.add(grain.dur)
      expect(grain.tx).not.toBe(grain.fx)
      expect(grain.rot).toBeGreaterThan(0)
    }

    expect(keys.size).toBe(grains.length)
    expect(paces.size).toBeGreaterThan(1)
  })

  // Прежние «пять пикселей за полминуты» давали 0,17 px/с: движение
  // числилось, но глаз его не брал. Здесь заперты обе границы.
  it('движение заметно: круг не длиннее 30 с и не короче 6 с', () => {
    const grains = sprayGrains(WIDE_W, WIDE_H, [TEXT])

    expect(grains.length).toBeGreaterThan(0)
    for (const grain of grains) {
      expect(grain.dur).toBeGreaterThanOrEqual(6)
      expect(grain.dur).toBeLessThanOrEqual(30)
    }
  })
})
