<script setup lang="ts">
// Экран истории: показ из снимков записей player-keep (без сети), свежее вперёд и по дням.
// Дни — по местным суткам, доля пройденного — из метки записи, а не из счёта серий AniList.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { peekLook } from '@/core/media-looks'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import { Logger } from '@/utils/logger'

import EmptyMark from '../components/EmptyMark.vue'
import { navigate } from '../router'

import {
  forgetWatch,
  peekHistory,
  resumeWatch,
  whenWatchReady,
  wipeWatch,
  type WatchRow,
} from './player-keep'

/** Рельс крестика удаления: tabindex −1, фокус водим сами; слушатель в фазе перехвата — до spatial nav. */
function railKey(event: KeyboardEvent): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  if (
    event.key !== 'ArrowLeft' &&
    event.key !== 'ArrowRight' &&
    event.key !== 'ArrowUp' &&
    event.key !== 'ArrowDown'
  ) {
    return
  }

  const active = document.activeElement
  if (!(active instanceof HTMLElement)) return

  const row = active.closest<HTMLLIElement>('.am-hist__row')
  if (row === null) return

  const drop = row.querySelector<HTMLButtonElement>('.am-hist__drop')
  if (drop === null) return

  const hit = row.querySelector<HTMLButtonElement>('.am-hist__hit')
  if (hit === null) return

  // Фокус переводим сами, синхронно, и глушим событие: spatial nav работает по геометрии
  // и от крестика уводит не туда, а отложенный setTimeout давал мельтешение фокуса.
  const move = (to: HTMLElement | null): void => {
    if (to === null || to === active) return
    event.preventDefault()
    event.stopPropagation()
    to.focus()
  }

  // Вправо со строки — на её крестик, влево с крестика — обратно: сама nav туда не ходит.
  if (active === hit && event.key === 'ArrowRight') {
    move(drop)
    return
  }

  if (active === drop && event.key === 'ArrowLeft') {
    move(hit)
    return
  }

  // Вверх/вниз — всегда на соседнюю строку, и со строки, и с крестика; считаем по разметке.
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const rows = [...document.querySelectorAll<HTMLLIElement>('.am-hist__row')]
    const at = rows.indexOf(row)
    const near = rows[at + (event.key === 'ArrowDown' ? 1 : -1)]
    move(near === undefined ? null : near.querySelector<HTMLButtonElement>('.am-hist__hit'))
  }
}

/** Сколько строк рисуется за раз: сразу всё — это сотни обложек и запросов за названиями. */
const PAGE_LIMIT = 80

/** Сколько заглушек показать, пока читается склад. */
const HOLD_LINES = 8

/** По скольку имён просить за заход: источники отвечают по одному. */
const TITLE_CHUNK = 10

/** Сколько держится взведённая кнопка очистки, прежде чем разоружится. */
const WIPE_ARM_MS = 5000

/** Месяцы в родительном падеже: «12 сентября», а не «12 сентябрь». */
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

/** Строка истории в виде, готовом к отрисовке: разметка ничего не считает. */
interface Line {
  key: string
  watch: WatchRow
  title: string
  cover: string | null
  /** Подпись под названием: серия, озвучка, время в серии. */
  facts: string
  /** Час просмотра: «14:20». */
  when: string
  /** Доля пройденного для полосы; 0 — длины серии не знаем. */
  done: number
  /** Подпись полосы. */
  hint: string
}

/** День истории: подпись и строки одного числа. */
interface Day {
  key: number
  title: string
  lines: Line[]
}

/** Время в серии: 7:05 и 1:07:05. Часы появляются, только когда они есть. */
function lenText(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = String(Math.floor((whole % 3600) / 60))
  const rest = String(whole % 60).padStart(2, '0')

  return hours > 0 ? `${hours}:${minutes.padStart(2, '0')}:${rest}` : `${minutes}:${rest}`
}

