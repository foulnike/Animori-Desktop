<script setup lang="ts">
// Меню отбора для главной. Правит черновик и отдаёт одним «Готово», чтобы нажатия не били в сеть.
// Группы тэгов закрыты (справочник ~1000), взрослое режется в core/adult, у года свои стрелки.
import { computed, onBeforeUnmount, ref, watch } from 'vue'

import {
  emptyPick,
  type CatalogPick,
  type CatalogTag,
  type FeedSort,
} from '@/api/anilist-catalog'
import { genreAllowed, tagAllowed } from '@/core/adult'
import { tagChoices } from '@/core/recs'

import { formatWord, GENRE_CHOICES, genreWord } from '../labels'
import { tagGroupWord, tagWord } from '../tag-words'

import SakuraBloom from './SakuraBloom.vue'

const props = defineProps<{
  open: boolean
  pick: CatalogPick
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'apply', pick: CatalogPick): void
}>()

/** Сколько находок показывать при поиске по тэгам. */
const HUNT_MAX = 60

/** Глубина выбора года: раньше пятидесятых каталог почти пуст. */
const YEAR_MIN = 1950

/** Форматы выхода в порядке привычности, а не по алфавиту. */
const FORMAT_CHOICES: readonly string[] = [
  'TV',
  'TV_SHORT',
  'MOVIE',
  'OVA',
  'ONA',
  'SPECIAL',
  'MUSIC',
]

/** Слова порядка ленты. */
const SORT_CHOICES: ReadonlyArray<{ key: FeedSort; title: string }> = [
  { key: 'score', title: 'По оценке' },
  { key: 'popular', title: 'По популярности' },
  { key: 'trending', title: 'В тренде' },
  { key: 'new', title: 'Новинки' },
]

/** Готовый промежуток годов: десятилетия вбивают цифрами чаще всего. */
interface YearSpan {
  key: string
  title: string
  from: number | null
  till: number | null
}

/** Группа тэгов в показе. */
interface TagGroup {
  key: string
  title: string
  items: CatalogTag[]
}

/** Какая из двух границ года правится. */
type YearSide = 'from' | 'till'

const draft = ref<CatalogPick>(emptyPick())
const tags = ref<CatalogTag[]>([])
const tagsBusy = ref(false)
const hunt = ref('')
const openGroup = ref('')
const fromText = ref('')
const tillText = ref('')

/** Справочник тянется один раз на сеанс и только при первом открытии. */
let tagsAsked = false

/** Прежний запрет прокрутки тела: возвращается как было, а не в пустоту. */
let bodyKeep = ''

const yearMax = new Date().getFullYear() + 1

/** Нынешний год: с него начинает пустое поле под стрелкой. */
const yearNow = new Date().getFullYear()

/** Оба поля года списком: разметка у них общая, разнятся подпись и подсказка. */
const YEAR_FIELDS: ReadonlyArray<{ side: YearSide; title: string; hint: string }> = [
  { side: 'from', title: 'С года', hint: String(YEAR_MIN) },
  { side: 'till', title: 'По год', hint: String(yearMax) },
]

/** Сколько условий сейчас в черновике. Порядок не считается отбором. */
const count = computed(
  () =>
    draft.value.genres.length +
    draft.value.tags.length +
    draft.value.formats.length +
    (draft.value.yearFrom !== null || draft.value.yearTo !== null ? 1 : 0),
)

/** Готовые промежутки: свежее и четыре десятилетия назад от нынешнего. */
const spans = computed<YearSpan[]>(() => {
  const now = new Date().getFullYear()
  const out: YearSpan[] = [{ key: 'fresh', title: 'Свежее', from: now - 1, till: null }]

  const head = Math.floor(now / 10) * 10
  for (let step = 0; step < 4; step++) {
    const start = head - step * 10
    out.push({
      key: String(start),
      title: `${String(start).slice(2)}-е`,
      from: start,
      till: start + 9,
    })
  }

  return out
})

/** Жанры под политикой показа взрослого. */
const genreList = computed<string[]>(() =>
  GENRE_CHOICES.filter((genre) => genreAllowed(genre)),
)

/** Тэги под политикой показа взрослого: метка сервера, закрытые разделы
    справочника и свой список имён — всё решается в core/adult. */
const pool = computed<CatalogTag[]>(() => tags.value.filter((tag) => tagAllowed(tag)))

