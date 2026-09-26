// Россыпь мелких сакур на плашке приветствия. Число из свободного места: плашка делится на клетки, задевающие текст или розетку, отбрасываются; шире окно — гуще россыпь, длинная фраза — реже. Шум считается из номера клетки и соли запуска, а не из Math.random: перетаскивание окна не мигало бы раскладкой, но каждый запуск даёт новый рисунок.
// Три глубины: крупные бледные сзади, мелкие плотные спереди, дальние плывут медленнее — плоская россыпь читалась бы наклейками.

/** Клетка, из которой выходит густота россыпи. */
const CELL_W = 132
const CELL_H = 76

/** Зазор от строки и от розетки: цветок не должен липнуть к тексту. */
const PAD = 18

/** Отношение высоты кадра розетки к его ширине. */
const TALL = 38.2 / 34.2

interface Depth {
  name: string
  min: number
  max: number
  swing: number
  pace: number
}

// Размах и длительность — по видимости: прежние «пять пикселей за полминуты» давали 0,17 px/с, движения не видно.
// Ближний проходит размах секунд за десять, дальний вдвое медленнее и меньшим размахом — подобие объёма.
const DEPTHS: ReadonlyArray<Depth> = [
  { name: 'far', min: 44, max: 62, swing: 0.7, pace: 1.5 },
  { name: 'mid', min: 28, max: 40, swing: 1, pace: 1.1 },
  { name: 'near', min: 18, max: 26, swing: 1.3, pace: 0.8 },
]

const MID = DEPTHS[1] ?? { name: 'mid', min: 28, max: 40, swing: 1, pace: 1.2 }

/** Запретная область в координатах плашки. */
export interface KeepOut {
  x: number
  y: number
  w: number
  h: number
}

export interface Grain {
  key: number
  depth: string
  left: number
  top: number
  size: number
  tall: number
  turn: number
  /** Покачивание в градусах: цветок поворачивается на ±rot вокруг turn. */
  rot: number
  fx: number
  fy: number
  tx: number
  ty: number
  dur: number
  delay: number
}

// Соль запуска: одна на всё время работы, оттого пересчёт при изменении
// размера не меняет рисунок, а следующий запуск даёт другой.
let salt = -1

function seasoning(): number {
  if (salt < 0) salt = Math.random() * 997
  return salt
}

/** Шум от 0 до 1 по номеру клетки и каналу. */
function noise(at: number, channel: number): number {
  const raw = Math.sin((at + 1) * 12.9898 + (channel + 1) * 78.233 + seasoning()) * 43758.5453
  return raw - Math.floor(raw)
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}

function blocked(box: KeepOut, shut: ReadonlyArray<KeepOut>): boolean {
  for (const cell of shut) {
    const apart =
      box.x + box.w < cell.x - PAD ||
      box.x > cell.x + cell.w + PAD ||
      box.y + box.h < cell.y - PAD ||
      box.y > cell.y + cell.h + PAD
    if (!apart) return true
  }
  return false
}

/** Раскладка россыпи для плашки `w` × `h`; `shut` — занятые области (строка с кнопками и крупная розетка). */
export function sprayGrains(w: number, h: number, shut: ReadonlyArray<KeepOut>): Grain[] {
  if (w <= 0 || h <= 0) return []

  const cols = Math.max(1, Math.floor(w / CELL_W))
  const rows = Math.max(1, Math.round(h / CELL_H))
  const cw = w / cols
  const ch = h / rows
  const out: Grain[] = []

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const at = row * cols + col
      const depth = DEPTHS[Math.floor(noise(at, 0) * DEPTHS.length)] ?? MID
      const size = depth.min + noise(at, 1) * (depth.max - depth.min)
      const tall = size * TALL
      const left = clamp(
        col * cw + cw / 2 - size / 2 + (noise(at, 2) - 0.5) * cw * 0.44,
        -8,
        w - size + 8,
      )
      const top = clamp(
        row * ch + ch / 2 - tall / 2 + (noise(at, 3) - 0.5) * ch * 0.4,
        -8,
        h - tall + 8,
      )

      const swing = (10 + noise(at, 4) * 12) * depth.swing

      // Запрету подлежит не сам цветок, а вся площадь, которую он пройдёт:
      // иначе за время движения он наезжал бы на строку и на розетку.
      const walk = {
        x: left - swing,
        y: top - swing * 0.6,
        w: size + swing * 2,
        h: tall + swing * 1.2,
      }
      if (blocked(walk, shut)) continue

      const dx = noise(at, 5) * 2 - 1
      const dy = noise(at, 6) * 2 - 1

      out.push({
        key: at,
        depth: depth.name,
        left: round(left),
        top: round(top),
        size: round(size),
        tall: round(tall),
        turn: round((noise(at, 7) * 2 - 1) * 60),
        rot: round(5 * depth.swing),
        fx: round(-dx * swing),
        fy: round(-dy * swing * 0.6),
        tx: round(dx * swing),
        ty: round(dy * swing * 0.6),
        dur: round((8 + noise(at, 8) * 10) * depth.pace),
        delay: round(-noise(at, 9) * 12),
      })
    }
  }

  return out
}
