// Свой QR — вход в Google с устройства без клавиатуры: без библиотек, в код едет одноразовый
// пропуск.

/** Стойкость M в сведениях о формате обозначается двумя нулями. */
const LEVEL_BITS = 0b00

/** Наибольшая версия, которую здесь умеют. */
const MAX_VERSION = 10

/** Устройство версии: [байт данных, байт стойкости, блоков 1-й группы, байт в ней, блоков 2-й, байт в ней]. */
type Plan = [number, number, number, number, number, number]

/** Затычка: версии считают с единицы, и нулевой строке нужен смысл. */
const NO_PLAN: Plan = [0, 0, 0, 0, 0, 0]

/**
 * Устройство версий на уровне M; сверено: байты данных + стойкость = полная емкость (26..346).
 */
const PLAN: Plan[] = [
  NO_PLAN,
  [16, 10, 1, 16, 0, 0],
  [28, 16, 1, 28, 0, 0],
  [44, 26, 1, 44, 0, 0],
  [64, 18, 2, 32, 0, 0],
  [86, 24, 2, 43, 0, 0],
  [108, 16, 4, 27, 0, 0],
  [124, 18, 4, 31, 0, 0],
  [154, 22, 2, 38, 2, 39],
  [182, 22, 3, 36, 2, 37],
  [216, 26, 4, 43, 1, 44],
]

/** Где стоят узоры выравнивания: на пересечениях координат, кроме трёх углов — там искатели. */
const ALIGN: number[][] = [
  [],
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
]

/** Устройство версии. За таблицу здесь не выходят, но проверка строга. */
function planOf(version: number): Plan {
  return PLAN[version] ?? NO_PLAN
}

/** Места узоров выравнивания для версии. */
function alignOf(version: number): number[] {
  return ALIGN[version] ?? []
}

/** Готовый код. */
export interface QrCode {
  /** Сторона в клетках, без белого поля вокруг. */
  size: number
  /** Версия от 1 до 10. */
  version: number
  /** Тёмные клетки по строкам сверху вниз. */
  dark: boolean[][]
}

/** Исход построения. Форма как всюду в ядре: фраза вместо исключения. */
export type QrDone = { ok: true; value: QrCode } | { ok: false; problem: string }

/** Вид картинки. */
export interface QrLook {
  /** Ширина белого поля в клетках. Меньше четырёх камеры читают хуже. */
  quiet?: number
  /** Цвет тёмных клеток. */
  dark?: string
  /** Цвет поля. */
  light?: string
}

const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)

/** Чтение по номеру. За границей ноль — см. шапку файла. */
function nth(list: Uint8Array | number[], i: number): number {
  return list[i] ?? 0
}

/** Таблицы поля Галуа — раз при загрузке: они малы, а нужны всегда. */
function sow(): void {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x = x << 1
    if ((x & 0x100) !== 0) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = nth(EXP, i - 255)
}

sow()

/** Умножение в поле Галуа. */
function mul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0

  return nth(EXP, nth(LOG, a) + nth(LOG, b))
}

/**
 * Остаток от деления на порождающий многочлен; многочлен строится каждый раз — блоков не больше пяти.
 */
function guard(block: Uint8Array, count: number): Uint8Array {
  let gen = new Uint8Array([1])
  for (let i = 0; i < count; i++) {
    const next = new Uint8Array(gen.length + 1)
    for (let j = 0; j < gen.length; j++) {
      next[j] = nth(next, j) ^ nth(gen, j)
      next[j + 1] = nth(next, j + 1) ^ mul(nth(gen, j), nth(EXP, i))
    }
    gen = next
  }

  const rest = new Uint8Array(block.length + count)
  rest.set(block)
  for (let i = 0; i < block.length; i++) {
    const lead = nth(rest, i)
    if (lead === 0) continue
    for (let j = 1; j < gen.length; j++) rest[i + j] = nth(rest, i + j) ^ mul(nth(gen, j), lead)
  }

  return rest.slice(block.length)
}

/**
 * Строка → UTF-8 своими руками (ядро без TextEncoder); обход по знакам — иначе составные распались бы.
 */
