<script setup lang="ts">
// Пункт 3.5: поиск по чужому каталогу (поиск по своему списку — во вкладке списков, по памяти).
// Запрос — после паузы и порога длины, повтор слова не спрашивается; метки доступности — по показу.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import type { MediaBrief } from '@/api/anilist-media'
import { setupVideoSources } from '@/api/video-sources'
import { initCollection } from '@/core/collection'
import { rememberBrief } from '@/core/media-looks'
import { isSearchable, MIN_WORD_LEN, searchCatalog, tidyWord } from '@/core/media-search'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import { onPlayableChange, peekPlayable, primePlayable, requestPlayable } from '@/core/playable'
import { Logger } from '@/utils/logger'

import EmptyMark from '../components/EmptyMark.vue'
import MediaTile from '../components/MediaTile.vue'
import { navigate } from '../router'
import { toPlayAsk, toTileRow, type TileRow } from '../tile-row'

/** Пауза после последнего нажатия: почти полсекунды ловит слово целиком, а ожиданием не ощущается. */
const TYPING_PAUSE_MS = 450

/** По скольку аниме просить русские названия за заход. */
const TITLE_CHUNK = 10

/** Скольким верхним строкам добирать названия сетью: ниже почти не смотрят, а каждая — поход к источнику. */
const TITLE_DEPTH = 20

/** Пауза перед заказом меток: прокрутка приводит плитки десятками, без придержки каждый ряд будил очередь. */
const SEEN_PAUSE_MS = 200

/** Сколько плиток-заглушек показать, пока идёт первый ответ. */
const HOLD_COUNT = 12

const word = ref('')
const rows = ref<TileRow[]>([])
const busy = ref(false)
const trouble = ref('')
const total = ref<number | null>(null)
const hasNext = ref(false)
const page = ref(1)

const asked = computed(() => tidyWord(word.value))

/** Набранного мало для похода в каталог: показываем подсказку вместо пустоты. */
const short = computed(() => asked.value !== '' && !isSearchable(asked.value))

/** Счётчик говорит о показанном: точное число приезжает с последней страницы,
 * до того — счёт по своей выдаче с честным плюсом («27 и ещё»), а не выдуманный потолок. */
const countText = computed<string>(() => {
  if (total.value !== null) return String(total.value)
  return hasNext.value ? `${rows.value.length}+` : String(rows.value.length)
})

/** Подсказка к счётчику: у точного числа и у «столько-то и ещё» они разные. */
const countTip = computed<string>(() =>
  total.value === null && hasNext.value
    ? 'Показано находок, в каталоге их больше'
    : 'Найдено в каталоге',
)

/** Номера идущих работ: ответ на устаревший вопрос в выдачу не попадает. */
let run = 0
let titleRun = 0
let playRun = 0
let timer: ReturnType<typeof setTimeout> | null = null

/** Слово, по которому выдача уже на экране: тот же вопрос второй раз не задаётся. */
let lastAsked = ''

/** Найденные выписки этого показа: по ним плитки перерисовываются с названиями. */
let briefs: MediaBrief[] = []

/** Тайтлы, чьи плитки человек уже видел: только о них спрашиваются источники. */
const seenIds = new Set<number>()
let seenTimer: ReturnType<typeof setTimeout> | null = null

/** Идущий подъём меток со склада: заказ в сеть ждёт его, вопросы о дисковом — худшие. */
let priming: Promise<void> = Promise.resolve()

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function redraw(): void {
  rows.value = briefs.map(toTileRow)
}

// Ответы про доступность приходят по одному и вразброд: без подписки метки
// появлялись одним рывком в конце захода, а при длинной очереди — через минуты.
const stopPlayWatch = onPlayableChange(redraw)