/** Группы справочника в порядке прихода: он уже по алфавиту. */
const groups = computed<TagGroup[]>(() => {
  const byKey = new Map<string, TagGroup>()

  for (const tag of pool.value) {
    const known = byKey.get(tag.category)
    if (known !== undefined) {
      known.items.push(tag)
      continue
    }
    byKey.set(tag.category, {
      key: tag.category,
      title: tagGroupWord(tag.category),
      items: [tag],
    })
  }

  return Array.from(byKey.values())
})

/** Находки поиска тэгов: искать можно и по-русски, и по-английски. */
const found = computed<CatalogTag[]>(() => {
  const word = hunt.value.trim().toLowerCase()
  if (word === '') return []

  const out: CatalogTag[] = []
  for (const tag of pool.value) {
    if (out.length >= HUNT_MAX) break
    const ru = tagWord(tag.name).toLowerCase()
    if (ru.includes(word) || tag.name.toLowerCase().includes(word)) out.push(tag)
  }

  return out
})

/** Выбранные тэги отдельной строкой: тэг из закрытой группы иначе
    не виден, и снять его было бы нечем. */
const chosenTags = computed<string[]>(() => draft.value.tags)

/** Поднимает справочник тэгов. Провал виден пустым разделом:
    ругаться в меню отбора нечем, остальные разделы работают. */
async function loadTags(): Promise<void> {
  if (tagsAsked) return
  tagsAsked = true
  tagsBusy.value = true

  try {
    tags.value = await tagChoices()
  } finally {
    tagsBusy.value = false
  }
}

/** Снять или добавить значение в список отбора. */
function toggled(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value]
}

function toggleGenre(genre: string): void {
  draft.value.genres = toggled(draft.value.genres, genre)
}

function toggleTag(name: string): void {
  draft.value.tags = toggled(draft.value.tags, name)
}

function toggleFormat(format: string): void {
  draft.value.formats = toggled(draft.value.formats, format)
}

function setSort(sort: FeedSort): void {
  draft.value.sort = sort
}

/** Группа раскрывается одна за раз: второе нажатие закрывает. */
function toggleGroup(key: string): void {
  openGroup.value = openGroup.value === key ? '' : key
}

/** Сколько тэгов группы уже в отборе: число на закрытой группе. */
function groupCount(group: TagGroup): number {
  let num = 0
  for (const tag of group.items) if (draft.value.tags.includes(tag.name)) num++
  return num
}

/** Год из поля. Нечитаемое значение равносильно «без границы». */
function readYear(text: string): number | null {
  const num = Number.parseInt(text.trim(), 10)
  return Number.isFinite(num) ? num : null
}

/** Что сейчас набрано в поле стороны. */
function yearText(side: YearSide): string {
  return side === 'from' ? fromText.value : tillText.value
}

function setYearText(side: YearSide, text: string): void {
  if (side === 'from') fromText.value = text
  else tillText.value = text
}

/** Поля годов читаются сырыми: подгонка под границы на каждую цифру
    не давала бы ввести «1995»: первая же единица стала бы годом 1950. */
function onYears(): void {
  draft.value.yearFrom = readYear(fromText.value)
  draft.value.yearTo = readYear(tillText.value)
}

/** Ввод в поле года: только цифры, до 4 знаков. Значение возвращается в узел,
 *  иначе показ отстанет от состояния, когда чистка вернула прежнюю строку. */
function onYearInput(side: YearSide, e: Event): void {
  const field = e.target as HTMLInputElement
  const clean = field.value.replace(/\D+/g, '').slice(0, 4)

  if (field.value !== clean) field.value = clean
  setYearText(side, clean)
  onYears()
}

/** Шаг стрелкой на год. Пустое/недописанное поле сперва встаёт на нынешний год:
 *  иначе «19» стало бы «20», а с пустого пришлось бы идти от пятидесятого. */
function stepYear(side: YearSide, step: number): void {
  const now = readYear(yearText(side))
  const whole = now !== null && now >= YEAR_MIN && now <= yearMax
  const next = whole ? (now as number) + step : yearNow

  setYearText(side, String(Math.min(Math.max(next, YEAR_MIN), yearMax)))
  onYears()
}

/** Упёрлась ли стрелка в край каталога: дальше нажимать нечего. */
function stepOff(side: YearSide, step: number): boolean {
  const year = readYear(yearText(side))
  if (year === null) return false
  return step > 0 ? year >= yearMax : year <= YEAR_MIN
}