function utf8(text: string): Uint8Array {
  const out: number[] = []

  for (const sign of text) {
    const code = sign.codePointAt(0) ?? 0
    if (code < 0x80) {
      out.push(code)
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      )
    }
  }

  return new Uint8Array(out)
}

/**
 * Сколько байт влезает в версию: голова — 4 бита режима и длина (8 бит до версии 9, 16 с 10-й).
 */
function bytesFit(version: number): number {
  const head = version >= 10 ? 20 : 12

  return Math.floor((planOf(version)[0] * 8 - head) / 8)
}

/**
 * Байты → укладка: голова, данные, добивка, блоки и стойкость вперемежку.
 * Чередование размазывает потери по всем блокам — лежали бы подряд, заслонка убила бы весь код.
 */
function weave(bytes: Uint8Array, version: number): Uint8Array {
  const [dataLen, ecLen, group1, size1, group2, size2] = planOf(version)

  const bits: number[] = []
  const push = (value: number, width: number) => {
    for (let i = width - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }

  push(0b0100, 4)
  push(bytes.length, version >= 10 ? 16 : 8)
  for (const one of bytes) push(one, 8)

  // Хвост: 4 нуля окончания, добивка до байта и 2 условленных байта — пустое место не однотонное пятно.
  const room = dataLen * 8
  for (let i = 0; i < 4 && bits.length < room; i++) bits.push(0)
  while (bits.length % 8 !== 0) bits.push(0)

  const data = new Uint8Array(dataLen)
  for (let i = 0; i < bits.length; i += 8) {
    let one = 0
    for (let j = 0; j < 8; j++) one = (one << 1) | nth(bits, i + j)
    data[i / 8] = one
  }
  for (let i = bits.length / 8, turn = 0; i < dataLen; i++, turn++) {
    data[i] = turn % 2 === 0 ? 0xec : 0x11
  }

  const blocks: Uint8Array[] = []
  const guards: Uint8Array[] = []
  let at = 0
  for (let i = 0; i < group1 + group2; i++) {
    const width = i < group1 ? size1 : size2
    const block = data.slice(at, at + width)
    at += width
    blocks.push(block)
    guards.push(guard(block, ecLen))
  }

  const out = new Uint8Array(dataLen + ecLen * blocks.length)
  let k = 0
  const widest = Math.max(size1, size2)
  for (let i = 0; i < widest; i++) {
    for (const block of blocks) if (i < block.length) out[k++] = nth(block, i)
  }
  for (let i = 0; i < ecLen; i++) {
    for (const one of guards) out[k++] = nth(one, i)
  }

  return out
}

/**
 * Служебные узоры; fixed — не трогать данными и маской: по маске искатели перестали бы узнаваться камерой.
 */
function frame(grid: Uint8Array, fixed: Uint8Array, size: number, version: number): void {
  const set = (row: number, col: number, dark: boolean) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return
    grid[row * size + col] = dark ? 1 : 0
    fixed[row * size + col] = 1
  }

  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0)
    set(i, 6, i % 2 === 0)
  }

  const eyes: Array<[number, number]> = [
    [3, 3],
    [3, size - 4],
    [size - 4, 3],
  ]
  for (const [row, col] of eyes) {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const away = Math.max(Math.abs(dx), Math.abs(dy))
        set(row + dy, col + dx, away !== 2 && away !== 4)
      }
    }
  }

  const spots = alignOf(version)
  const last = spots.length - 1
  for (let i = 0; i < spots.length; i++) {
    for (let j = 0; j < spots.length; j++) {
      const corner = (i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)
      if (corner) continue

      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(nth(spots, i) + dy, nth(spots, j) + dx, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
  }

  // Места под сведения о формате занимаются сейчас, заполняются потом; шестую клетку пропускаем —
  // там полоса синхронизации, записанный ноль разорвал бы её и читатель решил бы, что сетка уехала.
  for (let i = 0; i < 9; i++) {
    if (i === 6) continue

    set(8, i, false)
    set(i, 8, false)
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, false)
    set(size - 1 - i, 8, false)
  }

  // Сведения о версии — только с седьмой: до неё версия угадывается по размеру картинки.
  if (version >= 7) {
    let rem = version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = (version << 12) | rem

    for (let i = 0; i < 18; i++) {
      const on = ((bits >>> i) & 1) === 1
      const far = size - 11 + (i % 3)
      const near = Math.floor(i / 3)
      set(near, far, on)
      set(far, near, on)
    }
  }
}