/** Час просмотра по местным часам; не через toLocaleTimeString — он даёт разнобой с «12:40 / 24:00». */
function whenText(stamp: number): string {
  const date = new Date(stamp)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Начало местных суток: по нему записи и раскладываются по дням. */
function dayStart(stamp: number): number {
  const date = new Date(stamp)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

/** Подпись дня: сегодня/вчера словами, год — только у чужого года. */
function dayTitle(start: number): string {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)

  if (start === today.getTime()) return 'Сегодня'
  if (start === yesterday.getTime()) return 'Вчера'

  const date = new Date(start)
  const word = MONTHS[date.getMonth()] ?? ''
  const year = date.getFullYear() === now.getFullYear() ? '' : ` ${date.getFullYear()}`

  return `${date.getDate()} ${word}${year}`
}

/** Запись истории в строку показа. Обложка и имя добираются со склада. */
function toLine(row: WatchRow): Line {
  const look = peekLook(row.mediaId)
  const parts = [`Серия ${row.episode}`]

  if (row.voiceLabel !== '') parts.push(row.voiceLabel)
  if (row.full > 0) parts.push(`${lenText(row.at)} / ${lenText(row.full)}`)

  const done = row.full > 0 ? Math.min(1, Math.max(0, row.at / row.full)) : 0

  return {
    key: `${row.mediaId}|${row.episode}`,
    watch: row,
    title:
      peekRussianName(row.mediaId) ??
      (row.title !== '' ? row.title : (look?.romaji ?? `Аниме #${row.mediaId}`)),
    cover: row.cover ?? look?.cover ?? null,
    facts: parts.join(' · '),
    when: whenText(row.when),
    done,
    hint: `Просмотрено ${Math.round(done * 100)}%`,
  }
}

/** Раскладывает записи по дням; список уже свежим вперёд, поэтому хватит сравнения с последним днём. */
function group(list: WatchRow[]): Day[] {
  const out: Day[] = []

  for (const row of list) {
    const key = dayStart(row.when)
    const last = out[out.length - 1]

    if (last === undefined || last.key !== key) {
      out.push({ key, title: dayTitle(key), lines: [toLine(row)] })
      continue
    }

    last.lines.push(toLine(row))
  }

  return out
}

/** Ширина полосы пройденного. */
function barWidth(part: number): string {
  return `${Math.round(Math.min(1, Math.max(0, part)) * 100)}%`
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const rows = ref<WatchRow[]>([])

/** Идёт ли чтение склада. */
const busy = ref(true)

const trouble = ref('')

/** Догоняют ли русские имена: флажок в подвале. */
const titlesBusy = ref(false)

/** Сколько строк показываем сейчас. */
const limit = ref(PAGE_LIMIT)

/** Очистка взведена: второе нажатие сотрёт, первое только спрашивает. */
const wipeArmed = ref(false)

/** Таймер разоружения кнопки очистки. */
let armTimer = 0

/** Номер добора имён: старый видит, что его ответ больше не нужен. */
let titleRun = 0

const shown = computed<WatchRow[]>(() => rows.value.slice(0, limit.value))
const days = computed<Day[]>(() => group(shown.value))
const hasMore = computed<boolean>(() => rows.value.length > limit.value)
const restCount = computed<number>(() => Math.max(0, rows.value.length - limit.value))

/** Корень экрана: на нём сидит слушатель рельса крестика. */
const root = ref<HTMLElement | null>(null)

/** Сборка показа из памяти. Сети не требует вовсе. */
function redraw(): void {
  rows.value = peekHistory()
}

/** Продолжить с места остановки; запись становится нынешним выбором тайтла: плеер открывается по нему. */
function resume(item: Line): void {
  resumeWatch(item.watch)
  navigate('player', { id: String(item.watch.mediaId) })
}

/** Убрать одну запись. Метка продолжения остаётся: она не история. */
function drop(item: Line): void {
  forgetWatch(item.watch.mediaId, item.watch.episode)
  redraw()
}

/** Очистка в два нажатия: отменить её нечем, а кнопка в одном клике от «Продолжить». */
function askWipe(): void {
  if (!wipeArmed.value) {
    wipeArmed.value = true

    if (armTimer !== 0) window.clearTimeout(armTimer)
    armTimer = window.setTimeout(() => {
      armTimer = 0
      wipeArmed.value = false
    }, WIPE_ARM_MS)

    return
  }

  if (armTimer !== 0) window.clearTimeout(armTimer)
  armTimer = 0
  wipeArmed.value = false

  wipeWatch()
  redraw()
}

/** Добор следующей сотни строк. */
function showMore(): void {
  if (!hasMore.value) return
  limit.value += PAGE_LIMIT
}

/** Русские имена для записей-латиницы; добор пачками, фоном, с перерисовкой по мере готовности. */
async function warmTitles(): Promise<void> {
  const mine = ++titleRun
  const wanted = [
    ...new Set(
      rows.value.filter((row) => peekRussianName(row.mediaId) === null).map((row) => row.mediaId),
    ),
  ]

  if (wanted.length === 0) return

  titlesBusy.value = true

  try {
    for (let from = 0; from < wanted.length; from += TITLE_CHUNK) {
      if (mine !== titleRun) return

      await prefetchRussianNames(wanted.slice(from, from + TITLE_CHUNK))
      if (mine !== titleRun) return

      // Снимок в записи не трогаем: имя живёт на складе, и показ берёт его
      // оттуда — записанное остаётся тем, что человек видел в плеере.
      redraw()
    }
  } catch (e) {
    Logger('WARN', 'История: русские названия добрать не вышло', e)
  } finally {
    if (mine === titleRun) titlesBusy.value = false
  }
}

onMounted(() => {
  // capture: true — раньше остальных слушателей, чтобы spatial nav не успела увести фокус.
  window.addEventListener('keydown', railKey, true)

  void (async () => {
    try {
      await whenWatchReady()
      redraw()
    } catch (e) {
      trouble.value = describe(e)
    } finally {
      busy.value = false
    }

    void warmTitles()
  })()
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', railKey, true)
  titleRun += 1

  if (armTimer !== 0) window.clearTimeout(armTimer)
  armTimer = 0
})
</script>

<template>
  <section ref="root" class="am-page">
    <div class="am-hist__top">
      <h2 class="am-h2">Просмотрено</h2>
      <span v-if="rows.length > 0" class="am-hist__num">{{ rows.length }}</span>
      <span class="am-bar__gap" />

      <button
        v-if="rows.length > 0"
        v-tip="'Сотрёт и метки продолжения'"
        class="am-btn am-btn--ghost"
        :class="{ 'am-hist__danger': wipeArmed }"
        type="button"
        @click="askWipe"
      >
        {{ wipeArmed ? 'Нажмите ещё раз' : 'Очистить' }}
      </button>
    </div>

    <p v-if="trouble" class="am-error">{{ trouble }}</p>

    <ul v-if="busy" class="am-hist__list">
      <li v-for="n in HOLD_LINES" :key="n" class="am-hist__hold">
        <span class="am-skeleton" />
      </li>
    </ul>

    <div v-else-if="rows.length === 0" class="am-empty">
      <span class="am-empty__mark"><EmptyMark name="clock" /></span>
      <span>Здесь появится то, что вы смотрели.</span>
      <span>История пишется сама: достаточно открыть серию в плеере.</span>
    </div>

    <template v-else>
      <section v-for="day in days" :key="day.key" class="am-hist__day">
        <h3 class="am-h3">{{ day.title }}</h3>

        <ul class="am-hist__list">
          <li
            v-for="item in day.lines"
            :key="item.key"
            class="am-hist__row"
            :class="{ 'am-hist__row--bar': item.done > 0 }"
          >
            <button v-tip="item.title" class="am-hist__hit" type="button" @click="resume(item)">
              <img
                v-if="item.cover"
                class="am-hist__art"
                :src="item.cover"
                :alt="item.title"
                loading="lazy"
                decoding="async"
              />
              <span v-else class="am-hist__art am-hist__art--empty" aria-hidden="true">
                {{ item.title.slice(0, 1) }}
              </span>

              <span class="am-hist__text">
                <span class="am-hist__name">{{ item.title }}</span>
                <span class="am-hist__facts">{{ item.facts }}</span>
              </span>

              <!-- Знак при кнопке-строке, а не вторая кнопка: вложить кнопку
                   в кнопку разметка не даёт. -->
              <span class="am-hist__tail">
                <span class="am-hist__when">{{ item.when }}</span>
                <span class="am-hist__go">Продолжить</span>
              </span>

              <!-- Полоса лежит по нижней кромке строки: шкала во всю ширину
                   сама показывает, где у пройденного конец. -->
              <span v-if="item.done > 0" v-tip="item.hint" class="am-line am-hist__line">
                <span class="am-line__fill" :style="{ width: barWidth(item.done) }" />
              </span>
            </button>

            <button
              v-tip="'Убрать из истории'"
              tabindex="-1"
              class="am-hist__drop"
              type="button"
              aria-label="Убрать из истории"
              @click="drop(item)"
            >
              ×
            </button>
          </li>
        </ul>
      </section>

      <div class="am-hist__more">
        <button v-if="hasMore" class="am-btn am-btn--soft" type="button" @click="showMore">
          Показать ещё · осталось {{ restCount }}
        </button>
      </div>

      <p class="am-hist__foot">
        {{ shown.length }} из {{ rows.length }}
        <template v-if="titlesBusy"> · названия…</template>
      </p>
    </template>
  </section>
</template>

<style scoped>
/* Полоса над списком — то же стекло, что у отбора в списках: история стоит
   в меню рядом с «Моё» и выглядеть должна так же. */
.am-hist__top {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 10px 14px;
  background: var(--am-glass);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-xl);
  box-shadow: inset 0 1px 0 var(--am-edge);
  backdrop-filter: blur(var(--am-blur)) saturate(1.4);
}

.am-hist__num {
  font-size: 12px;
  color: var(--am-faint);
  font-variant-numeric: tabular-nums;
}

/* Взведённая очистка краснеет: второе нажатие необратимо, и это должно быть
   видно до него, а не после. */
.am-hist__danger {
  color: var(--am-bad);
  border-color: color-mix(in srgb, var(--am-bad) 45%, transparent);
}

.am-hist__day {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.am-hist__list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Заглушка повторяет высоту строки с постером: иначе экран подпрыгивал бы
   в момент, когда заглушки сменяются живыми строками. */
.am-hist__hold .am-skeleton {
  display: block;
  height: 74px;
  border-radius: var(--am-r-m);
}

/* Якорь для крестика: без него он уехал бы к краю экрана. */
.am-hist__row {
  position: relative;
  list-style: none;
}

/* Цель нажатия — вся строка: целиться в название с «Продолжить» на другом
   конце строки невозможно. */
.am-hist__hit {
  position: relative;
  display: flex;
  gap: 12px;
  align-items: center;
  width: 100%;
  min-height: 74px;
  padding: 8px 52px 8px 10px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
  transition:
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease);
}

/* Отступ под крестик держится всегда, а не только под курсором: иначе
   «Продолжить» и час просмотра дёргались бы при каждом наведении. */
.am-hist__row--bar .am-hist__hit {
  padding-bottom: 14px;
}

.am-hist__hit:hover,
.am-hist__hit:focus-visible {
  background: var(--am-hover);
  border-color: rgb(var(--am-accent-rgb) / 0.45);
}

.am-hist__hit:hover .am-hist__name,
.am-hist__hit:focus-visible .am-hist__name {
  color: var(--am-accent);
}

.am-hist__hit:hover .am-hist__go,
.am-hist__hit:focus-visible .am-hist__go {
  color: var(--am-accent);
  background: var(--am-fill-2);
  border-color: rgb(var(--am-accent-rgb) / 0.55);
}

.am-hist__art {
  flex: none;
  width: 40px;
  height: 58px;
  object-fit: cover;
  background: var(--am-fill-2);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-s);
}

