<script setup lang="ts">
// Пункт 3.9а: окно правки записи. Правит черновик, наружу — только «Готово»; телепорт в body,
// чтобы fixed не мерился от предка с трансформом. Потолок счёта сам ставит «Просмотрено».
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { partsWord, statusList, statusWord } from '../labels'

import DatePick from './DatePick.vue'
import SakuraBloom from './SakuraBloom.vue'

/** Шаг оценки. Десятибалльная шкала у AniList дробная, половины достаточно. */
const SCORE_STEP = 0.5

/** Сколько кнопка «Готово» держит подтверждение, прежде чем закрыть шторку. */
const SAVE_HOLD = 900

/** Быстрые оценки одним нажатием: целые баллы шкалы. */
const QUICK_MARKS: ReadonlyArray<number> = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]

/** Крайние тона шкалы оценок: единица красная, десятка зелёная. */
const MARK_TONE_MAX = 132

const props = defineProps<{
  title: string
  status: string
  score10: number
  progress: number
  partsTotal: number | null
  /** Идёт ли показ: у онгоинга потолок счёта — вышедшее, а не итог истории. */
  ongoing?: boolean
  repeat: number
  startedAt: string | null
  completedAt: string | null
  notes: string | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'status', value: string): void
  (e: 'score', value: number): void
  (e: 'progress', value: number): void
  (e: 'repeat', value: number): void
  (e: 'startedAt', value: string): void
  (e: 'completedAt', value: string): void
  (e: 'notes', value: string): void
}>()

// Закладки и подпись счёта теперь одни и те же: выбора вида больше нет,
// и пересчитывать их на каждую правку нечего.
const statuses = statusList()
const partsName = partsWord()

// Черновик записи: наружу уходит по «Готово». Даты — строками, как отдаёт DatePick,
// где пустая строка — «даты нет», поэтому сравнение с входом идёт через ?? ''.
const pickStatus = ref(props.status)
const pickScore = ref(props.score10)
const pickProgress = ref(props.progress)
const pickRepeat = ref(props.repeat)
const pickStarted = ref(props.startedAt ?? '')
const pickCompleted = ref(props.completedAt ?? '')

const nowStatus = computed(() => statusWord(pickStatus.value === '' ? null : pickStatus.value))

/** Строка счёта вида «7 из 12». Неизвестный итог не выдумывается. */
const partsText = computed(() =>
  props.partsTotal === null
    ? String(pickProgress.value)
    : `${pickProgress.value} из ${props.partsTotal}`,
)

/** Подпись прыжка к потолку: у онгоинга это край вышедшего, а не конец. */
const endHint = computed(() => (props.ongoing === true ? 'До вышедшего' : 'До конца'))

/** Доля пройденного для полосы. */
const donePart = computed(() => {
  const total = props.partsTotal
  if (total === null || total <= 0) return pickStatus.value === 'COMPLETED' ? '100%' : '0%'

  const part = Math.min(1, Math.max(0, pickProgress.value / total))
  return `${Math.round(part * 100)}%`
})

/** Черновик комментария: часть общего черновика, наружу уходит по «Готово». */
const draft = ref(props.notes ?? '')
let lastSent = props.notes ?? ''

/** Кнопка «Готово» отвечает «Сохранено» и держит ответ SAVE_HOLD. */
const saved = ref(false)
let hold: number | null = null

// Значение сверху могло измениться обновлением списка: подхватываем, но не
// затираем то, что человек уже набрал в поле.
watch(
  () => props.notes,
  (fresh) => {
    const known = fresh ?? ''
    if (draft.value.trim() === lastSent) draft.value = known
    lastSent = known
  },
)

function markText(value: number): string {
  return value > 0 ? value.toFixed(1) : '—'
}

/** Цвет балла по шкале от красного к зелёному; считается здесь, чтобы не плодить правила в стилях. */
function markStyle(mark: number): Record<string, string> {
  const tone = Math.round(((mark - 1) / (QUICK_MARKS.length - 1)) * MARK_TONE_MAX)

  return {
    '--am-mark': `hsl(${tone} 64% 46%)`,
    '--am-mark-deep': `hsl(${tone} 68% 34%)`,
  }
}