/**
 * Укладка змейкой: столбцами по два справа налево, 6-й столбец пропускается — там полоса синхронизации.
  * Биты, кончившиеся раньше места, оставляют остаток светлым: у некоторых версий в конце нарочно лишние.
 */
function fill(grid: Uint8Array, fixed: Uint8Array, size: number, data: Uint8Array): void {
  let at = 0

  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5

    for (let step = 0; step < size; step++) {
      for (let j = 0; j < 2; j++) {
        const col = right - j
        const up = ((right + 1) & 2) === 0
        const row = up ? size - 1 - step : step
        const cell = row * size + col

        if (fixed[cell] === 1) continue
        if (at >= data.length * 8) continue

        grid[cell] = (nth(data, at >>> 3) >>> (7 - (at & 7))) & 1
        at++
      }
    }
  }
}

/** Правило маски по номеру. Столбцы — x, строки — y, как в стандарте. */
function bend(mask: number, row: number, col: number): boolean {
  switch (mask) {
    case 0:
      return (col + row) % 2 === 0
    case 1:
      return row % 2 === 0
    case 2:
      return col % 3 === 0
    case 3:
      return (col + row) % 3 === 0
    case 4:
      return (Math.floor(col / 3) + Math.floor(row / 2)) % 2 === 0
    case 5:
      return ((col * row) % 2) + ((col * row) % 3) === 0
    case 6:
      return (((col * row) % 2) + ((col * row) % 3)) % 2 === 0
    default:
      return (((col + row) % 2) + ((col * row) % 3)) % 2 === 0
  }
}

/**
 * Накладывает маску на клетки данных; сама себе обратна — второй вызов с тем же номером
 * возвращает всё как было, и на этом держится примерка всех восьми масок на одной сетке.
 */
function hide(grid: Uint8Array, fixed: Uint8Array, size: number, mask: number): void {
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const cell = row * size + col
      if (fixed[cell] === 1) continue
      if (!bend(mask, row, col)) continue
      grid[cell] = nth(grid, cell) ^ 1
    }
  }
}

/** Пишет сведения о формате — стойкость и номер маски — двумя копиями. */
function format(grid: Uint8Array, fixed: Uint8Array, size: number, mask: number): void {
  const seed = (LEVEL_BITS << 3) | mask
  let rem = seed
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const bits = ((seed << 10) | rem) ^ 0x5412

  const set = (row: number, col: number, on: boolean) => {
    grid[row * size + col] = on ? 1 : 0
    fixed[row * size + col] = 1
  }
  const bit = (i: number) => ((bits >>> i) & 1) === 1

  for (let i = 0; i <= 5; i++) set(i, 8, bit(i))
  set(7, 8, bit(6))
  set(8, 8, bit(7))
  set(8, 7, bit(8))
  for (let i = 9; i < 15; i++) set(8, 14 - i, bit(i))

  for (let i = 0; i < 8; i++) set(8, size - 1 - i, bit(i))
  for (let i = 8; i < 15; i++) set(size - 15 + i, 8, bit(i))

  // Всегда тёмная клетка над левым нижним искателем.
  set(size - 8, 8, true)
}

/**
 * Штраф полосы: длинные одноцветные серии и узор 1:1:3:1:1, который камера принимает за искатель.
 */
