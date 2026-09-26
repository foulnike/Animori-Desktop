<script setup lang="ts">
// Пункт 3.5: свой список одним экраном; данные — в коллекции, сборка строки — в lists-row, здесь отбор.
// Правка записи — окном поверх списка из памяти коллекции; метки доступности — по показу плиток (v-seen).
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import { keepAllowed } from '@/core/adult'
import { editEntry, getEntry, initCollection } from '@/core/collection'
import { countByStatus, countEntries, selectEntries } from '@/core/collection-view'
import { partsCeiling, peekLook } from '@/core/media-looks'
import { searchOwnList } from '@/core/media-search'
import type { SnapshotEntry } from '@/core/snapshot'
import { Logger } from '@/utils/logger'

import EmptyMark from '../components/EmptyMark.vue'
import EntrySheet from '../components/EntrySheet.vue'
import MediaRow from '../components/MediaRow.vue'
import MediaTile from '../components/MediaTile.vue'
import PickBox from '../components/PickBox.vue'
import { statusList } from '../labels'
import { navigate } from '../router'

import {
  keptSort,
  keptStatus,
  keptView,
  keptWord,
  type SortName,
  type ViewName,
} from './lists-keep'
import { sortEntries, toRow, useRowWarm, type Row } from './lists-row'

/** Сколько записей рисуется за раз: список бывает на тысячи, и каждая требует обложки и названия. */
const PAGE_LIMIT = 100

/** Сколько найденного показывать. Слово из двух букв иначе вывалит весь список. */
const FOUND_LIMIT = 60

/** Пауза после последнего нажатия. Поиск идёт в памяти, поэтому пауза короткая. */
const TYPING_PAUSE_MS = 250

/** Сколько плиток-заглушек показать на время подъёма списка. */
const HOLD_COUNT = 18

/** Столько же заглушек строками: строк на экран влезает больше, чем плиток. */
const HOLD_LINES = 12

/** За сколько до конца списка заказывать добор: раньше видного края. */
const TAIL_MARGIN = '600px'

/** Порядки показа. Все считаются на месте: сети сортировка не требует. */
const SORT_TABS: ReadonlyArray<{ key: SortName; title: string }> = [
  { key: 'updated', title: 'Свежие правки' },
  { key: 'score', title: 'Своя оценка' },
  { key: 'rating', title: 'Оценка каталога' },
  { key: 'nameUp', title: 'Название А—Я' },
  { key: 'nameDown', title: 'Название Я—А' },
]

/** Виды показа: в закладке на тысячу строка читается быстрее постера. */
const VIEW_TABS: ReadonlyArray<{ key: ViewName; title: string; icon: string }> = [
  { key: 'tiles', title: 'Большие постеры', icon: '▦' },
  { key: 'slim', title: 'Компактные строки', icon: '≡' },
  { key: 'wide', title: 'Строки с постером', icon: '▤' },
]

/** Виды правки, доступные со списка. Удаление записи сюда не входит. */
type EntryEdit = 'status' | 'score' | 'progress' | 'repeat' | 'startedAt' | 'completedAt' | 'notes'

/** Идёт ли работа со списком: подъём снимка с диска. */
const busy = ref(true)

/** Идёт ли отбор по слову. На кириллице перед отбором поднимается склад. */
const searchBusy = ref(false)

const trouble = ref('')

// Закладка, порядок, вид и слово берутся из памяти между показами:
// иначе возврат с карточки открывал чужую закладку.
const activeStatus = keptStatus
const sortKey = keptSort
const view = keptView
const word = keptWord

const rows = ref<Row[]>([])
const counts = ref<Map<string, number>>(new Map())
const total = ref(0)

/** Сколько строк показываем: растёт шагом PAGE_LIMIT, на смене отбора возвращается к первой сотне. */
const limit = ref(PAGE_LIMIT)

/** Сколько строк отобралось до обрезки потолком. */
const picked = ref(0)

/** Сколько строк спрятал тумблер 18+: нужно подписи под списком, иначе счёт читался бы потерей данных. */
const hidden = ref(0)

/** Метка конца списка: по её появлению в окне заказывается добор. */
const tailMark = ref<HTMLElement | null>(null)

