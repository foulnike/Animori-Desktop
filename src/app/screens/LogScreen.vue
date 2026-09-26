<script setup lang="ts">
// Читатель журнала: раньше записи шли в кольцевой буфер без читателя, а DB/API не доезжали никуда.
// Экран — единственный способ попросить «что в журнале»; здесь же счётчики бюджета источников и склада.
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { collectRateStats, type RateLimiterStats } from '@/api/rate-limit'
import { Bridge } from '@/bridge'
import { getDbStats } from '@/core/db'
import type { DbStats } from '@/core/types'
import { clearLogs, readLogs, registerLogSink, type LogEntry, type LogType } from '@/utils/logger'

import EmptyMark from '../components/EmptyMark.vue'

/** Виды записей для отбора; порядок по частоте вопроса: сначала «что сломалось», потом «что происходило». */
const KINDS: ReadonlyArray<LogType> = ['ERROR', 'WARN', 'INFO', 'API', 'DB']

/** Сколько строк рисуем разом: показ всех пятисот заметен глазом, а читают всегда свежие. */
const PAGE = 120

/** Как часто обновляется бюджет, пока панель открыта. Чаще секунды читать нечего. */
const BUDGET_TICK_MS = 1000

const rows = ref<LogEntry[]>([])
const kind = ref<LogType | 'all'>('all')
const limit = ref(PAGE)
const note = ref('')

/** Развёрнутые подробности: по номеру записи, а не флагом в самой записи. */
const opened = ref<Set<number>>(new Set())

const budgetOn = ref(false)
const budget = ref<RateLimiterStats[]>([])
let budgetTimer: number | undefined

const store = ref<DbStats | null>(null)
const storeNote = ref('')
const storeBusy = ref(false)

/** Свежие сверху: читают последнее, а не первое. */
function fresh(all: ReadonlyArray<LogEntry>): LogEntry[] {
  const picked = kind.value === 'all' ? all : all.filter((entry) => entry.type === kind.value)
  return picked.slice(-limit.value).reverse()
}

function redraw(): void {
  rows.value = fresh(readLogs())
}

/** Подписка на поток; перерисовка целиком: отбор и потолок считаются по всему буферу. */
function onEntry(): void {
  redraw()
}

function pick(next: LogType | 'all'): void {
  kind.value = next
  limit.value = PAGE
  note.value = ''
  redraw()
}

function onMore(): void {
  limit.value += PAGE
  redraw()
}

