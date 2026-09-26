// Календарь выхода на Главной: своя неделя по дням, с понедельника по местным суткам (по UTC утренний выход уехал бы во вчера); прошедшие дни не выкидываются. Расписание — один запрос на неделю (`api/anilist-schedule`), имя по старшинству (`core/media-title`), обложка — из `core/media-looks`.
// Метку доступности ставит один Kodik (входит по номеру MAL, номера берутся лестницей `fetchMalIds`), спрашивается показанный день целиком; области — «Моё» (всё кроме брошенного) и «Популярное». Отбор 18+ стоит на входе: спрятанное не тянет доборы.
import { computed, ref, type ComputedRef, type Ref } from 'vue'

import { fetchMalIds } from '@/api/anilist-media'
import { fetchAiringSchedules, fetchPopularOngoing, type AiringEntry } from '@/api/anilist-schedule'
import { adultAllowed, hiddenCount, keepAllowed } from '@/core/adult'
import { peekLook, warmLooks } from '@/core/media-looks'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import {
  onPlayableChange,
  peekPlayable,
  primePlayable,
  requestPlayable,
  type PlayAsk,
  type PlayState,
} from '@/core/playable'
import { Logger } from '@/utils/logger'

import { statusList } from '../labels'

/** Подписи дней коротко. У JS неделя идёт с воскресенья, поэтому порядок свой. */
const DAY_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'] as const

/** Те же дни полностью: для подписи клетки. */
const DAY_FULL = [
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
  'воскресенье',
] as const

/** Месяцы в родительном падеже: «21 сентября», а не «21 сентябрь». */
const MONTHS = [
  'января',
  'февраля',
  'марта',
  'апреля',
  'мая',
  'июня',
  'июля',
  'августа',
  'сентября',
  'октября',
  'ноября',
  'декабря',
] as const

/** Сколько дней в полосе. */
const WEEK_DAYS = 7

/** По скольку имён просить за заход: источники отвечают по одному. */
const NAME_CHUNK = 6

/** Сколько имён добираем за показ дня: 24 покрывают замеренный день, это четыре захода по шесть. */
const NAME_LIMIT = 24

/** Сколько идущих брать для чужого показа: сотня даёт 81 выход за неделю, 150 добавляет лишь три. */
const POPULAR_LIMIT = 100

/** Область показа календаря. */
export type CalendarScope = 'mine' | 'popular'

/** Закладки календаря: берутся из общего словаря, иначе новый статус молча выпал бы из отбора. */
export const OWN_STATUSES: readonly string[] = statusList()
  .map((item) => item.key)
  .filter((key) => key !== 'DROPPED')

/** Один выход в строке календаря: поля названы так, как их зовёт плитка. */
export interface WeekRow {
  /** Ключ строки: тайтл и срок. */
  key: string
  mediaId: number
  episode: number
  /** Срок выхода в миллисекундах: по нему идёт порядок внутри дня. */
  at: number
  /** Час выхода: «19:30». */
  time: string
  title: string
  /** Подпись под названием: «19:30 · серия 7», а у вышедшей — «вышла · серия 7». */
  facts: string
  /** Обложка постера. До добора её нет, и плитка покажет букву названия. */
  cover: string | null
  /** Цвет обложки: подложка, пока картинка едет. */
  color: string | null
  /** Есть ли выход у источников видео. `null` — ещё не спрашивали, и знака не будет. */
  play: PlayState | null
  /** Серия уже вышла. */
  aired: boolean
}

/** День полосы. */
export interface WeekDay {
  /** Начало местных суток: и ключ дня, и то, по чему его выбирают. */
  key: number
  /** «Пн». */
  word: string
  /** «16». */
  num: string
  /** Полная подпись для подсказки: «среда, 16 сентября». */
  title: string
  /** Сегодня ли это. */
  today: boolean
  /** День уже прошёл: выходы в нём уже вышли. */
  past: boolean
  rows: WeekRow[]
}