/** Оценка шагом шкалы, с обрезкой по краям: шкала списка — от 0 до 10. */
function bumpScore(delta: number): void {
  const next = Math.round((pickScore.value + delta) / SCORE_STEP) * SCORE_STEP
  pickScore.value = Math.min(10, Math.max(0, Math.round(next * 10) / 10))
}

function setScore(value: number): void {
  pickScore.value = value
}

/** Закладка и дата конца по достижении потолка счёта. Чужую дату не затираем;
 *  онгоинг сюда не доходит: его потолок — последняя вышедшая серия. */
function finishParts(): void {
  if (props.ongoing === true) return
  if (pickStatus.value !== 'COMPLETED') pickStatus.value = 'COMPLETED'
  if (pickCompleted.value === '') pickCompleted.value = today()
}

/** Счёт серий шагом. Выше известного итога не пускаем: больше, чем есть, не посмотришь. */
function bumpProgress(delta: number): void {
  const total = props.partsTotal
  const next = pickProgress.value + delta
  pickProgress.value = Math.max(0, total === null ? next : Math.min(total, next))

  if (total !== null && pickProgress.value >= total) finishParts()
}

/** Прыжок к началу счёта. Закладку не трогает: ноль серий — это не «брошено». */
function resetParts(): void {
  pickProgress.value = 0
}

/** Прыжок к потолку: счёт до края и закладка вслед — ⇥ и есть просьба закончить. */
function fillParts(): void {
  const total = props.partsTotal
  if (total === null) return

  pickProgress.value = total
  finishParts()
}

/** Пересмотры. Потолка у них нет, а ниже нуля уходить бессмысленно. */
function bumpRepeat(delta: number): void {
  pickRepeat.value = Math.max(0, pickRepeat.value + delta)
}

/** Сегодняшний день в виде ГГГГ-ММ-ДД. Через метку времени день съезжал бы. */
function today(): string {
  const now = new Date()
  const month = now.getMonth() + 1
  const day = now.getDate()
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  return `${now.getFullYear()}-${pad(month)}-${pad(day)}`
}

function onStarted(value: string): void {
  pickStarted.value = value
}

function onCompleted(value: string): void {
  pickCompleted.value = value
}

/** Разошёлся ли черновик с тем, что пришло сверху. */
function hasEdits(): boolean {
  return (
    pickStatus.value !== props.status ||
    pickScore.value !== props.score10 ||
    pickProgress.value !== props.progress ||
    pickRepeat.value !== props.repeat ||
    pickStarted.value !== (props.startedAt ?? '') ||
    pickCompleted.value !== (props.completedAt ?? '') ||
    draft.value.trim() !== lastSent
  )
}

/** Отдаёт наружу только разошедшиеся поля: лишняя правка — лишняя запись в журнал.
 *  Пустая строка в датах значит «стереть». */
function commit(): void {
  if (pickStatus.value !== props.status) emit('status', pickStatus.value)
  if (pickScore.value !== props.score10) emit('score', pickScore.value)
  if (pickProgress.value !== props.progress) emit('progress', pickProgress.value)
  if (pickRepeat.value !== props.repeat) emit('repeat', pickRepeat.value)
  if (pickStarted.value !== (props.startedAt ?? '')) emit('startedAt', pickStarted.value)
  if (pickCompleted.value !== (props.completedAt ?? '')) emit('completedAt', pickCompleted.value)

  const asked = draft.value.trim()
  if (asked === lastSent) return
  lastSent = asked
  emit('notes', asked)
}

/** «Готово»: сохраняет черновик и отвечает на кнопке. */
function onDone(): void {
  // Повторное нажатие во время подтверждения: закрытие уже назначено.
  if (saved.value) return

  if (!hasEdits()) {
    emit('close')
    return
  }

  commit()
  saved.value = true
  hold = window.setTimeout(() => emit('close'), SAVE_HOLD)
}

/** Крестик, подложка и Escape: черновик выбрасывается — потеря набранного и есть смысл пути. */
function onDrop(): void {
  emit('close')
}

/** Закрытие по Escape: окно поверх экрана без этого раздражает. */
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') onDrop()
}