/** Добирает русские названия строкам, где их ещё нет: обычно имена уже пришли вместе с находками. */
async function fillTitles(): Promise<void> {
  const mine = ++titleRun
  const wanted = briefs
    .slice(0, TITLE_DEPTH)
    .filter((brief) => peekRussianName(brief.mediaId) === null)
    .map((brief) => brief.mediaId)

  if (wanted.length === 0) return

  try {
    for (let from = 0; from < wanted.length; from += TITLE_CHUNK) {
      if (mine !== titleRun) return

      // Выдаче нужно только имя: описание и оценки спросит открытая карточка.
      await prefetchRussianNames(wanted.slice(from, from + TITLE_CHUNK))
      if (mine !== titleRun) return

      redraw()
    }
  } catch (e) {
    // Без перевода выдача останется на латинице — это не повод ругаться на экране.
    Logger('WARN', 'Поиск: названия добрать не вышло', e)
  }
}

/** Поднимает метки доступности со склада. Сети не касается, поэтому спрашивается вся выдача разом. */
async function loadMarks(): Promise<void> {
  const mine = ++playRun
  if (briefs.length === 0) return

  try {
    const primed = await primePlayable(briefs.map((brief) => brief.mediaId))
    if (mine !== playRun) return
    if (primed > 0) redraw()
  } catch (e) {
    // Без метки выдача живая: плитка про доступность просто молчит.
    Logger('WARN', 'Поиск: метки со склада не поднялись', e)
  }
}

/** Заказывает метки показанным плиткам. Ответы приезжают подпиской, ждать здесь нечего. */
async function askSeen(): Promise<void> {
  await priming

  const wanted = briefs.filter(
    (brief) => seenIds.has(brief.mediaId) && peekPlayable(brief.mediaId) === null,
  )
  seenIds.clear()

  if (wanted.length === 0) return

  // Реестр источников собирает экран: ядро своих поставщиков не зовёт.
  setupVideoSources()

  requestPlayable(wanted.map((brief) => toPlayAsk(brief)))
}

/** Плитка показалась человеку. Номера копятся пачкой: очередь не должна просыпаться на каждый ряд. */
function onSeen(mediaId: number): void {
  if (peekPlayable(mediaId) !== null) return

  seenIds.add(mediaId)
  if (seenTimer !== null) return

  seenTimer = setTimeout(() => {
    seenTimer = null
    void askSeen()
  }, SEEN_PAUSE_MS)
}

/** Снимает показанное вместе с идущим ответом: слово стёрли или в нём меньше знаков, чем стоит нести. */
function drop(): void {
  run++
  lastAsked = ''
  briefs = []
  rows.value = []
  page.value = 1
  total.value = null
  hasNext.value = false
  trouble.value = ''
  busy.value = false

  // Отложенный заказ меток теперь про снятую выдачу: спрашивать о ней нечего.
  if (seenTimer !== null) clearTimeout(seenTimer)
  seenTimer = null
  seenIds.clear()
}

/** Спрашивает каталог: `add` — добор страницы к показанному, `force` (Enter) — как есть.
 * Старые ответы отброшены по номеру работы. */