/** Готовый промежуток: повторное нажатие снимает годы вовсе. */
function useSpan(span: YearSpan): void {
  const same = draft.value.yearFrom === span.from && draft.value.yearTo === span.till
  draft.value.yearFrom = same ? null : span.from
  draft.value.yearTo = same ? null : span.till
  fromText.value = draft.value.yearFrom === null ? '' : String(draft.value.yearFrom)
  tillText.value = draft.value.yearTo === null ? '' : String(draft.value.yearTo)
}

/** Стоит ли промежуток в черновике сейчас. */
function spanOn(span: YearSpan): boolean {
  return draft.value.yearFrom === span.from && draft.value.yearTo === span.till
}

/** Год в границах каталога. */
function fitYear(year: number | null): number | null {
  if (year === null) return null
  return Math.min(Math.max(year, YEAR_MIN), yearMax)
}

function onClose(): void {
  emit('close')
}

/** Сброс чистит черновик, но не закрывает меню: чаще всего сбрасывают,
    чтобы тут же собрать другой отбор. */
function onReset(): void {
  draft.value = emptyPick()
  fromText.value = ''
  tillText.value = ''
  hunt.value = ''
}

/** Отдаёт отбор наружу: годы приводятся к границам, а перевёрнутый промежуток
 *  («с 2015 по 2005») меняется местами — это описка, а не просьба показать пустоту. */
function onApply(): void {
  const from = fitYear(draft.value.yearFrom)
  const till = fitYear(draft.value.yearTo)
  const swap = from !== null && till !== null && from > till

  emit('apply', {
    genres: [...draft.value.genres],
    tags: [...draft.value.tags],
    formats: [...draft.value.formats],
    yearFrom: swap ? till : from,
    yearTo: swap ? from : till,
    sort: draft.value.sort,
  })
}

/** Escape закрывает меню. Слушатель на окне: фокус может быть в поле поиска. */
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') onClose()
}

// При открытии берётся свежая копия отбора: брошенный в прошлый раз
// черновик не должен вскрываться снова.
watch(
  () => props.open,
  (open) => {
    if (open) {
      draft.value = {
        genres: [...props.pick.genres],
        tags: [...props.pick.tags],
        formats: [...props.pick.formats],
        yearFrom: props.pick.yearFrom,
        yearTo: props.pick.yearTo,
        sort: props.pick.sort,
      }
      fromText.value = props.pick.yearFrom === null ? '' : String(props.pick.yearFrom)
      tillText.value = props.pick.yearTo === null ? '' : String(props.pick.yearTo)
      hunt.value = ''

      bodyKeep = document.body.style.overflow
      document.body.style.overflow = 'hidden'
      window.addEventListener('keydown', onKey)
      void loadTags()
      return
    }

    document.body.style.overflow = bodyKeep
    window.removeEventListener('keydown', onKey)
  },
)

