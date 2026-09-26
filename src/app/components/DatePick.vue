<script setup lang="ts">
// Поле даты со своим календарём: родное <input type="date"> выбивалось из оформления, «стереть» не умеет.
// Дата ходит строкой ГГГГ-ММ-ДД; календарь раскрывается на месте, без всплывающего слоя в body.
import { computed, ref, watch } from 'vue'

/** Месяцы для заголовка: именительный падеж. */
const MONTHS: ReadonlyArray<string> = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
]

/** Месяцы для подписи выбранного: родительный, «14 мая 2025». */
const MONTHS_OF: ReadonlyArray<string> = [
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
]

/** Неделя с понедельника: у нас так, а getDay() считает с воскресенья. */
const WEEK: ReadonlyArray<string> = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс']

/** Шесть рядов по семь. Сетка постоянной высоты не прыгает между месяцами. */
const CELLS = 42

/** Сколько годов в сетке: четыре ряда по три, чтобы не растягивать поле. */
const YEARS_PAGE = 12

/** Края годов: до телевидения аниме не показывали, вперёд хватает пары лет. */
const YEAR_MIN = 1940
const YEAR_AHEAD = 2

/** Одна клетка сетки. Готовится заранее: в разметке считать нечего. */
interface DayCell {
  iso: string
  day: number
  /** Хвост соседнего месяца: показываем бледным, но нажимать даём. */
  out: boolean
  now: boolean
  on: boolean
}

const props = defineProps<{
  /** ГГГГ-ММ-ДД. Пустая строка и null значат «дата не стоит». */
  value: string | null
  /** Имя поля: уходит в подписи для чтецов с экрана. */
  title: string
}>()

const emit = defineEmits<{
  (e: 'pick', value: string): void
}>()

function pad(value: number): string {
  return value < 10 ? `0${value}` : String(value)
}

function stamp(year: number, month: number, day: number): string {
  return `${year}-${pad(month + 1)}-${pad(day)}`
}

/** Разбор строки. Всё, что не похоже на дату, считаем отсутствием даты. */
function parse(text: string | null): { year: number; month: number; day: number } | null {
  if (text === null) return null

  const hit = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (hit === null) return null

  const month = Number(hit[2]) - 1
  const day = Number(hit[3])
  if (month < 0 || month > 11 || day < 1 || day > 31) return null

  return { year: Number(hit[1]), month, day }
}

function todayStamp(): string {
  const now = new Date()
  return stamp(now.getFullYear(), now.getMonth(), now.getDate())
}

const open = ref(false)

/** Раскрыта ли сетка годов вместо сетки дней. */
const picking = ref(false)

// Раскрытый календарь показывает месяц выбранной даты, а без даты — нынешний.
const known = parse(props.value)
const nowDate = new Date()
const viewYear = ref(known?.year ?? nowDate.getFullYear())
const viewMonth = ref(known?.month ?? nowDate.getMonth())

/** Дата, пришедшая сверху. Держим разобранной: её спрашивают трижды за отрисовку. */
const set = computed(() => parse(props.value))

const label = computed(() => {
  const date = set.value
  if (date === null) return 'Не указана'
  return `${date.day} ${MONTHS_OF[date.month]} ${date.year}`
})

const cells = computed<DayCell[]>(() => {
  const year = viewYear.value
  const month = viewMonth.value

  // Полдень вместо полуночи: сдвиг пояса не должен уводить день назад.
  const first = new Date(year, month, 1, 12)
  const shift = (first.getDay() + 6) % 7

  const chosen = props.value ?? ''
  const now = todayStamp()
  const list: DayCell[] = []

  for (let step = 0; step < CELLS; step += 1) {
    const day = new Date(year, month, step + 1 - shift, 12)
    const iso = stamp(day.getFullYear(), day.getMonth(), day.getDate())

    list.push({
      iso,
      day: day.getDate(),
      out: day.getMonth() !== month,
      now: iso === now,
      on: iso === chosen,
    })
  }

  return list
})

/** Соседний месяц с переходом через год. Границы держат календарь в разумных летах. */
function stepMonth(delta: number): void {
  const total = viewYear.value * 12 + viewMonth.value + delta
  const year = Math.floor(total / 12)
  if (year < YEAR_MIN || year > yearEdge()) return

  viewYear.value = year
  viewMonth.value = total - year * 12
}

