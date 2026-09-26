// Ввод экрана просмотра: пульт приезжает обычной клавиатурой. Здесь только ввод и фокус;
// что делать с желанием, решает экран.
import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

/** Чего человек хочет. Чем нажато — клавишей, пультом, мышью — уже неважно. */
export type PlayerIntent =
  | 'toggle'
  | 'seekBack'
  | 'seekAhead'
  | 'jumpBack'
  | 'jumpAhead'
  | 'louder'
  | 'quieter'
  | 'mute'
  | 'slower'
  | 'faster'
  | 'prevEpisode'
  | 'nextEpisode'
  | 'skip'
  | 'fullscreen'
  | 'pip'
  | 'cast'
  | 'exit'
  | 'focusUp'
  | 'focusDown'
  | 'focusLeft'
  | 'focusRight'

/** Шаг перемотки: стрелки на полосе времени и клавиши J/L. */
export const STEP_SEC = 10

/** Большой шаг: те же клавиши с Shift и клавиши страниц. */
export const JUMP_SEC = 60

/** Шаг громкости. Пятая часть: мелкие деления с дивана не поймать. */
export const VOLUME_STEP = 0.2

/** Сколько тишины до того, как панель уедет с кадра. */
export const CALM_DELAY_MS = 3200

/** Скорости списком, а не арифметикой: доли копят ошибку двоичных чисел; выше двух речь неразборчива. */
export const RATES: ReadonlyArray<number> = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]

/** Обычная скорость. К ней возвращает нажатие на текущую строку меню. */
export const NORMAL_RATE = 1

/** Громкость помнится на запуск, как и скорость. Это не настройка. */
let volumeMark = 1

let rateMark: number = NORMAL_RATE

export function peekVolume(): number {
  return volumeMark
}

export function rememberVolume(value: number): void {
  volumeMark = Math.min(1, Math.max(0, value))
}

export function peekRate(): number {
  return rateMark
}

export function rememberRate(value: number): void {
  const first = RATES[0] ?? NORMAL_RATE
  const last = RATES[RATES.length - 1] ?? NORMAL_RATE
  rateMark = Math.min(last, Math.max(first, value))
}

/** Следующая скорость в сторону step; крайние упираются, а не замыкаются в кольцо: иначе промах. */
export function stepRate(current: number, step: number): number {
  const at = RATES.indexOf(current)

  // Скорость со стороны (например, из прошлого кадра) — ищем ближайшую.
  if (at < 0) {
    const near = RATES.reduce(
      (best, rate) => (Math.abs(rate - current) < Math.abs(best - current) ? rate : best),
      NORMAL_RATE,
    )
    return near
  }

  const goal = Math.min(RATES.length - 1, Math.max(0, at + step))
  return RATES[goal] ?? NORMAL_RATE
}

/** Подпись скорости: целые без дробного хвоста, знак умножения — не буква x. */
export function rateLabel(rate: number): string {
  const text = Number.isInteger(rate) ? String(rate) : String(rate).replace('.', ',')
  return `${text}\u00d7`
}

/** Набор текста главнее любых наших клавиш. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
}

/** Читает нажатие. `inList` — там стрелки и «ОК» заняты списком, перехват = двойное срабатывание. */
export function readIntent(event: KeyboardEvent, inList: boolean): PlayerIntent | null {
  if (event.altKey || event.ctrlKey || event.metaKey) return null
  if (typing(event.target)) return null

  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key

  switch (key) {
    case ' ':
    case 'Enter':
      return inList ? null : 'toggle'
    case 'k':
    case 'л':
    case 'MediaPlayPause':
    case 'MediaPlay':
    case 'MediaPause':
      return 'toggle'
    case 'ArrowLeft':
      if (inList) return 'focusLeft'
      return event.shiftKey ? 'jumpBack' : 'seekBack'
    case 'ArrowRight':
      if (inList) return 'focusRight'
      return event.shiftKey ? 'jumpAhead' : 'seekAhead'
    case 'ArrowUp':
      return inList ? 'focusUp' : 'louder'
    case 'ArrowDown':
      return inList ? 'focusDown' : 'quieter'
    case 'j':
    case 'о':
      return event.shiftKey ? 'jumpBack' : 'seekBack'
    case 'l':
    case 'д':
      return event.shiftKey ? 'jumpAhead' : 'seekAhead'
    case 'PageUp':
      return 'jumpBack'
    case 'PageDown':
      return 'jumpAhead'
    case 'm':
    case 'ь':
      return 'mute'
    // Скорость двумя парами клавиш: квадратные скобки как в плеерах на ПК,
    // угловые как в вебе. Кириллица рядом — те же физические клавиши.
    case '[':
    case ',':
    case '<':
    case 'х':
    case 'б':
      return 'slower'
    case ']':
    case '.':
    case '>':
    case 'ъ':
    case 'ю':
      return 'faster'
    case 'f':
    case 'а':
    case 'F11':
      return 'fullscreen'
    // i — окно поверх всего (image in image), c — трансляция (cast): буквы из веба, их жмут в чужих плеерах.
    case 'i':
    case 'ш':
      return 'pip'
    case 'c':
    case 'с':
      return 'cast'
    case 's':
    case 'ы':
      return 'skip'
    case 'n':
    case 'т':
    case 'MediaTrackNext':
      return 'nextEpisode'
    case 'p':
    case 'з':
    case 'MediaTrackPrevious':
      return 'prevEpisode'
    case 'Escape':
    case 'Backspace':
    case 'BrowserBack':
      return 'exit'
    default:
      return null
  }
}