onBeforeUnmount(() => {
  // Снятие экрана при открытом меню оставило бы тело без прокрутки навсегда.
  if (props.open) document.body.style.overflow = bodyKeep
  window.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="am-sheet">
      <button class="am-sheet__veil" type="button" aria-label="Закрыть" @click="onClose" />

      <div class="am-sheet__box" role="dialog" aria-modal="true" aria-label="Настройка подбора">
        <header class="am-sheet__top">
          <h2 class="am-h2">Подбор</h2>
          <span v-if="count > 0" v-tip="'Условий в отборе'" class="am-sheet__num">{{ count }}</span>
          <span class="am-bar__gap" />

          <!-- Закрытие знаком: слово рядом с «Готово» читалось бы вторым действием.
               Имя даёт aria-label: знак спрятан от чтецов, подсказка живёт слоем в body. -->
          <button
            v-tip="'Закрыть'"
            class="am-sheet__close"
            type="button"
            aria-label="Закрыть"
            @click="onClose"
          >
            <SakuraBloom />
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div class="am-sheet__body">
          <section class="am-part">
            <h3 class="am-h3">Жанры</h3>
            <div class="am-wrap">
              <button
                v-for="genre in genreList"
                :key="genre"
                class="am-chip"
                :class="{ 'am-chip--on': draft.genres.includes(genre) }"
                type="button"
                @click="toggleGenre(genre)"
              >
                {{ genreWord(genre) ?? genre }}
              </button>
            </div>
          </section>

          <section class="am-part">
            <h3 class="am-h3">Годы</h3>

            <div class="am-wrap">
              <button
                v-for="span in spans"
                :key="span.key"
                class="am-chip"
                :class="{ 'am-chip--on': spanOn(span) }"
                type="button"
                @click="useSpan(span)"
              >
                {{ span.title }}
              </button>
            </div>

            <div class="am-years">
              <div v-for="field in YEAR_FIELDS" :key="field.side" class="am-years__one">
                <span class="am-meta">{{ field.title }}</span>

                <div class="am-year">
                  <input
                    class="am-input am-year__field"
                    type="text"
                    inputmode="numeric"
                    maxlength="4"
                    autocomplete="off"
                    :aria-label="field.title"
                    :placeholder="field.hint"
                    :value="yearText(field.side)"
                    @input="onYearInput(field.side, $event)"
                    @keydown.up.prevent="stepYear(field.side, 1)"
                    @keydown.down.prevent="stepYear(field.side, -1)"
                  />

                  <span class="am-year__steps">
                    <button
                      class="am-year__step"
                      type="button"
                      tabindex="-1"
                      :disabled="stepOff(field.side, 1)"
                      :aria-label="`${field.title}: больше`"
                      @click="stepYear(field.side, 1)"
                    >
                      <svg class="am-year__arrow" viewBox="0 0 12 8" aria-hidden="true">
                        <path d="M1.7 5.8 6 1.9 10.3 5.8" />
                      </svg>
                    </button>

                    <button
                      class="am-year__step"
                      type="button"
                      tabindex="-1"
                      :disabled="stepOff(field.side, -1)"
                      :aria-label="`${field.title}: меньше`"
                      @click="stepYear(field.side, -1)"
                    >
                      <svg class="am-year__arrow" viewBox="0 0 12 8" aria-hidden="true">
                        <path d="M1.7 2.2 6 6.1 10.3 2.2" />
                      </svg>
                    </button>
                  </span>
                </div>
              </div>
            </div>
          </section>

          <section class="am-part">
            <h3 class="am-h3">Формат выхода</h3>
            <div class="am-wrap">
              <button
                v-for="format in FORMAT_CHOICES"
                :key="format"
                class="am-chip"
                :class="{ 'am-chip--on': draft.formats.includes(format) }"
                type="button"
                @click="toggleFormat(format)"
              >
                {{ formatWord(format) ?? format }}
              </button>
            </div>
          </section>

          <section class="am-part">
            <h3 class="am-h3">Порядок</h3>
            <div class="am-seg">
              <button
                v-for="item in SORT_CHOICES"
                :key="item.key"
                class="am-seg__btn"
                :class="{ 'am-seg__btn--on': draft.sort === item.key }"
                type="button"
                @click="setSort(item.key)"
              >
                {{ item.title }}
              </button>
            </div>
          </section>

          <section class="am-part">
            <h3 class="am-h3">Тэги</h3>

            <div v-if="chosenTags.length > 0" class="am-wrap am-part__chosen">
              <button
                v-for="name in chosenTags"
                :key="name"
                class="am-chip am-chip--on"
                type="button"
                @click="toggleTag(name)"
              >
                {{ tagWord(name) }}
                <span class="am-chip__off" aria-hidden="true">×</span>
              </button>
            </div>

            <label class="am-search am-part__hunt">
              <span class="am-search__mark" aria-hidden="true">⌕</span>
              <input v-model="hunt" class="am-input" type="search" placeholder="Найти тэг" />
            </label>

            <p v-if="tagsBusy" class="am-dim">Поднимаем справочник тэгов…</p>

            <p v-else-if="pool.length === 0" class="am-dim">
              Справочник тэгов не доехал. Жанры, годы и форматы работают.
            </p>

            <template v-else-if="hunt.trim() !== ''">
              <div v-if="found.length > 0" class="am-wrap">
                <button
                  v-for="tag in found"
                  :key="tag.name"
                  class="am-chip"
                  :class="{ 'am-chip--on': draft.tags.includes(tag.name) }"
                  type="button"
                  @click="toggleTag(tag.name)"
                >
                  {{ tagWord(tag.name) }}
                </button>
              </div>
              <p v-else class="am-dim">Такого тэга нет.</p>
            </template>

            <ul v-else class="am-folds">
              <li v-for="group in groups" :key="group.key" class="am-fold">
                <button class="am-fold__hit" type="button" @click="toggleGroup(group.key)">
                  <span class="am-fold__name">{{ group.title }}</span>
                  <span v-if="groupCount(group) > 0" class="am-fold__num">
                    {{ groupCount(group) }}
                  </span>

                  <!-- Знак раскрытия нарисован, а не символом: шрифтовой ⌈ читался буквой «Г». -->
                  <span
                    class="am-fold__arrow"
                    :class="{ 'am-fold__arrow--on': openGroup === group.key }"
                    aria-hidden="true"
                  >
                    <svg class="am-fold__chev" viewBox="0 0 12 8">
                      <path d="M1.7 2.2 6 6.1 10.3 2.2" />
                    </svg>
                  </span>
                </button>

                <div v-if="openGroup === group.key" class="am-wrap am-fold__body">
                  <button
                    v-for="tag in group.items"
                    :key="tag.name"
                    class="am-chip"
                    :class="{ 'am-chip--on': draft.tags.includes(tag.name) }"
                    type="button"
                    @click="toggleTag(tag.name)"
                  >
                    {{ tagWord(tag.name) }}
                  </button>
                </div>
              </li>
            </ul>
          </section>
        </div>

        <footer class="am-sheet__foot">
          <button
            class="am-btn am-btn--ghost"
            type="button"
            :disabled="count === 0"
            @click="onReset"
          >
            Сбросить
          </button>
          <span class="am-bar__gap" />
          <button class="am-btn am-btn--soft" type="button" @click="onApply">Готово</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Меню поверх всего: витрина под ним остаётся на месте, чтобы возврат
   не сбрасывал прокрутку главной. */
.am-sheet {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(12px, 3vw, 32px);
}

/* Занавес — кнопка: клик мимо коробки закрывает, и это доступно с клавиатуры. */
.am-sheet__veil {
  position: absolute;
  inset: 0;
  padding: 0;
  cursor: default;
  background: var(--am-veil);
  border: 0;
  backdrop-filter: blur(6px);
  animation: am-sheet-veil var(--am-mid) var(--am-ease) both;
}

.am-sheet__box {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(760px, 100%);
  max-height: min(86vh, 900px);
  overflow: hidden;
  background: var(--am-panel);
  border: 1px solid var(--am-line);
  border-radius: var(--am-r-drop);
  box-shadow:
    var(--am-sh-2),
    inset 0 1px 0 var(--am-edge);
  animation: am-sheet-in var(--am-mid) var(--am-ease-soft) both;
}

@keyframes am-sheet-veil {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes am-sheet-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* Шапка и низ держатся на месте, ездит только середина: иначе «Готово»
   уезжает за край при длинном справочнике тэгов. */
.am-sheet__top,
.am-sheet__foot {
  display: flex;
  flex: 0 0 auto;
  gap: 10px;
  align-items: center;
  padding: 14px clamp(14px, 1.8vw, 22px);
  background: var(--am-panel-2);
}

.am-sheet__top {
  border-bottom: 1px solid var(--am-line-soft);
}

.am-sheet__foot {
  border-top: 1px solid var(--am-line-soft);
}

.am-sheet__num {
  padding: 2px 9px;
  font-size: 12px;
  font-weight: 700;
  color: var(--am-bg);
  background: linear-gradient(135deg, var(--am-accent), var(--am-accent-2));
  border-radius: var(--am-r-cap);
  font-variant-numeric: tabular-nums;
}

/* Цель нажатия 44px; круг и сакуру рисует вложенный слой, а кнопка остаётся
   прямоугольной ради цели и кольца фокуса. Оттенки цветка — от --am-hover. */
.am-sheet__close {
  --am-bloom-deep: var(--am-hover);
  --am-bloom-petal: color-mix(in srgb, var(--am-sakura) 30%, var(--am-hover));
  --am-bloom-shade: var(--am-sh-1);

  position: relative;
  display: grid;
  flex: none;
  place-items: center;
  width: var(--am-touch);
  height: var(--am-touch);
  padding: 0;
  font: inherit;
  font-size: 22px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: none;
  border: 0;

  /* Ничего не красит: держит круглым только кольцо :focus-visible. */
  border-radius: var(--am-r-cap);
  transition: color var(--am-fast) var(--am-ease);
}

.am-sheet__close:hover,
.am-sheet__close:focus-visible {
  color: var(--am-text);
}

/* Знак поднят над цветком: тот лежит своим слоем, а по правилам рисования
   слой накрывает обычное содержимое. Центровку держит place-items родителя. */
.am-sheet__close > span {
  position: relative;
  display: block;
  transition: transform var(--am-fast) var(--am-ease);
}

.am-sheet__close:hover > span,
.am-sheet__close:focus-visible > span {
  transform: translateY(-1px);
}

.am-sheet__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 20px;
  padding: clamp(14px, 1.8vw, 22px);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.am-part {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

/* Общий заголовок держит нижний отступ, а здесь расстояниями ведает gap. */
.am-part .am-h3 {
  margin: 0;
}

/* Поле поиска в колонке тянется на всю ширину: у общего .am-search
   расчёт на ряд контролок, а не на столбец раздела. */
.am-part__hunt {
  flex: 0 0 auto;
  width: 100%;
}

/* Выбранное отделено линией: строка «что уже набрано» читается первой. */
.am-part__chosen {
  padding-bottom: 10px;
  border-bottom: 1px dashed var(--am-line-soft);
}

.am-wrap {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.am-chip__off {
  margin-left: 2px;
  font-size: 13px;
  opacity: 0.7;
}

/* Группы тэгов: закрытая группа — одна строка, открытая отдаёт свои чипы. */
.am-folds {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 0;
  margin: 0;
  list-style: none;
}

.am-fold {
  overflow: hidden;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
}

.am-fold__hit {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
  min-height: var(--am-ctl);
  padding: 0 12px;
  font: inherit;
  font-size: 14px;
  color: var(--am-text);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  transition: background-color var(--am-fast) var(--am-ease);
}

.am-fold__hit:hover {
  background: var(--am-hover);
}

.am-fold__name {
  flex: 1 1 auto;
  min-width: 0;
}

.am-fold__num {
  padding: 1px 8px;
  font-size: 11px;
  font-weight: 700;
  color: var(--am-accent);
  background: var(--am-accent-soft);
  border-radius: var(--am-r-cap);
  font-variant-numeric: tabular-nums;
}

/* Стрелка раскрытия в своём квадрате: у рисунка нет базовой линии,
   и поворот идёт вокруг его собственного центра. */
.am-fold__arrow {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 20px;
  height: 20px;
  color: var(--am-faint);
  transition:
    color var(--am-fast) var(--am-ease),
    transform var(--am-mid) var(--am-ease);
}

.am-fold__hit:hover .am-fold__arrow {
  color: var(--am-text);
}

.am-fold__arrow--on {
  color: var(--am-accent);
  transform: rotate(180deg);
}

.am-fold__chev {
  width: 12px;
  height: 8px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.am-fold__body {
  padding: 4px 12px 12px;
}

.am-years {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}

.am-years__one {
  display: flex;
  flex: 1 1 140px;
  flex-direction: column;
  gap: 6px;
}

/* Своя пара стрелок вместо родного счётчика: место под них отведено
   отступом поля, чтобы цифры года не заезжали под кнопки. */
.am-year {
  position: relative;
  display: flex;
}

.am-year__field {
  width: 100%;
  padding-right: 36px;
  font-variant-numeric: tabular-nums;
}

.am-year__steps {
  position: absolute;
  top: 4px;
  right: 4px;
  bottom: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* Стрелки вне обхода клавишей: в самом поле год двигают вверх и вниз,
   и две лишние остановки на каждое поле только мешали бы. */
.am-year__step {
  display: flex;
  flex: 1 1 0;
  align-items: center;
  justify-content: center;
  width: 26px;
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

.am-year__step:hover:not(:disabled) {
  color: var(--am-text);
  background: var(--am-fill-2);
}

.am-year__step:active:not(:disabled) {
  background: var(--am-fill-3);
}

.am-year__step:disabled {
  color: var(--am-faint);
  cursor: default;
  background: none;
}

.am-year__arrow {
  width: 12px;
  height: 8px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.7;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* На узком экране меню становится нижним листом: коробка по центру
   на телефоне оставляла бы полосы пустоты сверху и снизу. */
@media (max-width: 640px) {
  .am-sheet {
    align-items: flex-end;
    padding: 0;
  }

  .am-sheet__box {
    width: 100%;
    max-height: 92vh;
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: var(--am-r-drop) var(--am-r-drop) 0 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .am-sheet__veil,
  .am-sheet__box {
    animation: none;
  }

  .am-sheet__close:hover > span,
  .am-sheet__close:focus-visible > span {
    transform: none;
  }

  .am-fold__arrow,
  .am-year__step {
    transition: none;
  }
}
</style>