/** Годы на странице сетки: выбранный год в середине, но страница упирается в края. */
const yearCells = computed<number[]>(() => {
  const edge = yearEdge()
  const first = Math.min(
    Math.max(YEAR_MIN, viewYear.value - Math.floor(YEARS_PAGE / 2)),
    Math.max(YEAR_MIN, edge - YEARS_PAGE + 1),
  )

  const out: number[] = []
  for (let step = 0; step < YEARS_PAGE; step += 1) {
    const year = first + step
    if (year > edge) break
    out.push(year)
  }
  return out
})

/** Верхняя граница годов. Нижняя — `YEAR_MIN`. */
function yearEdge(): number {
  return new Date().getFullYear() + YEAR_AHEAD
}

/** Соседний год отдельно от месяца: месячными стрелками до года рождения — сотни нажатий.
 *  В сетке стрелки листают страницу, а не год. */
function stepYear(delta: number): void {
  const step = picking.value ? delta * YEARS_PAGE : delta
  const year = viewYear.value + step
  if (year < YEAR_MIN || year > yearEdge()) return

  viewYear.value = year
}

/** Выбор года из сетки: год ставится, сетка закрывается. */
function takeYear(year: number): void {
  viewYear.value = year
  picking.value = false
}

function toggle(): void {
  open.value = open.value === false
  if (!open.value) picking.value = false
}

function close(): void {
  open.value = false
  picking.value = false
}

/** Число года — кнопка: раскрывает сетку годов и закрывает её обратно. */
function toggleYears(): void {
  picking.value = picking.value === false
}

function choose(iso: string): void {
  if (iso !== props.value) emit('pick', iso)
  close()
}

/** Пустая строка наружу значит «стереть»: так договорились со списком. */
function wipe(): void {
  if (set.value !== null) emit('pick', '')
  close()
}

// Дату могли поправить мимо календаря — кнопкой «сегодня» или обновлением
// списка. Раскрытая сетка должна уехать к новой дате, а не остаться в мае.
watch(
  () => props.value,
  (fresh) => {
    const date = parse(fresh)
    if (date === null) return

    viewYear.value = date.year
    viewMonth.value = date.month
  },
)
</script>