onMounted(() => {
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  // Таймер держит ссылку на шторку: без снятия он дотянет до закрытия
  // уже убранного окна, а emit('close') после этого — лишний.
  if (hold !== null) clearTimeout(hold)
})
</script>

<template>
  <!-- Перенос в body: причина в шапке файла, коротко — fixed внутри экрана
       мерился от списка, а не от окна браузера. -->
  <Teleport to="body">
    <div class="am-sheet" role="dialog" aria-modal="true" @click.self="onDrop">
      <div class="am-sheet__box">
        <header class="am-sheet__top">
          <div class="am-sheet__text">
            <span class="am-sheet__kicker">{{ nowStatus ?? 'Не в списке' }}</span>
            <h3 class="am-sheet__name">{{ title }}</h3>
          </div>

          <!-- Подпись своя: знак спрятан от чтецов, а подсказка отдельным слоем именем не становится.
               Говорит «без сохранения»: крестик выбрасывает правки, и молчать об этом нельзя. -->
          <button
            v-tip="'Закрыть без сохранения'"
            class="am-sheet__close"
            type="button"
            aria-label="Закрыть без сохранения"
            @click="onDrop"
          >
            <SakuraBloom />
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div class="am-sheet__body">
          <section class="am-field am-field--wide">
            <span class="am-field__name">Закладка</span>
            <div class="am-picks">
              <button
                v-for="item in statuses"
                :key="item.key"
                class="am-pick"
                :class="{ 'am-pick--on': item.key === pickStatus }"
                type="button"
                @click="pickStatus = item.key"
              >
                {{ item.title }}
              </button>
            </div>
          </section>

          <section class="am-field am-field--wide">
            <span class="am-field__name">Оценка</span>
            <div class="am-step-row">
              <button
                v-tip="'Меньше'"
                class="am-step"
                type="button"
                aria-label="Меньше"
                @click="bumpScore(-SCORE_STEP)"
              >
                <SakuraBloom />
                <span aria-hidden="true">−</span>
              </button>
              <span class="am-step__value">{{ markText(pickScore) }}</span>
              <button
                v-tip="'Больше'"
                class="am-step"
                type="button"
                aria-label="Больше"
                @click="bumpScore(SCORE_STEP)"
              >
                <SakuraBloom />
                <span aria-hidden="true">+</span>
              </button>
            </div>

            <div class="am-picks am-picks--mid">
              <button
                v-for="mark in QUICK_MARKS"
                :key="mark"
                class="am-pick am-pick--num"
                :class="{ 'am-pick--on': mark === pickScore }"
                :style="markStyle(mark)"
                type="button"
                @click="setScore(mark)"
              >
                {{ mark }}
              </button>
            </div>
          </section>

          <section class="am-field">
            <span class="am-field__name">{{ partsName }}</span>

            <!-- Прыжок к потолку живёт только при известном потолке: без итога
                 ехать некуда, и кнопка-обманка в ряду хуже её отсутствия. -->
            <div class="am-step-row am-step-row--ends">
              <button
                v-tip="'В начало'"
                class="am-step"
                type="button"
                aria-label="В начало"
                @click="resetParts"
              >
                <SakuraBloom />
                <span aria-hidden="true">⇤</span>
              </button>
              <button
                v-tip="'Меньше'"
                class="am-step"
                type="button"
                aria-label="Меньше"
                @click="bumpProgress(-1)"
              >
                <SakuraBloom />
                <span aria-hidden="true">−</span>
              </button>
              <span class="am-step__value">{{ partsText }}</span>
              <button
                v-tip="'Больше'"
                class="am-step"
                type="button"
                aria-label="Больше"
                @click="bumpProgress(1)"
              >
                <SakuraBloom />
                <span aria-hidden="true">+</span>
              </button>
              <button
                v-if="partsTotal !== null"
                v-tip="endHint"
                class="am-step"
                type="button"
                :aria-label="endHint"
                @click="fillParts"
              >
                <SakuraBloom />
                <span aria-hidden="true">⇥</span>
              </button>
            </div>

            <span class="am-line">
              <span class="am-line__fill" :style="{ width: donePart }" />
            </span>
          </section>

          <section class="am-field">
            <span class="am-field__name">Пересмотры</span>
            <div class="am-step-row">
              <button
                v-tip="'Меньше'"
                class="am-step"
                type="button"
                aria-label="Меньше"
                @click="bumpRepeat(-1)"
              >
                <SakuraBloom />
                <span aria-hidden="true">−</span>
              </button>
              <span class="am-step__value">{{ pickRepeat }}</span>
              <button
                v-tip="'Больше'"
                class="am-step"
                type="button"
                aria-label="Больше"
                @click="bumpRepeat(1)"
              >
                <SakuraBloom />
                <span aria-hidden="true">+</span>
              </button>
            </div>
          </section>

          <section class="am-field">
            <span class="am-field__name">Начато</span>
            <DatePick :value="pickStarted" title="Начато" @pick="onStarted" />
          </section>

          <section class="am-field">
            <span class="am-field__name">Закончено</span>
            <DatePick :value="pickCompleted" title="Закончено" @pick="onCompleted" />
          </section>

          <section class="am-field am-field--wide">
            <span class="am-field__name">Комментарий</span>
            <textarea
              v-model="draft"
              class="am-input am-note"
              rows="3"
              placeholder="Личная заметка, остаётся в вашем списке"
            />
          </section>
        </div>

        <footer class="am-sheet__foot">
          <span class="am-bar__gap" />

          <button class="am-btn" :class="{ 'am-btn--done': saved }" type="button" @click="onDone">
            <svg v-if="saved" class="am-btn__tick" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3.4 8.5 6.4 11.5 12.6 5" />
            </svg>
            {{ saved ? 'Сохранено' : 'Готово' }}
          </button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Затемнение на всё окно браузера: живёт в body, поэтому inset — честно весь видимый прямоугольник. */