function toggle(id: number): void {
  const next = new Set(opened.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  opened.value = next
}

function refreshBudget(): void {
  budget.value = collectRateStats()
}

/** Панель бюджета опрашивается только открытой: опрос ради закрытой панели — та же расточительность. */
function toggleBudget(): void {
  budgetOn.value = !budgetOn.value

  if (!budgetOn.value) {
    if (budgetTimer !== undefined) window.clearInterval(budgetTimer)
    budgetTimer = undefined
    return
  }

  refreshBudget()
  budgetTimer = window.setInterval(refreshBudget, BUDGET_TICK_MS)
}

/** Секунды для человека: «12 с» читается быстрее, чем 11713 мс. */
function secs(ms: number): string {
  return `${Math.ceil(ms / 1000)} с`
}

/** Склад считается по кнопке: getDbStats обходит все ключи mediaCache, а открытый экран не должен
 *  стоить полного обхода базы каждую секунду. */
async function onStore(): Promise<void> {
  storeBusy.value = true
  storeNote.value = ''

  const res = await getDbStats()
  storeBusy.value = false

  if ('error' in res) {
    store.value = null
    storeNote.value = res.error
    return
  }

  store.value = res
}

/** Подробности строкой. Ошибка разбора не должна ронять сам просмотрщик. */
function detailsText(entry: LogEntry): string {
  if (entry.details === null || entry.details === undefined) return ''

  try {
    return typeof entry.details === 'string'
      ? entry.details
      : JSON.stringify(entry.details, null, 2)
  } catch {
    return String(entry.details)
  }
}

function hasMore(entry: LogEntry): boolean {
  return (
    (entry.details !== null && entry.details !== undefined && entry.details !== '') ||
    entry.stack !== ''
  )
}

/** Журнал в буфер обмена: уходит то, что видно на экране, вместе с отбором. */
function onCopy(): void {
  const text = rows.value
    .map((entry) => {
      const head = `${entry.time} [${entry.type}] ${entry.message}`
      const tail = detailsText(entry)
      return tail === '' ? head : `${head}\n${tail}`
    })
    .join('\n\n')

  if (text === '') {
    note.value = 'Копировать нечего: журнал пуст.'
    return
  }

  void Bridge.clipboard
    .writeText(text)
    .then(() => {
      note.value = `Скопировано записей: ${rows.value.length}.`
    })
    .catch(() => {
      // Молчать нельзя: кнопка, которая не сработала и не сказала, выглядит поломкой.
      note.value = 'Буфер обмена недоступен.'
    })
}

function onClear(): void {
  clearLogs()
  opened.value = new Set()
  note.value = 'Журнал очищен.'
  redraw()
}

onMounted(() => {
  registerLogSink(onEntry)
  redraw()
})

onBeforeUnmount(() => {
  // Снимать обязательно: иначе подписка переживёт экран и будет дёргать
  // перерисовку выброшенных строк до конца жизни окна.
  registerLogSink(null)

  // То же и с опросом бюджета: экран закрыт, а таймер тикал бы до конца сессии.
  if (budgetTimer !== undefined) window.clearInterval(budgetTimer)
})
</script>

<template>
  <section class="am-page">
    <div class="am-log__top">
      <h2 class="am-h2">Журнал</h2>
      <span v-tip="'Строк на экране'" class="am-log__num">{{ rows.length }}</span>
      <span class="am-bar__gap" />
      <button class="am-btn am-btn--soft" type="button" @click="onCopy">Скопировать</button>
      <button class="am-btn am-btn--ghost" type="button" @click="onClear">Очистить</button>
    </div>

    <div class="am-log__kinds">
      <div class="am-seg">
        <button
          class="am-seg__btn"
          :class="{ 'am-seg__btn--on': kind === 'all' }"
          type="button"
          @click="pick('all')"
        >
          Все
        </button>
        <button
          v-for="one in KINDS"
          :key="one"
          class="am-seg__btn"
          :class="{ 'am-seg__btn--on': kind === one }"
          type="button"
          @click="pick(one)"
        >
          {{ one }}
        </button>
      </div>

      <span v-if="note" class="am-meta">{{ note }}</span>
    </div>

    <div class="am-log__tools">
      <button class="am-btn am-btn--soft" type="button" @click="toggleBudget">
        {{ budgetOn ? 'Скрыть бюджет' : 'Бюджет источников' }}
      </button>
      <button class="am-btn am-btn--soft" type="button" :disabled="storeBusy" @click="onStore">
        {{ storeBusy ? 'Считаем склад…' : 'Пересчитать склад' }}
      </button>
      <span v-if="storeNote" class="am-meta">{{ storeNote }}</span>
    </div>

    <div v-if="budgetOn" class="am-log__panel">
      <table class="am-log__grid">
        <thead>
          <tr>
            <th>Источник</th>
            <th>В окне</th>
            <th>Осталось</th>
            <th>Темп</th>
            <th>Пауза</th>
            <th>Ушло всего</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="one in budget" :key="one.name">
            <td>{{ one.name }}</td>
            <td>{{ one.inWindow }} / {{ one.ceiling }}</td>
            <td>{{ one.remaining }}</td>
            <td>{{ one.intervalMs }} мс</td>
            <td>{{ one.pauseRemaining > 0 ? secs(one.pauseRemaining) : '—' }}</td>
            <td>{{ one.sentTotal }}</td>
          </tr>
        </tbody>
      </table>
      <p class="am-meta">
        Окно учёта — минута. «Ушло всего» считается с запуска программы: это и есть
        цена сеанса для чужих серверов.
      </p>
    </div>

    <div v-if="store" class="am-log__panel">
      <ul class="am-log__store">
        <li><span>Русские названия</span><b>{{ store.russianTitles }}</b></li>
        <li><span>Отказы «имени нет»</span><b>{{ store.noRussianNames }}</b></li>
        <li><span>Облики плиток</span><b>{{ store.looks }}</b></li>
        <li><span>Метки доступности</span><b>{{ store.playable }}</b></li>
        <li><span>Соответствия Aniliberty</span><b>{{ store.anilibertyLinks }}</b></li>
        <li><span>Кадры и ролики</span><b>{{ store.screenshots }}</b></li>
        <li><span>Персонажи</span><b>{{ store.characters }}</b></li>
        <li><span>Персонал</span><b>{{ store.staff }}</b></li>
        <li><span>Темы</span><b>{{ store.themes }}</b></li>
        <li><span>Оценки площадок</span><b>{{ store.ratings }}</b></li>
        <li><span>Карточки тайтлов</span><b>{{ store.media }}</b></li>
        <li><span>Номера MAL</span><b>{{ store.malMappings }}</b></li>
        <li><span>Франшизы</span><b>{{ store.franchises }}</b></li>
        <li><span>Прочее</span><b>{{ store.other }}</b></li>
        <li class="am-log__store--sum">
          <span>Всего записей</span><b>{{ store.totalCacheRecords }}</b>
        </li>
        <li class="am-log__store--sum"><span>Занято</span><b>{{ store.estimatedSize }}</b></li>
      </ul>
      <p class="am-meta">
        Каждая запись здесь — запрос, которого мы больше не делаем. Ноль у номеров
        MAL правдив: стор заведён миграцией, но писать в него некому — пары номеров
        добываются заново при каждом запуске.
      </p>
    </div>

    <div v-if="rows.length === 0" class="am-empty">
      <span class="am-empty__mark"><EmptyMark name="journal" /></span>
      <span>Записей нет. Журнал пишется, пока открыто окно.</span>
    </div>

    <ul v-else class="am-log">
      <li v-for="entry in rows" :key="entry.id" class="am-log__row" :data-kind="entry.type">
        <div class="am-log__head">
          <span class="am-log__kind">{{ entry.type }}</span>
          <span class="am-log__time">{{ entry.time }}</span>
          <span class="am-log__text">{{ entry.message }}</span>
          <button
            v-if="hasMore(entry)"
            class="am-btn am-btn--ghost am-log__open"
            type="button"
            @click="toggle(entry.id)"
          >
            {{ opened.has(entry.id) ? 'Свернуть' : 'Подробнее' }}
          </button>
        </div>

        <pre v-if="opened.has(entry.id) && detailsText(entry) !== ''" class="am-log__body">{{
          detailsText(entry)
        }}</pre>
        <pre v-if="opened.has(entry.id) && entry.stack !== ''" class="am-log__body am-dim">{{
          entry.stack
        }}</pre>
      </li>
    </ul>

    <div v-if="rows.length >= limit" class="am-log__more">
      <button class="am-btn am-btn--soft" type="button" @click="onMore">Показать ещё</button>
    </div>
  </section>
</template>

<style scoped>
/* Шапка, счётчик и две кнопки в одной полосе: три строки подряд
   съедали первый экран ради трёх коротких подписей. */
.am-log__top {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.am-log__num {
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--am-dim);
  background: var(--am-fill-2);
  border-radius: var(--am-r-cap);
  font-variant-numeric: tabular-nums;
}

/* Пять видов и «Все» в капсуле: на узком окне ряд прокручивается, а не ломается. */
.am-log__kinds {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.am-log__kinds .am-seg {
  max-width: 100%;
  overflow-x: auto;
  scrollbar-width: none;
}

.am-log__kinds .am-seg::-webkit-scrollbar {
  height: 0;
}

.am-log__kinds .am-seg__btn {
  flex: 0 0 auto;
}

/* Две кнопки счётчиков стоят своей полосой, а не в шапке: там уже живут
   действия над самим журналом, и путать их не надо. */
.am-log__tools {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
}

.am-log__panel {
  padding: 12px 14px;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
}

.am-log__panel .am-meta {
  display: block;
  margin: 10px 0 0;
}

.am-log__grid {
  width: 100%;
  font-size: 13px;
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}

.am-log__grid th {
  padding: 0 10px 8px 0;
  font-size: 11px;
  font-weight: 700;
  color: var(--am-faint);
  text-align: left;
  letter-spacing: 0.04em;
}

.am-log__grid td {
  padding: 6px 10px 6px 0;
  color: var(--am-text);
  border-top: 1px solid var(--am-line-soft);
}

/* Склад — не таблица: пар «что» и «сколько» много, а колонок всего две,
   и на узком окне сетка ложится в один столбец сама. */
.am-log__store {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 4px 18px;
  margin: 0;
  padding: 0;
  font-size: 13px;
  list-style: none;
}

.am-log__store li {
  display: flex;
  gap: 10px;
  align-items: baseline;
  justify-content: space-between;
  padding: 5px 0;
  border-bottom: 1px solid var(--am-line-soft);
}

.am-log__store span {
  color: var(--am-dim);
}

.am-log__store b {
  color: var(--am-text);
  font-variant-numeric: tabular-nums;
}

.am-log__store--sum b {
  color: var(--am-accent);
}

.am-log {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Строка — не панель со стеклом: сто двадцать размытий за кадр
   видно глазом. Цвет вида записи живёт одним --am-tint. */
.am-log__row {
  --am-tint: var(--am-faint);

  padding: 8px 12px;
  background: var(--am-fill-1);
  border-left: 2px solid var(--am-tint);
  border-radius: 0 var(--am-r-m) var(--am-r-m) 0;
  transition: background-color var(--am-fast) var(--am-ease);
}

.am-log__row:hover {
  background: var(--am-fill-2);
}

.am-log__row[data-kind='ERROR'] {
  --am-tint: var(--am-bad);
}

.am-log__row[data-kind='WARN'] {
  --am-tint: var(--am-warn);
}

.am-log__row[data-kind='DB'] {
  --am-tint: var(--am-good);
}

.am-log__row[data-kind='API'] {
  --am-tint: var(--am-accent);
}

.am-log__head {
  display: flex;
  gap: 10px;
  align-items: baseline;
}

/* Вид записи цветом: глаз находит ошибку в потоке быстрее, чем читает слово. */
.am-log__kind {
  flex: 0 0 auto;
  min-width: 54px;
  font-size: 11px;
  font-weight: 700;
  color: var(--am-tint);
  letter-spacing: 0.04em;
}

.am-log__time {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--am-faint);
  font-variant-numeric: tabular-nums;
}

.am-log__text {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 13px;
  color: var(--am-text);
  overflow-wrap: anywhere;
}

.am-log__open {
  flex: 0 0 auto;
  min-height: 28px;
  padding: 0 12px;
  font-size: 12px;
}

/* Подробности переносятся: строка запроса длиннее окна, а горизонтальная
   прокрутка внутри списка ломает чтение остального. */
.am-log__body {
  margin: 8px 0 0;
  padding: 10px 12px;
  font-size: 12px;
  line-height: 1.45;
  white-space: pre-wrap;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-s);
  overflow-wrap: anywhere;
}

.am-log__more {
  display: flex;
  justify-content: center;
  padding: 10px 0;
}
</style>
