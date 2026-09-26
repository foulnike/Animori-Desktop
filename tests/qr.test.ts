import { describe, expect, it } from 'vitest'

import { makeQr, qrSvg, type QrCode } from '@/core/qr'

const GOOGLE_URL = 'https://www.google.com/device?user_code=ABCD-EFGH'

/** Код или падение теста: остальным проверкам нужна готовая сетка. */
function built(text: string): QrCode {
  const done = makeQr(text)
  if (!done.ok) throw new Error(done.problem)

  return done.value
}

/** У верно собранных сведений о формате и версии он нулевой — это и есть независимая проверка
 * самого кодирования, а не повтор его логики. */
function bchRest(code: number, gen: number, degree: number, width: number): number {
  let rest = code
  for (let i = width - 1; i >= degree; i--) {
    if (((rest >>> i) & 1) === 1) rest ^= gen << (i - degree)
  }

  return rest
}

/** Пятнадцать бит сведений о формате: две копии лежат в разных местах. */
function formatBits(code: QrCode, second: boolean): number {
  const { size, dark } = code
  const spots: Array<[number, number]> = []

  if (second) {
    for (let i = 0; i < 8; i++) spots.push([8, size - 1 - i])
    for (let i = 8; i < 15; i++) spots.push([size - 15 + i, 8])
  } else {
    for (let i = 0; i <= 5; i++) spots.push([i, 8])
    spots.push([7, 8], [8, 8], [8, 7])
    for (let i = 9; i < 15; i++) spots.push([8, 14 - i])
  }

  let bits = 0
  spots.forEach(([row, col], i) => {
    if (dark[row][col]) bits |= 1 << i
  })

  return bits
}

/** Восемнадцать бит сведений о версии из левого нижнего угла. */
function versionBits(code: QrCode): number {
  let bits = 0
  for (let i = 0; i < 18; i++) {
    const far = code.size - 11 + (i % 3)
    const near = Math.floor(i / 3)
    if (code.dark[near][far]) bits |= 1 << i
  }

  return bits
}

describe('свой QR', () => {
  it('берёт наименьшую годную версию', () => {
    expect(built('a'.repeat(14)).version).toBe(1)
    expect(built('a'.repeat(15)).version).toBe(2)
    expect(built('a'.repeat(26)).version).toBe(2)
    expect(built('a'.repeat(27)).version).toBe(3)
    expect(built('a'.repeat(42)).version).toBe(3)
    expect(built('a'.repeat(43)).version).toBe(4)
    expect(built('a'.repeat(62)).version).toBe(4)
    expect(built('a'.repeat(63)).version).toBe(5)
  })

  it('сторона растёт на четыре клетки на версию', () => {
    expect(built('a').size).toBe(21)
    expect(built('a'.repeat(15)).size).toBe(25)
    expect(built('a'.repeat(120)).size).toBe(45)
  })

  it('адрес входа Google укладывается в четвёртую версию', () => {
    const code = built(GOOGLE_URL)

    expect(code.version).toBe(4)
    expect(code.size).toBe(33)
  })

  it('считает байты, а не знаки', () => {
    // Кириллица по два байта, цветок сакуры — по четыре.
    expect(built('Привет'.repeat(2)).version).toBe(2)
    expect(built('🌸'.repeat(3)).version).toBe(1)
    expect(built('🌸'.repeat(4)).version).toBe(2)
  })

  it('три искателя стоят по углам', () => {
    const { size, dark } = built('a')
    const eyes: Array<[number, number]> = [
      [3, 3],
      [3, size - 4],
      [size - 4, 3],
    ]

    // Искатель — не узор выравнивания: у него тёмное ядро 3×3 целиком, потом светлое кольцо, потом
    // внешнее тёмное и светлая кайма.
    for (const [row, col] of eyes) {
      expect(dark[row][col]).toBe(true)
      expect(dark[row - 1][col]).toBe(true)
      expect(dark[row - 1][col - 1]).toBe(true)

      expect(dark[row - 2][col]).toBe(false)
      expect(dark[row + 2][col + 2]).toBe(false)

      expect(dark[row - 3][col]).toBe(true)
      expect(dark[row][col - 3]).toBe(true)
      expect(dark[row + 3][col + 3]).toBe(true)
    }
  })

  it('полосы синхронизации чередуются', () => {
    const { size, dark } = built('a')

    for (let i = 8; i < size - 8; i++) {
      expect(dark[6][i]).toBe(i % 2 === 0)
      expect(dark[i][6]).toBe(i % 2 === 0)
    }
  })

  it('клетка над левым нижним искателем всегда тёмная', () => {
    const code = built('a')

    expect(code.dark[code.size - 8][8]).toBe(true)
  })

  it('узор выравнивания второй версии стоит один', () => {
    const { dark } = built('a'.repeat(15))

    expect(dark[18][18]).toBe(true)
    expect(dark[17][18]).toBe(false)
    expect(dark[16][18]).toBe(true)
    expect(dark[20][20]).toBe(true)
  })

  it('сведения о формате сходятся в двух копиях и проходят проверку', () => {
    const code = built(GOOGLE_URL)
    const first = formatBits(code, false)

    expect(formatBits(code, true)).toBe(first)

    // Снять условленную маску стандарта и разделить на многочлен 0x537.
    const plain = first ^ 0x5412

    expect(bchRest(plain, 0x537, 10, 15)).toBe(0)
    expect(plain >>> 13).toBe(0)
  })

  it('сведения о версии появляются с седьмой', () => {
    const code = built('a'.repeat(120))
    const bits = versionBits(code)

    expect(code.version).toBe(7)
    expect(bchRest(bits, 0x1f25, 12, 18)).toBe(0)
    expect(bits >>> 12).toBe(7)
  })

  it('пустая и слишком длинная строка — понятный отказ', () => {
    const empty = makeQr('')
    const long = makeQr('a'.repeat(214))

    expect(empty.ok).toBe(false)
    expect(empty.ok ? '' : empty.problem).toContain('Пустую строку')
    expect(long.ok).toBe(false)
    expect(long.ok ? '' : long.problem).toContain('213')
  })

  it('одна и та же строка даёт одну и ту же картинку', () => {
    expect(built(GOOGLE_URL).dark).toEqual(built(GOOGLE_URL).dark)
  })

  it('разметка SVG считает белое поле и не задаёт размер', () => {
    const svg = qrSvg(built('a'))
    const head = svg.slice(0, svg.indexOf('>'))

    expect(svg).toContain('viewBox="0 0 29 29"')
    expect(head).not.toContain('width=')
    expect(head).not.toContain('height=')
    expect(svg).toContain('fill="#ffffff"')
    expect(svg).toContain('fill="#000000"')
    expect(svg.endsWith('</svg>')).toBe(true)
  })

  it('поле и цвета настраиваются', () => {
    const svg = qrSvg(built('a'), { quiet: 0, dark: '#111111', light: '#eeeeee' })

    expect(svg).toContain('viewBox="0 0 21 21"')
    expect(svg).toContain('fill="#eeeeee"')
    expect(svg).toContain('fill="#111111"')
  })

  it('в пути столько отрезков, сколько тёмных клеток', () => {
    const code = built('a')
    const svg = qrSvg(code)
    const spots = code.dark.flat().filter(Boolean).length

    expect(svg.split('h1v1h-1z').length - 1).toBe(spots)
  })
})