<template>
  <div class="am-daypick" @keydown.esc.stop="close">
    <button
      class="am-daypick__hit"
      :class="{ 'am-daypick__hit--on': open }"
      type="button"
      :aria-expanded="open"
      :aria-label="`${title}: ${label}`"
      @click="toggle"
    >
      <svg class="am-daypick__mark" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.6" y="3.2" width="12.8" height="11.2" rx="2.6" />
        <path d="M1.6 6.9h12.8" />
        <path d="M5.2 1.6v3.1" />
        <path d="M10.8 1.6v3.1" />
      </svg>

      <span class="am-daypick__text" :class="{ 'am-daypick__text--none': set === null }">
        {{ label }}
      </span>

      <svg class="am-daypick__arrow" viewBox="0 0 12 8" aria-hidden="true">
        <path d="M1.7 2.2 6 6.1 10.3 2.2" />
      </svg>
    </button>

    <div v-if="open" class="am-daypick__drop">
      <!-- Год отдельной строкой выше месяца: обе стрелки ведут свою величину,
           и перепутать их труднее, когда они не стоят в одном ряду. -->
      <div class="am-daypick__top">
        <button
          class="am-daypick__step am-daypick__step--year"
          type="button"
          aria-label="Прошлый год"
          @click="stepYear(-1)"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M6.2 2 2.2 6l4 4" />
            <path d="M10.2 2 6.2 6l4 4" />
          </svg>
        </button>

        <button
          class="am-daypick__year am-daypick__year--hit"
          type="button"
          :aria-expanded="picking"
          aria-label="Выбрать год"
          @click="toggleYears"
        >
          {{ viewYear }}
        </button>

        <button
          class="am-daypick__step am-daypick__step--year"
          type="button"
          aria-label="Следующий год"
          @click="stepYear(1)"
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1.8 2 5.8 6l-4 4" />
            <path d="M5.8 2 9.8 6l-4 4" />
          </svg>
        </button>
      </div>

      <!-- Месяц прячется, пока выбирается год: листать месяц, не выбрав год,
           незачем, а две пары стрелок разом сбивали бы с толку. -->
      <div v-if="!picking" class="am-daypick__top">
        <button
          class="am-daypick__step"
          type="button"
          aria-label="Прошлый месяц"
          @click="stepMonth(-1)"
        >
          <svg viewBox="0 0 8 12" aria-hidden="true"><path d="M5.8 1.7 1.9 6l3.9 4.3" /></svg>
        </button>

        <span class="am-daypick__moon">{{ MONTHS[viewMonth] }}</span>

        <button
          class="am-daypick__step"
          type="button"
          aria-label="Следующий месяц"
          @click="stepMonth(1)"
        >
          <svg viewBox="0 0 8 12" aria-hidden="true"><path d="M2.2 1.7 6.1 6l-3.9 4.3" /></svg>
        </button>
      </div>

      <div v-if="picking" class="am-daypick__years">
        <button
          v-for="year in yearCells"
          :key="year"
          class="am-daypick__cell"
          :class="{ 'am-daypick__cell--on': year === viewYear }"
          type="button"
          :aria-pressed="year === viewYear"
          @click="takeYear(year)"
        >
          {{ year }}
        </button>
      </div>

      <template v-else>
        <div class="am-daypick__week" aria-hidden="true">
          <span v-for="name in WEEK" :key="name">{{ name }}</span>
        </div>

        <div class="am-daypick__grid">
          <button
            v-for="cell in cells"
            :key="cell.iso"
            class="am-daypick__day"
            :class="{
              'am-daypick__day--out': cell.out,
              'am-daypick__day--now': cell.now,
              'am-daypick__day--on': cell.on,
            }"
            type="button"
            :aria-pressed="cell.on"
            @click="choose(cell.iso)"
          >
            {{ cell.day }}
          </button>
        </div>
      </template>

      <div class="am-daypick__foot">
        <button class="am-btn am-btn--ghost" type="button" @click="choose(todayStamp())">
          Сегодня
        </button>

        <span class="am-bar__gap" />

        <button
          class="am-btn am-btn--ghost"
          type="button"
          :disabled="set === null"
          @click="wipe"
        >
          Стереть
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.am-daypick {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}

/* Поле одето как ввод темы: снаружи разницы с соседними полями быть не должно. */
.am-daypick__hit {
  display: flex;
  gap: 10px;
  align-items: center;
  min-height: var(--am-touch);
  padding: 9px 12px 9px 14px;
  font: inherit;
  font-size: 14px;
  color: var(--am-text);
  text-align: left;
  cursor: pointer;
  background: var(--am-fill-2);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease);
}

.am-daypick__hit:hover {
  background: var(--am-hover);
  border-color: rgb(var(--am-accent-rgb) / 0.5);
}

.am-daypick__hit--on {
  border-color: rgb(var(--am-accent-rgb) / 0.65);
}

.am-daypick__mark {
  flex: none;
  width: 16px;
  height: 16px;
  color: var(--am-faint);
  fill: none;
  stroke: currentColor;
  stroke-width: 1.4;
  stroke-linecap: round;
}

.am-daypick__hit:hover .am-daypick__mark,
.am-daypick__hit--on .am-daypick__mark {
  color: var(--am-accent);
}

.am-daypick__text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-variant-numeric: tabular-nums;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Пустая дата не должна выглядеть как значение. */
.am-daypick__text--none {
  color: var(--am-faint);
}

.am-daypick__arrow {
  flex: none;
  width: 12px;
  height: 8px;
  color: var(--am-faint);
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition: transform var(--am-fast) var(--am-ease);
}

.am-daypick__hit--on .am-daypick__arrow {
  transform: rotate(180deg);
}

/* Сетка живёт внутри поля, а не слоем поверх: тело окна прокручивается. */
.am-daypick__drop {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  background: var(--am-panel-2);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-l);
  box-shadow: var(--am-sh-1);
  animation: am-day-in var(--am-fast) var(--am-ease) both;
}