/** Зона фокуса и ось, вдоль которой внутри неё ходят. */
interface Zone {
  name: string
  along: 'row' | 'column'
}

/** Порядок зон; поперёк оси стрелка ведёт в соседнюю. Список задан руками, геометрию не угадываем. */
const ZONES: Zone[] = [
  { name: 'head', along: 'row' },
  { name: 'bar', along: 'row' },
  { name: 'voices', along: 'column' },
  { name: 'episodes', along: 'column' },
]

/** Что вообще принимает фокус. Отключённые кнопки в счёт не идут. */
const ITEMS = 'button:not([disabled]), [tabindex="0"]'

/** Где фокус стоял в каждой зоне: возврат не начинает с первой кнопки. */
const marks = new Map<string, number>()

function itemsOf(root: ParentNode, name: string): HTMLElement[] {
  const box = root.querySelector(`[data-zone="${name}"]`)
  return box === null ? [] : Array.from(box.querySelectorAll<HTMLElement>(ITEMS))
}

/** Ставит фокус в зону, зажимая номер по краям. */
function land(root: ParentNode, name: string, index: number): boolean {
  const items = itemsOf(root, name)
  if (items.length === 0) return false

  const at = Math.min(items.length - 1, Math.max(0, index))
  const item = items[at]
  if (item === undefined) return false

  marks.set(name, at)
  item.focus()
  return true
}

/** Ближайшая непустая зона в сторону step: озвучек или серий может не быть. */
function nextZone(root: ParentNode, from: number, step: number): Zone | null {
  for (let at = from + step; at >= 0 && at < ZONES.length; at += step) {
    const zone = ZONES[at]
    if (zone !== undefined && itemsOf(root, zone.name).length > 0) return zone
  }

  return null
}

/** Водит фокус стрелками; true — нажатие наше, иначе страница уедет прокруткой. */
export function moveFocus(root: ParentNode, intent: PlayerIntent): boolean {
  const active = document.activeElement
  const here = active instanceof HTMLElement ? active : null
  const box = here === null ? null : here.closest<HTMLElement>('[data-zone]')
  const name = box === null ? '' : (box.dataset.zone ?? '')
  const at = ZONES.findIndex((zone) => zone.name === name)
  const zone = at < 0 ? undefined : ZONES[at]

  // Фокус нигде: любая стрелка ставит его на панель, ближе всего к делу.
  if (zone === undefined) return land(root, 'bar', marks.get('bar') ?? 0)

  const items = itemsOf(root, name)
  const index = here === null ? -1 : items.indexOf(here)
  const along = zone.along === 'row'

  if (intent === (along ? 'focusLeft' : 'focusUp')) return land(root, name, index - 1)
  if (intent === (along ? 'focusRight' : 'focusDown')) return land(root, name, index + 1)

  const step = intent === 'focusUp' || intent === 'focusLeft' ? -1 : 1
  const goal = nextZone(root, at, step)

  // На краю нажатие всё равно наше: прокрутке страницы здесь делать нечего.
  return goal === null ? true : land(root, goal.name, marks.get(goal.name) ?? 0)
}

/** Полный экран окна через оболочку, а не requestFullscreen: тот разворачивал окно сам,
 * и следующий переключатель видел «уже развернуто» и складывал его обратно. */
export async function toggleWindowFullscreen(): Promise<boolean> {
  try {
    return await Bridge.shell.toggleFullscreen()
  } catch (e) {
    Logger('WARN', 'Плеер: оболочка не дала полный экран', e)
    return false
  }
}