.am-sheet {
  position: fixed;
  inset: 0;
  z-index: 30;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(12px, 3vw, 40px);
  background: var(--am-veil);
  backdrop-filter: blur(8px);
  animation: am-veil-in var(--am-mid) var(--am-ease-soft) both;
}

/* Стеклянная коробка тремя этажами: шапка и подвал стоят,
   прокручивается только середина — иначе кнопка «Готово» уезжала вниз. */
.am-sheet__box {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto;
  gap: 16px;
  width: 100%;
  max-width: 920px;
  max-height: min(90vh, 940px);
  padding: clamp(18px, 2.2vw, 28px);
  overflow: hidden;
  background: linear-gradient(165deg, var(--am-glass-2), var(--am-glass));
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-xl);
  box-shadow:
    var(--am-sh-2),
    inset 0 1px 0 var(--am-edge);
  backdrop-filter: blur(var(--am-blur-strong)) saturate(1.5);
  animation: am-sheet-in var(--am-mid) var(--am-ease) both;
}

@keyframes am-veil-in {
  from {
    opacity: 0;
  }
}

@keyframes am-sheet-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.985);
  }
}

.am-sheet__top {
  display: flex;
  gap: 14px;
  align-items: flex-start;
}

.am-sheet__text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.am-sheet__kicker {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--am-accent);
  text-transform: uppercase;
}

.am-sheet__name {
  margin: 0;
  font-size: clamp(18px, 1.8vw, 24px);
  font-weight: 700;
  line-height: 1.22;
  letter-spacing: -0.01em;
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
  margin-left: auto;
  padding: 0;
  font: inherit;
  font-size: 22px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: none;
  border: 0;

  /* Ничего не красит: держит круглым только кольцо :focus-visible,
     у которого свой outline-offset. */
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

/* Сетка полей: на широком окне два столбца, на узком один. */
.am-sheet__body {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  padding-right: 4px;
  overflow-y: auto;
}

/* Закладки, оценка и комментарий занимают всю ширину: рядов там много. */
.am-field--wide {
  grid-column: 1 / -1;
}

/* Панель поля: подпись сверху, содержимое под ней. */
.am-field {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 15px 16px;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-l);
}

.am-field__name {
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.07em;
  color: var(--am-faint);
  text-transform: uppercase;
}

.am-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

/* Своя обёртка для шкалы оценок: ряд закладок остаётся прижатым влево. */
.am-picks--mid {
  justify-content: center;
}