async function search(add = false, force = false): Promise<void> {
  const wordNow = asked.value

  if (wordNow === '') {
    drop()
    return
  }

  if (!add && !force) {
    // Слово не изменилось: выдача по нему уже на экране. Сюда приходят возвраты
    // каретки, смена раскладки и правка, вернувшая слово к прежнему виду.
    if (wordNow === lastAsked) return

    // Одну-две буквы каталог понимает как «отдай что угодно»: такую страницу
    // не читают, а стоит она полного запроса. Ждём остальных знаков или Enter.
    if (!isSearchable(wordNow)) {
      drop()
      return
    }
  }

  const mine = ++run

  busy.value = true
  trouble.value = ''

  if (!add) {
    lastAsked = wordNow
    briefs = []
    rows.value = []
    page.value = 1
    hasNext.value = false
    total.value = null
    seenIds.clear()
  }

  const wanted = add ? page.value + 1 : 1

  try {
    const found = await searchCatalog(wordNow, wanted)
    if (mine !== run) return

    if (found === null) {
      // Отказ не считается заданным вопросом: иначе повтор того же слова после
      // «попробуйте ещё раз» упирался бы в защиту от повтора и не делал ничего.
      lastAsked = ''
      trouble.value = 'Каталог не ответил. Попробуйте ещё раз через минуту.'
      return
    }

    // Обложки уже в ответе: кладём их в общую память даром для списков и главной.
    for (const brief of found.items) rememberBrief(brief)

    briefs = add ? [...briefs, ...found.items] : found.items
    page.value = wanted
    hasNext.value = found.hasNext
    total.value = found.total
    redraw()
  } catch (e) {
    if (mine !== run) return

    lastAsked = ''
    trouble.value = describe(e)
  } finally {
    if (mine === run) busy.value = false
  }

  void fillTitles()

  // Сеть про доступность отсюда больше не спрашивается: подъём со склада
  // бесплатный, а вопросы службам закажут сами плитки, когда покажутся.
  priming = loadMarks()
}

/** Набор слова: запрос уходит после паузы, а не на каждую букву. */
function onType(): void {
  if (timer !== null) clearTimeout(timer)

  // Пустому полю ждать нечего: выдачу надо снять сразу, заодно снимается
  // и ответ по стёртому слову, который иначе доехал бы в пустой экран.
  if (asked.value === '') {
    timer = null
    drop()
    return
  }

  timer = setTimeout(() => {
    timer = null
    void search()
  }, TYPING_PAUSE_MS)
}

/** Enter: спросить набранное немедленно и как есть. Так ищут короткие имена и повторяют после отказа. */
function onEnter(): void {
  if (timer !== null) clearTimeout(timer)
  timer = null

  void search(false, true)
}

/** Добор следующей страницы. */
function onMore(): void {
  void search(true)
}

/** Переход на карточку найденного аниме. */
function open(mediaId: number): void {
  navigate('media', { id: String(mediaId) })
}

onMounted(() => {
  void (async () => {
    // Поиск бывает первым экраном запуска: без подъёма снимка память пуста,
    // и своих меток на постерах не будет даже при полном списке на диске.
    try {
      await initCollection()
      redraw()
    } catch (e) {
      Logger('WARN', 'Поиск: свой список поднять не вышло', e)
    }
  })()
})

onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer)
  timer = null

  if (seenTimer !== null) clearTimeout(seenTimer)
  seenTimer = null

  run++
  titleRun++
  playRun++

  // Очередь живёт дольше экрана: неснятая подписка держала бы снятый
  // показ и рисовала в никуда на каждый ответ источника.
  stopPlayWatch()
})
</script>