.am-hist__art--empty {
  display: grid;
  place-items: center;
  font-size: 18px;
  color: var(--am-faint);
}

.am-hist__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

/* Название в одну строку с отсечкой: ровный шаг строк важнее полного имени
   у трёх самых длинных названий — полное покажет подпись. */
.am-hist__name {
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: color var(--am-fast) var(--am-ease);
}

.am-hist__facts {
  overflow: hidden;
  font-size: 12px;
  color: var(--am-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.am-hist__tail {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 5px;
  align-items: flex-end;
}

.am-hist__when {
  font-size: 11.5px;
  color: var(--am-faint);
  font-variant-numeric: tabular-nums;
}

.am-hist__go {
  padding: 3px 9px;
  font-size: 11.5px;
  font-weight: 600;
  color: var(--am-dim);
  background: transparent;
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease);
}

/* Полоса до правого края строки — иначе не видно шкалы; width: auto обязателен, иначе заданная
   ширина отбрасывала right, а постер перекрывал бы левый конец. */
.am-hist__line {
  position: absolute;
  right: 52px;
  bottom: 7px;
  left: 62px;
  width: auto;
  height: 4px;
  border-radius: var(--am-r-cap);
}

/* Крестик поверх правого края, просыпается под курсором; прячется прозрачностью, а не display:
   none — с клавиатуры до него надо доезжать. */
.am-hist__drop {
  position: absolute;
  top: calc(50% - 4px);
  right: 9px;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  padding: 0;
  font-size: 17px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-fill-2);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  opacity: 0;
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease),
    opacity var(--am-fast) var(--am-ease);
  transform: translateY(-50%);
}

.am-hist__row:hover .am-hist__drop,
.am-hist__row:focus-within .am-hist__drop {
  opacity: 1;
}

.am-hist__drop:hover,
.am-hist__drop:focus-visible {
  color: var(--am-bad);
  background: var(--am-hover);
  border-color: color-mix(in srgb, var(--am-bad) 45%, transparent);
  opacity: 1;
}

/* Где курсора нет вовсе — крестик виден сразу: навести пальцем нельзя. */
@media (hover: none) {
  .am-hist__drop {
    opacity: 1;
  }
}

/* Конец списка: место под кнопку добора. */
.am-hist__more {
  display: flex;
  justify-content: center;
  min-height: 8px;
}

/* Счёт внизу — служебная строка, а не часть показа. */
.am-hist__foot {
  margin: 0;
  font-size: 12px;
  color: var(--am-faint);
  text-align: center;
  font-variant-numeric: tabular-nums;
}
</style>