/** Номер записи в правке. Ноль — окно закрыто. */
const editId = ref(0)

/** Название для шапки окна: запоминается при открытии, см шапку файла. */
const editName = ref('')

/** Счётчик правок: мап коллекции вне реактивности Vue и пересчёт не закажет. */
const editStamp = ref(0)

/** Закладки статуса. Список теперь одного вида, и подписи у него одни. */
const statusTabs = statusList()

const searching = computed(() => word.value.trim() !== '')
const shown = computed(() =>
  searching.value ? total.value : (counts.value.get(activeStatus.value) ?? 0),
)

/** Остался ли хвост за потолком. */
const hasMore = computed(() => picked.value > rows.value.length)

/** Сколько ещё скрыто: число на кнопке честнее голого «ещё». */
const restCount = computed(() => Math.max(0, picked.value - rows.value.length))

/** Запись в правке из памяти коллекции. undefined — окно не показывается. */
const editRow = computed<SnapshotEntry | undefined>(() => {
  void editStamp.value
  return editId.value > 0 ? getEntry(editId.value) : undefined
})

/** Закладка записи для окна правки: у записи её может не быть, и окну годится пустая строка —
 *  подставлять открытую закладку списка нельзя. */
const editStatus = computed<string>(() => editRow.value?.status ?? '')

/** Облик правимого аниме из склада: оттуда берётся потолок счёта серий. */
const editLook = computed(() => (editId.value > 0 ? peekLook(editId.value) : null))

/** Сколько серий уже вышло. Без облика потолка нет, и окно его не выдумывает. */
const editParts = computed<number | null>(() =>
  editLook.value === null ? null : partsCeiling(editLook.value),
)

/** Идёт ли показ: онгоингу окно не ставит «Просмотрено» на потолке счёта. */
const editOngoing = computed<boolean>(() => (editLook.value?.airingEpisode ?? null) !== null)

/** Найденные записи последнего поиска; не реактивные сознательно: перерисовку заказывают доборы. */
let foundEntries: SnapshotEntry[] = []

/** Сколько находок последнего поиска спрятал тумблер. Тоже не реактивное. */
let foundHidden = 0

/** Номер идущего поиска: старый видит, что его ответ больше не нужен. */
let searchRun = 0

/** Таймер паузы набора. */
let timer: ReturnType<typeof setTimeout> | null = null

/** Смотритель за меткой конца списка. */
let watcher: IntersectionObserver | null = null

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Снимает кусок коллекции в плитки: при поиске берутся находки; потолок отрезается после сортировки. */
function redraw(): void {
  // Взрослое прячется и здесь: тумблер один на всё приложение. Числа считаются по видимому, а
  // спрятанное сказано словами ниже — так счёт и список сходятся.
  const raw = searching.value ? foundEntries : selectEntries({ status: [activeStatus.value] })
  const list = keepAllowed(raw, (entry) => entry.isAdult)

  counts.value = countByStatus({ hideAdult: true })
  total.value = countEntries({ hideAdult: true })
  // Поиск считает спрятанное сам: он отсеивает находки ещё до выдачи.
  hidden.value = searching.value ? foundHidden : raw.length - list.length

  picked.value = list.length
  rows.value = sortEntries(list, sortKey.value).slice(0, limit.value).map(toRow)
}

// Доборы обложек, названий и меток доступности живут рядом со сборкой строки:
// экран отдаёт свои строки и перерисовку. Флажки нужны подвалу и кнопок не держат.
const { looksBusy, titlesBusy, playBusy, fillLooks, fillTitles, loadMarks, onRowSeen } =
  useRowWarm(rows, redraw)

/** Отрисовка и три добора вслед. Сами доборы зовут только redraw — круга нет. */
function refill(): void {
  redraw()
  void fillLooks()
  void fillTitles()
  void loadMarks()
}

/** Возврат к первой сотне: любая смена отбора начинает показ сначала. */
function resetLimit(): void {
  limit.value = PAGE_LIMIT
}