@keyframes am-day-in {
  from {
    opacity: 0;
    transform: translateY(-6px);
  }
}

.am-daypick__top {
  display: flex;
  gap: 8px;
  align-items: center;
}

.am-daypick__moon,
.am-daypick__year {
  flex: 1;
  font-size: 14px;
  font-weight: 700;
  text-align: center;
}

/* Год набран крупнее месяца: это та величина, до которой здесь добираются
   дальше всего, и читаться она должна раньше названия месяца. */
.am-daypick__year {
  font-size: 15px;
  font-variant-numeric: tabular-nums;
}

/* Двойная стрелка шире одиночной: две черты в габарите 8 пикселей
   сливались бы в одну. */
.am-daypick__step--year svg {
  width: 12px;
  height: 12px;
}

/* Число года — кнопка: по нажатию раскрывается сетка годов. Вид тот же,
   что у подписи месяца, чтобы не выглядеть ещё одним полем ввода. */
.am-daypick__year--hit {
  padding: 2px 0;
  font-family: inherit;
  cursor: pointer;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--am-r-s);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease);
}

.am-daypick__year--hit:hover {
  color: var(--am-accent);
  background: var(--am-hover);
  border-color: rgb(var(--am-accent-rgb) / 0.5);
}

/* Три в ряд: четыре ряда по три держат поле узким, как сетка дней. */
.am-daypick__years {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 4px;
}

.am-daypick__cell {
  padding: 8px 0;
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--am-text);
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid transparent;
  border-radius: var(--am-r-s);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease);
}

.am-daypick__cell:hover {
  background: var(--am-hover);
}

.am-daypick__cell--on {
  font-weight: 700;
  color: var(--am-bg);
  background: linear-gradient(135deg, var(--am-accent), var(--am-accent-2));
  box-shadow: var(--am-sh-glow);
}

.am-daypick__cell--on:hover {
  color: var(--am-bg);
  background: linear-gradient(135deg, var(--am-accent), var(--am-accent-2));
}

.am-daypick__step {
  display: grid;
  flex: none;
  place-items: center;
  width: 30px;
  height: 30px;
  padding: 0;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-fill-1);
  border: 0;
  border-radius: var(--am-r-s);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease);
}

.am-daypick__step:hover {
  color: var(--am-text);
  background: var(--am-fill-3);
}

.am-daypick__step svg {
  width: 8px;
  height: 12px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.am-daypick__week,
.am-daypick__grid {
  display: grid;
  grid-template-columns: repeat(7, minmax(0, 1fr));
  gap: 2px;
}

.am-daypick__week span {
  padding: 2px 0;
  font-size: 11px;
  font-weight: 700;
  color: var(--am-faint);
  text-align: center;
  text-transform: uppercase;
}

.am-daypick__day {
  display: grid;
  place-items: center;
  height: 32px;
  padding: 0;
  font: inherit;
  font-size: 13px;
  font-variant-numeric: tabular-nums;
  color: var(--am-text);
  cursor: pointer;
  background: none;
  border: 1px solid transparent;
  border-radius: var(--am-r-s);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease);
}

.am-daypick__day:hover {
  background: var(--am-hover);
}

/* Хвосты соседних месяцев видно, но они не спорят с нынешним. */
.am-daypick__day--out {
  color: var(--am-faint);
}

/* Сегодняшний день обведён, выбранный — залит: две отметки не мешают друг другу. */
.am-daypick__day--now {
  border-color: rgb(var(--am-accent-rgb) / 0.55);
}

.am-daypick__day--on {
  font-weight: 700;
  color: var(--am-bg);
  background: linear-gradient(135deg, var(--am-accent), var(--am-accent-2));
  border-color: transparent;
  box-shadow: var(--am-sh-glow);
}

.am-daypick__day--on:hover {
  color: var(--am-bg);
  background: linear-gradient(135deg, var(--am-accent), var(--am-accent-2));
}

.am-daypick__foot {
  display: flex;
  gap: 8px;
  align-items: center;
  padding-top: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .am-daypick__drop {
    animation: none;
  }

  .am-daypick__arrow {
    transition: none;
  }
}
</style>