<template>
  <section class="am-page">
    <label class="am-hunt">
      <span class="am-hunt__mark" aria-hidden="true">⌕</span>
      <input
        v-model="word"
        class="am-hunt__field"
        type="search"
        placeholder="Название на любом языке"
        @input="onType"
        @keyup.enter="onEnter"
      />
      <span v-if="rows.length > 0" v-tip="countTip" class="am-hunt__num">
        {{ countText }}
      </span>
    </label>

    <p v-if="trouble" class="am-error">{{ trouble }}</p>

    <ul v-if="busy && rows.length === 0" class="am-grid">
      <li v-for="n in HOLD_COUNT" :key="n" class="am-hold">
        <span class="am-skeleton am-hold__art" />
        <span class="am-skeleton am-hold__line" />
      </li>
    </ul>

    <div v-else-if="asked === ''" class="am-empty">
      <span class="am-empty__mark"><EmptyMark name="magnifier" /></span>
      <span>Начните вводить название.</span>
      <span>Можно по-русски, по-английски или на латинице.</span>
    </div>

    <div v-else-if="short" class="am-empty">
      <span class="am-empty__mark"><EmptyMark name="keyboard" /></span>
      <span>Слишком короткое слово.</span>
      <span>Наберите {{ MIN_WORD_LEN }} знака — или нажмите Enter, чтобы искать как есть.</span>
    </div>

    <div v-else-if="rows.length === 0 && !busy" class="am-empty">
      <span class="am-empty__mark"><EmptyMark name="magnifier" /></span>
      <span>Ничего не нашлось.</span>
      <span>Попробуйте другое слово.</span>
    </div>

    <!-- v-seen сообщает о первом показе плитки: только о показанных спрашиваются источники.
         Директива в app/see-tile.ts, зарегистрирована глобально в main.ts. -->
    <ul v-else class="am-grid">
      <MediaTile
        v-for="row in rows"
        :key="row.mediaId"
        v-seen="() => onSeen(row.mediaId)"
        :title="row.title"
        :facts="row.facts"
        :cover="row.cover"
        :color="row.color"
        :score="row.score"
        :mark="row.mark"
        :own="row.own"
        :repeat="row.repeat"
        :note="row.note"
        :done="row.done"
        :soon="row.soon"
        :play="row.play"
        :adult="row.adult"
        @open="open(row.mediaId)"
      />
    </ul>

    <div v-if="hasNext" class="am-more">
      <button class="am-btn am-btn--soft" type="button" :disabled="busy" @click="onMore">
        {{ busy ? 'Грузим…' : 'Показать ещё' }}
      </button>
    </div>
  </section>
</template>

<style scoped>
/* Поле поиска — главный предмет экрана, а не одна из контролок в ряду.
   Обёртка — label: клик по капсуле целиком ставит курсор в поле. */
.am-hunt {
  display: flex;
  gap: 12px;
  align-items: center;
  min-height: clamp(48px, 5vw, 60px);
  padding: 0 clamp(16px, 1.6vw, 24px);
  cursor: text;
  background: var(--am-glass);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  box-shadow: inset 0 1px 0 var(--am-edge);
  backdrop-filter: blur(var(--am-blur)) saturate(1.4);
  transition:
    border-color var(--am-mid) var(--am-ease),
    box-shadow var(--am-mid) var(--am-ease);
}

/* Свечение вместо обводки поверх капсулы: два кольца одно в другом
   выглядели браком рисования. */
.am-hunt:focus-within {
  border-color: rgb(var(--am-accent-rgb) / 0.6);
  box-shadow:
    inset 0 1px 0 var(--am-edge),
    var(--am-sh-glow);
}

.am-hunt__mark {
  font-size: 18px;
  color: var(--am-faint);
  transition: color var(--am-mid) var(--am-ease);
}

.am-hunt:focus-within .am-hunt__mark {
  color: var(--am-accent);
}

/* Своё поле без рамки и фона: рамка живёт на капсуле выше. */
.am-hunt__field {
  flex: 1 1 auto;
  min-width: 0;
  font: inherit;
  font-size: clamp(14px, 1.1vw, 16px);
  color: var(--am-text);
  background: none;
  border: 0;
}

.am-hunt__field::placeholder {
  color: var(--am-faint);
}

.am-hunt__field:focus {
  outline: none;
}

/* Крестик очистки у type=search рисуется темным квадратом на светлой теме:
   приводим его к цвету текста. */
.am-hunt__field::-webkit-search-cancel-button {
  cursor: pointer;
  filter: grayscale(1) opacity(0.6);
}

/* Счётчик внутри поля: отдельная строка ради одного числа сдвигала
   всю выдачу вниз. */
.am-hunt__num {
  flex: 0 0 auto;
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--am-dim);
  background: var(--am-fill-2);
  border-radius: var(--am-r-cap);
  font-variant-numeric: tabular-nums;
}

/* Заглушка — элемент сетки, а общий .am-hold в слое тем сам сетка:
   внутри .am-grid его надо вернуть в колонку. */
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

.am-more {
  display: flex;
  justify-content: center;
  padding: 6px 0 10px;
}
</style>