/** Добор следующей сотни. За концом списка ничего не делает. */
function showMore(): void {
  if (!hasMore.value) return

  limit.value += PAGE_LIMIT
  refill()
}

/** Отбор по слову по всем закладкам; сети не требует, на кириллице сначала поднимает склад названий. */
async function runSearch(): Promise<void> {
  const mine = ++searchRun
  const asked = word.value.trim()

  resetLimit()

  if (asked === '') {
    foundEntries = []
    foundHidden = 0
    refill()
    return
  }

  searchBusy.value = true

  try {
    const found = await searchOwnList(asked, FOUND_LIMIT)
    if (mine !== searchRun) return

    foundEntries = found.entries
    foundHidden = found.hidden
    refill()
  } catch (e) {
    Logger('WARN', 'Списки: поиск по своему списку не удался', e)
  } finally {
    if (mine === searchRun) searchBusy.value = false
  }
}

/** Набор слова: поиск ждёт короткую паузу, чтобы не бегать на каждую букву. */
function onType(): void {
  if (timer !== null) clearTimeout(timer)

  timer = setTimeout(() => {
    timer = null
    void runSearch()
  }, TYPING_PAUSE_MS)
}

/** Очистка слова: возврат к закладкам без ожидания. */
function onClear(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }

  word.value = ''
  foundEntries = []
  searchRun++
  resetLimit()
  refill()
}

/** Переключение закладки статуса. */
function pickStatus(status: string): void {
  if (activeStatus.value === status) return

  activeStatus.value = status
  resetLimit()
  refill()
}

/** Смена порядка со своего ролл-аута; сверяем с известными: чужое значение в память попасть не должно. */
function pickSort(key: string): void {
  const found = SORT_TABS.find((item) => item.key === key)
  if (!found || found.key === sortKey.value) return

  sortKey.value = found.key
  resetLimit()
  refill()
}

/** Смена вида показа. Потолок не сбрасывается: записи те же, меняется только их одежда.
 *  Метки не заказываются: показ плитки и есть вопрос, его задаст директива. */
function pickView(key: ViewName): void {
  if (view.value === key) return

  view.value = key
}

/** Переход на карточку. Номер идёт строкой: в адресе окна чисел нет. */
function open(mediaId: number): void {
  navigate('media', { id: String(mediaId) })
}

/** Открытие окна правки прямо из списка. */
function openEdit(row: Row): void {
  editName.value = row.title
  editId.value = row.mediaId
}

function closeEdit(): void {
  editId.value = 0
}

/** Кладёт одну правку в память и пересобирает показ синхронно и без сети.
 *  Полная пересборка: правка закладки выкидывает запись из отбора, оценка меняет порядок. */
function sendEdit(kind: EntryEdit, value: string | number): void {
  if (editId.value === 0) return

  try {
    editEntry(editId.value, kind, value)
    editStamp.value += 1
    redraw()
  } catch (e) {
    trouble.value = describe(e)
  }
}

function onEditStatus(value: string): void {
  sendEdit('status', value)
}

function onEditScore(value: number): void {
  sendEdit('score', value)
}

function onEditProgress(value: number): void {
  sendEdit('progress', value)
}

function onEditRepeat(value: number): void {
  sendEdit('repeat', value)
}

function onEditStarted(value: string): void {
  sendEdit('startedAt', value)
}

function onEditCompleted(value: string): void {
  sendEdit('completedAt', value)
}

function onEditNotes(value: string): void {
  sendEdit('notes', value)
}

onMounted(() => {
  // Смотритель за концом списка: добор заказывается заранее, до самого края.
  // На старых окружениях смотрителя может не быть: останется кнопка.
  if (tailMark.value !== null && typeof IntersectionObserver !== 'undefined') {
    watcher = new IntersectionObserver(
      (marks) => {
        if (marks.some((mark) => mark.isIntersecting)) showMore()
      },
      { rootMargin: TAIL_MARGIN },
    )

    watcher.observe(tailMark.value)
  }

  void (async () => {
    try {
      // Только снимок с диска: в сеть за списком экран сам не ходит.
      // Перенос человек заводит сам в настройках, и там же выбирает способ.
      await initCollection()
      refill()
    } catch (e) {
      trouble.value = describe(e)
    } finally {
      busy.value = false
    }
  })()
})

onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer)
  timer = null
  searchRun++

  watcher?.disconnect()
  watcher = null
})
</script>

<template>
  <section class="am-page">
    <div class="am-lists__top">
      <label class="am-find">
        <span class="am-find__mark" aria-hidden="true">⌕</span>
        <input
          v-model="word"
          class="am-find__field"
          type="search"
          placeholder="Поиск по своему списку"
          @input="onType"
        />
        <span v-if="searching" v-tip="'Найдено в своём списке'" class="am-find__num">{{
          picked
        }}</span>
        <button
          v-if="searching"
          v-tip="'Сбросить поиск'"
          class="am-find__wipe"
          type="button"
          @click="onClear"
        >
          ×
        </button>
      </label>

      <!-- Порядок показа на своём ролл-ауте: системный список выпадал
           белым на тёмных темах: его рисует оболочка, а не наши стили. -->
      <PickBox
        class="am-sort"
        :model-value="sortKey"
        :items="SORT_TABS"
        mark="⇅"
        label="Порядок показа"
        @update:model-value="pickSort"
      />

      <div class="am-seg am-look" role="group" aria-label="Вид показа">
        <button
          v-for="tab in VIEW_TABS"
          :key="tab.key"
          v-tip="tab.title"
          class="am-seg__btn am-look__btn"
          :class="{ 'am-seg__btn--on': tab.key === view }"
          type="button"
          :aria-label="tab.title"
          :aria-pressed="tab.key === view"
          @click="pickView(tab.key)"
        >
          <span aria-hidden="true">{{ tab.icon }}</span>
        </button>
      </div>
    </div>

    <div v-if="!searching" class="am-lists__tabs">
      <button
        v-for="tab in statusTabs"
        :key="tab.key"
        class="am-chip"
        :class="{ 'am-chip--on': tab.key === activeStatus }"
        type="button"
        @click="pickStatus(tab.key)"
      >
        {{ tab.title }}
        <span class="am-chip__num">{{ counts.get(tab.key) ?? 0 }}</span>
      </button>
    </div>

    <p v-if="trouble" class="am-error">{{ trouble }}</p>

    <!-- Заглушки под тот вид, который человек выбрал: сетка плиток на месте
         строк дёргала бы высоту экрана в момент подъёма списка. -->
    <template v-if="busy && rows.length === 0">
      <ul v-if="view === 'tiles'" class="am-grid">
        <li v-for="n in HOLD_COUNT" :key="n" class="am-hold">
          <span class="am-skeleton am-hold__art" />
          <span class="am-skeleton am-hold__line" />
        </li>
      </ul>

      <ul v-else class="am-lines" :class="{ 'am-lines--art': view === 'wide' }">
        <li v-for="n in HOLD_LINES" :key="n" class="am-lines__hold">
          <span class="am-skeleton" />
        </li>
      </ul>
    </template>

    <!-- Пустой список и список, целиком скрытый меткой 18+, — разные вещи,
         и говорить о них одними словами нельзя: первое правда, второе ложь. -->
    <div v-else-if="total === 0 && hidden === 0" class="am-empty">
      <span class="am-empty__mark"><EmptyMark name="tray" /></span>
      <span>Записей пока нет.</span>
      <span>Добавьте аниме из поиска или перенесите список с AniList в настройках.</span>
    </div>

    <div v-else-if="total === 0" class="am-empty">
      <span class="am-empty__mark"><EmptyMark name="tray" /></span>
      <span>Все записи скрыты меткой 18+.</span>
      <span>Показ взрослого включается в настройках, в разделе оформления.</span>
    </div>

    <div v-else-if="searchBusy && rows.length === 0" class="am-empty">
      <span>Ищем…</span>
    </div>

    <div v-else-if="searching && rows.length === 0" class="am-empty">
      <span class="am-empty__mark"><EmptyMark name="magnifier" /></span>
      <template v-if="hidden > 0">
        <span>Нашлось только скрытое меткой 18+.</span>
        <span>Показ взрослого включается в настройках, в разделе оформления.</span>
      </template>
      <template v-else>
        <span>В своём списке ничего не нашлось.</span>
        <span>Попробуйте поискать в каталоге.</span>
      </template>
    </div>

    <!-- Пустая закладка — не пустой список: записи есть в соседних закладках, «записей нет» было бы
         ложью. Тот же случай — закладка, где всё скрыто меткой 18+. -->
    <div v-else-if="rows.length === 0" class="am-empty">
      <span class="am-empty__mark"><EmptyMark name="tray" /></span>
      <template v-if="hidden > 0">
        <span>Здесь всё скрыто меткой 18+.</span>
        <span>Показ взрослого включается в настройках, в разделе оформления.</span>
      </template>
      <template v-else>
        <span>В этой закладке записей нет.</span>
        <span>Загляните в соседние закладки — или добавьте аниме из поиска.</span>
      </template>
    </div>

    <!-- Отметка показа висит только на плитках: только они показывают метку
         доступности, а спрашивать источники ради невидимого знака незачем. -->
    <ul v-else-if="view === 'tiles'" class="am-grid">
      <MediaTile
        v-for="row in rows"
        :key="row.mediaId"
        v-seen="() => onRowSeen(row.mediaId)"
        :title="row.title"
        :facts="row.facts"
        :cover="row.cover"
        :color="row.color"
        :mark="row.mark"
        :repeat="row.repeat"
        :note="row.note"
        :ongoing="row.ongoing"
        :soon="row.soon"
        :play="row.play"
        :own="row.own"
        :done="row.done"
        :adult="row.adult"
        editable
        @open="open(row.mediaId)"
        @edit="openEdit(row)"
      />
    </ul>

    <ul v-else class="am-lines" :class="{ 'am-lines--art': view === 'wide' }">
      <MediaRow
        v-for="row in rows"
        :key="row.mediaId"
        :title="row.title"
        :facts="row.facts"
        :cover="row.cover"
        :color="row.color"
        :mark="row.mark"
        :repeat="row.repeat"
        :ongoing="row.ongoing"
        :soon="row.soon"
        :own="row.own"
        :done="row.done"
        :adult="row.adult"
        :art="view === 'wide'"
        editable
        @open="open(row.mediaId)"
        @edit="openEdit(row)"
      />
    </ul>

    <!-- Метка конца списка живёт всегда: смотритель берёт её один раз при сборке. -->
    <div ref="tailMark" class="am-tail">
      <button v-if="hasMore" class="am-btn am-btn--soft" type="button" @click="showMore">
        Показать ещё · осталось {{ restCount }}
      </button>
    </div>

    <p class="am-lists__foot">
      {{ rows.length }} из {{ shown }} · всего {{ total }}
      <template v-if="hidden > 0"> · скрыто 18+: {{ hidden }}</template>
      <template v-if="looksBusy"> · обложки…</template>
      <template v-if="titlesBusy"> · названия…</template>
      <template v-if="playBusy"> · доступность…</template>
    </p>

    <!-- То же окно, что на карточке; потолок счёта из склада обликов: без облика потолка нет — это
         штатно и честнее выдуманного итога. -->
    <EntrySheet
      v-if="editRow"
      :title="editName"
      :status="editStatus"
      :score10="editRow.score10"
      :progress="editRow.progress"
      :parts-total="editParts"
      :ongoing="editOngoing"
      :repeat="editRow.repeat"
      :started-at="editRow.startedAt"
      :completed-at="editRow.completedAt"
      :notes="editRow.notes"
      @close="closeEdit"
      @status="onEditStatus"
      @score="onEditScore"
      @progress="onEditProgress"
      @repeat="onEditRepeat"
      @started-at="onEditStarted"
      @completed-at="onEditCompleted"
      @notes="onEditNotes"
    />
  </section>