/* Цель нажатия 44 пикселя по высоте: правило пульта и пальца заодно. */
.am-pick {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: var(--am-touch);
  padding: 0 18px;
  font: inherit;
  font-size: 14px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-fill-2);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease);
}

.am-pick:hover {
  color: var(--am-text);
  background: var(--am-hover);
}

.am-pick--on {
  color: var(--am-bg);
  background: linear-gradient(135deg, var(--am-accent), var(--am-accent-2));
  border-color: transparent;
  box-shadow: var(--am-sh-glow);
}

/* Балл красится своим тоном шкалы: правила ниже перебивают общую заливку.
   Тон считается в скрипте, поэтому подпись живёт в своём --am-on-mark. */
.am-pick--num {
  --am-on-mark: #f7fbff;

  min-width: 52px;
  font-weight: 700;
  color: var(--am-on-mark);
  background: linear-gradient(180deg, var(--am-mark), var(--am-mark-deep));
  border-color: var(--am-line-soft);
  border-radius: var(--am-r-m);
  opacity: 0.58;
  transition:
    opacity var(--am-fast) var(--am-ease),
    box-shadow var(--am-fast) var(--am-ease),
    border-radius var(--am-mid) var(--am-ease);
}

.am-pick--num:hover {
  color: var(--am-on-mark);
  background: linear-gradient(180deg, var(--am-mark), var(--am-mark-deep));
  border-radius: var(--am-r-drop);
  opacity: 0.88;
}

.am-pick--num.am-pick--on {
  color: var(--am-on-mark);
  background: linear-gradient(180deg, var(--am-mark), var(--am-mark-deep));
  border-color: var(--am-edge);
  border-radius: var(--am-r-drop);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--am-mark) 45%, transparent);
  opacity: 1;
}

.am-step-row {
  display: flex;
  gap: 12px;
  align-items: center;
}

/* Пять кнопок в ряду вместо трёх: при общем шаге 12 они выдавливали
   само число счёта в две строки на узком окне. */
.am-step-row--ends {
  gap: 8px;
}

/* Своя заливка шагу не нужна: круг и сакуру рисует вложенный слой.
   position — якорь: слой цветка absolute и без него уехал бы к краю окна. */
.am-step {
  --am-bloom-deep: var(--am-hover);
  --am-bloom-petal: color-mix(in srgb, var(--am-sakura) 30%, var(--am-hover));
  --am-bloom-shade: var(--am-sh-1);

  position: relative;
  display: grid;
  place-items: center;
  width: var(--am-touch);
  height: var(--am-touch);
  padding: 0;
  font: inherit;
  font-size: 20px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  transition: color var(--am-fast) var(--am-ease);
}

.am-step:hover,
.am-step:focus-visible {
  color: var(--am-text);
}

/* Тот же подъём знака над цветком, что и у кнопки закрытия. */
.am-step > span {
  position: relative;
  display: block;
}

.am-step__value {
  flex: 1;
  font-size: 17px;
  font-weight: 700;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* Заметка не круглая: скругление полей ввода на большом поле смотрится нелепо. */
.am-note {
  min-height: 96px;
  padding: 12px 14px;
  font: inherit;
  line-height: 1.5;
  background: var(--am-fill-2);
  border-radius: var(--am-r-m);
  resize: vertical;
}

.am-sheet__foot {
  display: flex;
  gap: 10px;
  align-items: center;
}

/* Подтверждение — зелёный цвет и галочка: по одному слову смену кнопки не распознать.
   Обводку не трогаю: --am-good-rgb в теме нет. */
.am-btn--done {
  color: var(--am-good);
}

/* Галочка штрихом, а не заливкой: на пятнадцати пикселях залитый
   знак расплывается в кляксу, а штрих держит форму. */
.am-btn__tick {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentcolor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Узкое окно: столбец один, иначе поля сжимаются до нечитаемых. */
@media (max-width: 760px) {
  .am-sheet__body {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (prefers-reduced-motion: reduce) {
  .am-sheet,
  .am-sheet__box {
    animation: none;
  }

  .am-sheet__close:hover > span,
  .am-sheet__close:focus-visible > span {
    transform: none;
  }
}
</style>