function lineScore(grid: Uint8Array, size: number, index: number, byRow: boolean): number {
  let score = 0
  let run = 1
  let last = -1
  let window = 0

  for (let i = 0; i < size; i++) {
    const one = byRow ? nth(grid, index * size + i) : nth(grid, i * size + index)

    if (one === last) {
      run++
      if (run === 5) score += 3
      else if (run > 5) score += 1
    } else {
      run = 1
      last = one
    }

    // Одиннадцать клеток узора 1:1:3:1:1 с полем сбоку камера принимает за искатель.
    window = ((window << 1) | one) & 0x7ff
    if (i >= 10 && (window === 0x5d0 || window === 0x05d)) score += 40
  }

  return score
}

/**
 * Насколько картинка неудобна камере: серии, квадраты, ложные искатели, перекос; точность не критична.
 */
function penalty(grid: Uint8Array, size: number): number {
  let score = 0

  for (let i = 0; i < size; i++) {
    score += lineScore(grid, size, i, true)
    score += lineScore(grid, size, i, false)
  }

  for (let row = 0; row + 1 < size; row++) {
    for (let col = 0; col + 1 < size; col++) {
      const one = nth(grid, row * size + col)
      const same =
        one === nth(grid, row * size + col + 1) &&
        one === nth(grid, (row + 1) * size + col) &&
        one === nth(grid, (row + 1) * size + col + 1)
      if (same) score += 3
    }
  }

  let dark = 0
  for (let i = 0; i < size * size; i++) if (grid[i] === 1) dark++
  const off = Math.abs(dark * 100 - size * size * 50)
  score += Math.floor(off / (size * size * 5)) * 10

  return score
}

/**
 * Строит код по строке: версия — меньшая из годных (крупнее клетки — читается с телевизора через полкомнаты).
 * Все 8 масок примеряются по очереди, победитель вписывается в сведения о формате — иначе читатель не узнает, что снимать.
 */
export function makeQr(text: string): QrDone {
  const bytes = utf8(text)
  if (bytes.length === 0) return { ok: false, problem: 'Пустую строку в код не превратить' }

  let version = 0
  for (let v = 1; v <= MAX_VERSION; v++) {
    if (bytes.length <= bytesFit(v)) {
      version = v
      break
    }
  }

  if (version === 0) {
    return {
      ok: false,
      problem: `Строка длиннее ${bytesFit(MAX_VERSION)} байт: такой код здесь не рисуется`,
    }
  }

  const size = 17 + 4 * version
  const grid = new Uint8Array(size * size)
  const fixed = new Uint8Array(size * size)

  frame(grid, fixed, size, version)
  fill(grid, fixed, size, weave(bytes, version))

  let best = 0
  let bestScore = Number.POSITIVE_INFINITY
  for (let mask = 0; mask < 8; mask++) {
    hide(grid, fixed, size, mask)
    format(grid, fixed, size, mask)
    const score = penalty(grid, size)
    if (score < bestScore) {
      bestScore = score
      best = mask
    }
    hide(grid, fixed, size, mask)
  }

  hide(grid, fixed, size, best)
  format(grid, fixed, size, best)

  const dark: boolean[][] = []
  for (let row = 0; row < size; row++) {
    const line: boolean[] = []
    for (let col = 0; col < size; col++) line.push(grid[row * size + col] === 1)
    dark.push(line)
  }

  return { ok: true, value: { size, version, dark } }
}

/**
 * Разметка SVG: чёрный на белом нарочно — камера читает разницу яркостей; размер решает вёрстка, один путь вместо сотен прямоугольников.
 */
export function qrSvg(code: QrCode, look: QrLook = {}): string {
  const quiet = look.quiet ?? 4
  const dark = look.dark ?? '#000000'
  const light = look.light ?? '#ffffff'
  const side = code.size + quiet * 2

  const parts: string[] = []
  for (let row = 0; row < code.size; row++) {
    const line = code.dark[row] ?? []
    for (let col = 0; col < code.size; col++) {
      if (line[col] === true) parts.push(`M${col + quiet} ${row + quiet}h1v1h-1z`)
    }
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" ` +
    'shape-rendering="crispEdges" role="img" aria-label="Код для входа">' +
    `<rect width="${side}" height="${side}" fill="${light}" />` +
    `<path d="${parts.join('')}" fill="${dark}" />` +
    '</svg>'
  )
}