</template>

<style scoped>
/* Отбор одной стеклянной полосой: три капсулы без общего фона читались несвязанными панелями.
 * position и z-index не украшение. */
.am-lists__top {
  position: relative;
  z-index: 5;
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 10px;
  background: var(--am-glass);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-xl);
  box-shadow: inset 0 1px 0 var(--am-edge);
  backdrop-filter: blur(var(--am-blur)) saturate(1.4);
}

/* Поле поиска занимает всё свободное место ряда. */
.am-find {
  position: relative;
  display: flex;
  flex: 1 1 320px;
  gap: 10px;
  align-items: center;
  min-height: var(--am-ctl);
  padding: 0 12px;
  background: var(--am-fill-1);
  border: 1px solid transparent;
  border-radius: var(--am-r-cap);
  transition:
    border-color var(--am-fast) var(--am-ease),
    box-shadow var(--am-mid) var(--am-ease);
}

.am-find:focus-within {
  border-color: rgb(var(--am-accent-rgb) / 0.5);
  box-shadow: var(--am-sh-glow);
}

.am-find__mark {
  flex: 0 0 auto;
  font-size: 15px;
  color: var(--am-faint);
}

.am-find__field {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0;
  font: inherit;
  color: var(--am-text);
  background: none;
  border: 0;
  outline: none;
}