/** Начало местных суток. По нему дни и различаются. */
export function dayStart(stamp: number): number {
  const date = new Date(stamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Сдвиг на дни через `setDate`: в сутках не всегда ровно 86 400 000 мс. */
export function addDays(stamp: number, days: number): number {
  const date = new Date(stamp)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/** Начало недели, в которой лежит срок: понедельник, местные сутки. */
export function weekStart(stamp: number): number {
  const date = new Date(dayStart(stamp))
  const shift = (date.getDay() - 1 + WEEK_DAYS) % WEEK_DAYS
  return addDays(date.getTime(), -shift)
}

/** Час выхода по местным часам, а не toLocaleTimeString: тот на чужих настройках даёт 12-часовой вид. */
export function hourText(stamp: number): string {
  const date = new Date(stamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Подпись недели «15 — 21 сентября»: месяц и год — только когда они разные. */
export function weekText(start: number): string {
  const from = new Date(start)
  const to = new Date(addDays(start, WEEK_DAYS - 1))

  const fromMonth = MONTHS[from.getMonth()] ?? ''
  const toMonth = MONTHS[to.getMonth()] ?? ''

  if (from.getMonth() === to.getMonth()) {
    return `${from.getDate()} — ${to.getDate()} ${fromMonth}`
  }

  if (from.getFullYear() === to.getFullYear()) {
    return `${from.getDate()} ${fromMonth} — ${to.getDate()} ${toMonth}`
  }

  return (
    `${from.getDate()} ${fromMonth} ${from.getFullYear()} — ` +
    `${to.getDate()} ${toMonth} ${to.getFullYear()}`
  )
}

/** Имя выхода по старшинству: русское знание, название сервера, номер тайтла (честный ответ, не заглушка). */
function titleOf(entry: AiringEntry): string {
  return (
    peekRussianName(entry.mediaId) ?? entry.romaji ?? entry.english ?? `Аниме #${entry.mediaId}`
  )
}

/** Подпись под названием: час и серия, а у вышедшей — «вышла»: час у вышедшего ничего не решает. */
function factsOf(episode: number, time: string, aired: boolean): string {
  return aired ? `вышла · серия ${episode}` : `${time} · серия ${episode}`
}

/** Выход сервера в строку календаря. */
function toRow(entry: AiringEntry, at: number): WeekRow {
  const look = peekLook(entry.mediaId)
  const time = hourText(at)
  const aired = at <= Date.now()

  return {
    key: `${entry.mediaId}|${entry.airingAt}`,
    mediaId: entry.mediaId,
    episode: entry.episode,
    at,
    time,
    title: titleOf(entry),
    facts: factsOf(entry.episode, time, aired),
    cover: look?.cover ?? null,
    color: look?.color ?? null,
    play: peekPlayable(entry.mediaId),
    aired,
  }
}

/** Раскладывает выходы по семи дням: пустые дни тоже строятся — клетка без выходов говорит «здесь ничего». */
export function buildDays(entries: AiringEntry[], start: number, today: number): WeekDay[] {
  const buckets = new Map<number, WeekRow[]>()

  for (const entry of entries) {
    const at = entry.airingAt * 1000
    const key = dayStart(at)
    const bucket = buckets.get(key)

    if (bucket === undefined) buckets.set(key, [toRow(entry, at)])
    else bucket.push(toRow(entry, at))
  }

  const out: WeekDay[] = []

  for (let i = 0; i < WEEK_DAYS; i += 1) {
    const key = addDays(start, i)
    const date = new Date(key)
    const rows = buckets.get(key) ?? []
    rows.sort((a, b) => a.at - b.at)

    out.push({
      key,
      word: DAY_SHORT[i] ?? '',
      num: String(date.getDate()),
      title: `${DAY_FULL[i] ?? ''}, ${date.getDate()} ${MONTHS[date.getMonth()] ?? ''}`.trim(),
      today: key === today,
      past: key < today,
      rows,
    })
  }

  return out
}

/** Всё, что разметка календаря берёт готовым. */
export interface HomeCalendar {
  /** Идёт запрос расписания. */
  busy: Ref<boolean>
  /** Расписание не пришло: без отметки пустая полоса читалась бы как «ничего не выходит». */
  failed: Ref<boolean>
  days: ComputedRef<WeekDay[]>
  /** Выбранный день. Ноль — «тот, что сегодня». */
  picked: Ref<number>
  shown: ComputedRef<WeekDay | null>
  /** Подпись недели: «15 — 21 сентября». */
  span: ComputedRef<string>
  /** Чья неделя показывается. */
  scope: Ref<CalendarScope>
  /** Сколько выходов спрятал отбор 18+: подпись под календарём иначе читалась бы как «ничего не выходит». */
  hidden: Ref<number>
  /** Дни, где выходы спрятал отбор (ключ — начало суток): иначе пустой день говорит «ничего не выходит». */
  hiddenDays: Ref<Set<number>>
  pick: (key: number) => void
  /** Смена области показа; выбранный день не трогается: четверг остаётся четвергом. */
  setScope: (next: CalendarScope, mediaIds: number[]) => Promise<void>
  load: (mediaIds: number[]) => Promise<void>
}

const entries = ref<AiringEntry[]>([])
const busy = ref(false)
const failed = ref(false)
const picked = ref(0)
const scope = ref<CalendarScope>('mine')
const startKey = ref(0)
const todayKey = ref(0)
const hidden = ref(0)
const hiddenDays = ref<Set<number>>(new Set())

/** Счётчик добора: `peek*` не реактивны, и без него полка не пересобралась бы с приходом имени или метки. */
const stamp = ref(0)

/** Номера заходов: старый видит по своему номеру, что его ответ уже не нужен. */
let run = 0
let nameRun = 0
let coverRun = 0
let playRun = 0

/** Верхушка идущих на время сеанса: за неделю не меняется, а стоит двух запросов; гибнет вместе с окном. */
let popularIds: number[] = []

const days = computed<WeekDay[]>(() => {
  void stamp.value
  return startKey.value === 0 ? [] : buildDays(entries.value, startKey.value, todayKey.value)
})

/** Показанный день: выбранный, а если его нет в неделе — сегодняшний (смена недели сама сбрасывает выбор). */
const shown = computed<WeekDay | null>(() => {
  const list = days.value
  if (list.length === 0) return null

  return (
    list.find((day) => day.key === picked.value) ?? list.find((day) => day.today) ?? list[0] ?? null
  )
})

const span = computed<string>(() => (startKey.value === 0 ? '' : weekText(startKey.value)))

/** Русские имена выходов показанного дня (не всей недели): за неделю набралось бы восемь десятков запросов.
 * Экран из-за имени не держим — имя приедет и перерисует полку. */
async function warmNames(): Promise<void> {
  const mine = ++nameRun
  const day = shown.value
  if (day === null) return

  const wanted = [
    ...new Set(
      day.rows.filter((row) => peekRussianName(row.mediaId) === null).map((row) => row.mediaId),
    ),
  ].slice(0, NAME_LIMIT)

  if (wanted.length === 0) return

  try {
    for (let from = 0; from < wanted.length; from += NAME_CHUNK) {
      if (mine !== nameRun) return

      await prefetchRussianNames(wanted.slice(from, from + NAME_CHUNK))
      if (mine !== nameRun) return

      stamp.value += 1
    }
  } catch (e) {
    // Без перевода название останется на латинице — это не повод ругаться.
    Logger('WARN', 'Календарь: русские названия добрать не вышло', e)
  }
}

/** Обложки выходов показанного дня. Потолка нет: выписки едут пачкой до пятидесяти,
 * а `warmLooks` сам помнит спрошенное — повторный зов ничего не стоит. */
async function warmCovers(): Promise<void> {
  const mine = ++coverRun
  const day = shown.value
  if (day === null) return

  const wanted = [
    ...new Set(day.rows.filter((row) => row.cover === null).map((row) => row.mediaId)),
  ]

  if (wanted.length === 0) return

  try {
    const added = await warmLooks(wanted)
    if (mine !== coverRun || added === 0) return

    stamp.value += 1
  } catch (e) {
    // Без обложки плитка останется с буквой названия — это не повод ругаться.
    Logger('WARN', 'Календарь: обложки добрать не вышло', e)
  }
}

/** Выходы недели, попавшие в этот день: у выхода с сервера есть оба названия,
 * у строки — только победившее в старшинстве, а источнику нужно столько, сколько есть. */
function entriesOf(dayKey: number): AiringEntry[] {
  return entries.value.filter((entry) => dayStart(entry.airingAt * 1000) === dayKey)
}

/** Вопрос источникам по одному выходу: по делу нужен номер MAL — метку ставит Kodik, входит только по номеру
 * Шикимори; `airing: true` — факт: у идущего срок хранения отказа короче. */
function askOf(entry: AiringEntry, malId: number | null): PlayAsk {
  const look = peekLook(entry.mediaId)
  const names = [peekRussianName(entry.mediaId), entry.romaji, entry.english, look?.romaji]

  return {
    mediaId: entry.mediaId,
    malId,
    titles: [
      ...new Set(names.filter((name): name is string => typeof name === 'string' && name !== '')),
    ],
    year: look?.seasonYear ?? undefined,
    airing: true,
  }
}

/** Метки доступности выходов показанного дня: склад первым и по всем номерам разом. Номера MAL для Kodik идут
 * лестницей `fetchMalIds`, запрос общий с добором имён. */
async function warmPlay(): Promise<void> {
  const mine = ++playRun
  const day = shown.value
  if (day === null) return

  const wanted = entriesOf(day.key).filter((entry) => peekPlayable(entry.mediaId) === null)
  if (wanted.length === 0) return

  try {
    const primed = await primePlayable(wanted.map((entry) => entry.mediaId))
    if (mine !== playRun) return
    if (primed > 0) stamp.value += 1

    const left = wanted.filter((entry) => peekPlayable(entry.mediaId) === null)
    if (left.length === 0) return

    const malIds = await fetchMalIds(left.map((entry) => entry.mediaId))
    if (mine !== playRun) return

    requestPlayable(left.map((entry) => askOf(entry, malIds.get(entry.mediaId) ?? null)))
  } catch (e) {
    // Без метки плитка останется без знака — так и задумано, а не с ложным.
    Logger('WARN', 'Календарь: метки доступности не доехали', e)
  }
}

/** Подписка на ответы о доступности живёт с модулем, а не с экраном: неделя переживает уход с Главной, и метка
 * обязана быть на месте при возврате; перерисовка — только когда неделя собрана. */
onPlayableChange(() => {
  if (startKey.value === 0 || entries.value.length === 0) return

  stamp.value += 1
})

/** Номера для запроса расписания: свои из списка или верхушка популярности (берётся раз за сеанс). */
async function idsFor(mediaIds: number[]): Promise<number[]> {
  if (scope.value === 'mine') return mediaIds

  if (popularIds.length === 0) popularIds = await fetchPopularOngoing(POPULAR_LIMIT)
  return popularIds
}

/** Собирает неделю. Полоса рисуется сразу, до сети: дни — это календарь. Границы окна AniList расширены на
 * секунду внутрь: серия ровно в полночь иначе осталась бы за бортом. */
async function fetchWeek(mediaIds: number[]): Promise<void> {
  const mine = ++run
  failed.value = false
  busy.value = true

  try {
    const ids = await idsFor(mediaIds)
    if (mine !== run) return

    if (ids.length === 0) {
      entries.value = []
      hidden.value = 0
      hiddenDays.value = new Set()
      return
    }

    const from = Math.floor(startKey.value / 1000) - 1
    const to = Math.floor(addDays(startKey.value, WEEK_DAYS) / 1000) + 1
    const found = await fetchAiringSchedules(ids, from, to)
    if (mine !== run) return

    // Отбор взрослого стоит здесь, до доборов: спрятанный выход не тянет
    // за собой ни имени, ни обложки, ни вопроса о доступности.
    hidden.value = hiddenCount(found, (entry) => entry.isAdult)

    const hushed = new Set<number>()
    for (const entry of found) {
      if (!adultAllowed(entry.isAdult)) hushed.add(dayStart(entry.airingAt * 1000))
    }
    hiddenDays.value = hushed

    entries.value = keepAllowed(found, (entry) => entry.isAdult) as AiringEntry[]

    void warmNames()
    void warmCovers()
    void warmPlay()
  } catch (e) {
    if (mine !== run) return

    Logger('WARN', 'Календарь: расписание не пришло', e)
    entries.value = []
    hidden.value = 0
    hiddenDays.value = new Set()
    failed.value = true
  } finally {
    if (mine === run) busy.value = false
  }
}

/** Первая сборка недели: неделя ставится по текущему мгновению, выбор сбрасывается. */
async function load(mediaIds: number[]): Promise<void> {
  startKey.value = weekStart(Date.now())
  todayKey.value = dayStart(Date.now())
  picked.value = 0

  await fetchWeek(mediaIds)
}

/** Смена области показа: повторное нажатие ничего не делает, если показ не пуст — пустой лечится повтором. */
async function setScope(next: CalendarScope, mediaIds: number[]): Promise<void> {
  if (scope.value === next && entries.value.length > 0) return

  // Прежний показ уходит сразу: иначе строки прошлой области висели бы под новой
  // подписью и выглядели бы как «переключатель не сработал».
  entries.value = []
  hidden.value = 0
  hiddenDays.value = new Set()
  scope.value = next

  await fetchWeek(mediaIds)
}

/** Выбор дня: полке тут же нужны имена, обложки и метки того, что в нём выходит. */
function pick(key: number): void {
  picked.value = key
  void warmNames()
  void warmCovers()
  void warmPlay()
}

/** Состояние одно на приложение: знание о неделе переживает уход на другой экран и возврат. */
export function useHomeCalendar(): HomeCalendar {
  return {
    busy,
    failed,
    days,
    picked,
    shown,
    span,
    scope,
    hidden,
    hiddenDays,
    pick,
    setScope,
    load,
  }
}