.am-find__field::-webkit-search-cancel-button {
  display: none;
}

/* Ответ поиска внутри поля: глаз уже смотрит сюда. */
.am-find__num {
  flex: 0 0 auto;
  font-size: 12px;
  color: var(--am-faint);
  font-variant-numeric: tabular-nums;
}

.am-find__wipe {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 22px;
  height: 22px;
  font-size: 15px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-fill-2);
  border: 0;
  border-radius: var(--am-r-cap);
  transition: color var(--am-fast) var(--am-ease);
}

.am-find__wipe:hover {
  color: var(--am-text);
}

/* Выбор порядка — свой ролл-аут: вся отделка живёт в самом компоненте,
   здесь только место в ряду и потолок ширины на узком окне. */
.am-sort {
  flex: 0 1 220px;
  max-width: 100%;
}

/* Вид показа — три значка в одной капсуле. Подписи ушли в подсказку:
   «Большие постеры» словами занимали половину полосы отбора. */
.am-look {
  flex: 0 0 auto;
}

/* Знак ставится сеткой в кнопку известной ширины: на padding он гулял
   по кнопке от глифа к глифу — у ▦ и ≡ разная ширина. */
.am-look__btn {
  display: grid;
  place-items: center;
  width: 36px;
  padding: 0;
  font-size: 14px;
  line-height: 1;
}

/* Закладки лентой: шесть чипов с числами на узком окне раскладывались
   в три этажа и уводили сетку за границу первого экрана. */
.am-lists__tabs {
  display: flex;
  gap: 8px;
  padding-bottom: 2px;
  overflow-x: auto;
  scrollbar-width: none;
  mask-image: linear-gradient(to right, transparent, #000 18px, #000 96%, transparent);
}

.am-lists__tabs::-webkit-scrollbar {
  height: 0;
}

.am-lists__tabs .am-chip {
  flex: 0 0 auto;
}

/* Список строками: свой столбец с малым шагом, сетка плиток здесь ни при чём. */
.am-lines {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.am-lines--art {
  gap: 8px;
}

/* Заглушка строки повторяет её высоту: иначе экран подпрыгивал в момент,
   когда заглушки сменялись живыми строками. */
.am-lines__hold .am-skeleton {
  display: block;
  height: 46px;
  border-radius: var(--am-r-cap);
}

.am-lines--art .am-lines__hold .am-skeleton {
  height: 74px;
  border-radius: var(--am-r-m);
}

/* Конец списка: место под кнопку добора и сама метка для смотрителя. */
.am-tail {
  display: flex;
  justify-content: center;
  min-height: 8px;
}

/* Счётчики внизу — служебная строка, а не часть показа. */
.am-lists__foot {
  margin: 0;
  font-size: 12px;
  color: var(--am-faint);
  text-align: center;
  font-variant-numeric: tabular-nums;
}

/* Заглушка — элемент сетки, а общий .am-hold в слое тем сам сетка. */
.am-hold {
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.am-hold__art {
  display: block;
  aspect-ratio: 2 / 3;
}

.am-hold__line {
  display: block;
  width: 72%;
  height: 12px;
  border-radius: var(--am-r-s);
}
</style>
