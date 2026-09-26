<script setup lang="ts">
// Пункт 3.10: экран студии — её работы сеткой постеров; плитка общая с поиском (tile-row.ts).
// Метки доступности спрашиваются по показу (v-seen); склад поднимается по всей сетке разом.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { fetchStudioWorks, STUDIO_PAGE_SIZE, type MediaBrief } from '@/api/anilist-media'
import { setupVideoSources } from '@/api/video-sources'
import { hiddenCount, keepAllowed } from '@/core/adult'
import { initCollection } from '@/core/collection'
import { rememberBrief } from '@/core/media-looks'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import {
  onPlayableChange,
  peekPlayable,
  primePlayable,
  requestPlayable,
  type PlayAsk,
} from '@/core/playable'
import { studioLogos } from '@/core/studio-logos'
import { Logger } from '@/utils/logger'

import EmptyMark from '../components/EmptyMark.vue'
import MediaTile from '../components/MediaTile.vue'
import { currentRoute, navigate } from '../router'
import { toPlayAsk, toTileRow, type TileRow } from '../tile-row'

/** Сколько плиток-заглушек показать, пока идёт первый ответ: два ряда
    широкого окна, чтобы ожидание не выглядело короче выдачи. */
const HOLD_COUNT = 18

/** По скольку тайтлов просить русские названия за заход. */
const TITLE_CHUNK = 20

/** Пауза перед заказом меток: прокрутка приводит ряд разом, без придержки каждый постер будил очередь. */
const SEEN_PAUSE_MS = 200

/** Сколько видимых постеров обязан дать один заход: три полных ряда. */
const WANT = STUDIO_PAGE_SIZE

/** Сколько страниц позволено за заход: иначе норма у студии с взрослыми работами не собирается,
 * а бесконечный цикл на медленном источнике хуже неполного ряда. */
const PAGE_TRIES = 4

const name = ref('')
const rows = ref<TileRow[]>([])
const busy = ref(false)
const trouble = ref('')
const hasNext = ref(false)

/** Скрытое отбором 18+ число говорится вслух, а не тихо теряется. */
const hidden = ref(0)

/** Литография студии или `null`. Промах штатен: шапка останется текстом. */
const logo = ref<string | null>(null)

/** Всё добытое и принятое в показ, до отбора 18+: по нему считаются скрытое и дедупликация. */
let raw: MediaBrief[] = []

/** Выписки, которые видно: по ним и рисуются плитки. */
let briefs: readonly MediaBrief[] = []

/** Добытое сверх нормы: хвост страницы ждёт следующего нажатия здесь, а не выбрасывается. */
let spare: MediaBrief[] = []

/** Последняя спрошенная страница источника. */
let lastPage = 0

/** Есть ли у источника страницы дальше. Остаток спрашивать не надо. */
let sourceMore = true

/** Номера идущих работ: ответ на устаревший вопрос в выдачу не попадает. */
let run = 0
let titleRun = 0
let playRun = 0

/** Плитки, попавшие в окно и ещё без метки: о них уйдёт ближайший заказ. */
const seenTiles = new Set<number>()

let seenTimer: ReturnType<typeof setTimeout> | null = null

/** Подъём меток со склада: заказ в сеть ждёт его — спрашивать службы о том, что едет с диска, худшее. */
let priming: Promise<void> = Promise.resolve()

const studioId = computed<number>(() => {
  const raw = Number(currentRoute.value.params.id ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : 0
})

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function redraw(): void {
  rows.value = briefs.map(toTileRow)
}

// Метки приходят из очереди по одной и вразброд: без подписки сетка ждала бы
// конца всего захода, а у плодовитой студии это минуты.
const stopPlayWatch = onPlayableChange(redraw)

/** Сколько работ из набора видно после отбора 18+. */
function shownCount(pool: readonly MediaBrief[]): number {
  return keepAllowed(pool, (brief) => brief.isAdult).length
}

/** Делит добытое на порцию показа и остаток. Считаются только видимые работы:
 * взрослые едут со своим куском страницы, чтобы счёт скрытого совпадал с показанным. */
function splitBatch(pool: readonly MediaBrief[]): { take: MediaBrief[]; rest: MediaBrief[] } {
  const take: MediaBrief[] = []
  const rest: MediaBrief[] = []
  let shown = 0

  for (const brief of pool) {
    const visible = keepAllowed([brief], (item) => item.isAdult).length === 1

    if (rest.length > 0 || (visible && shown >= WANT)) {
      rest.push(brief)
      continue
    }

    take.push(brief)
    if (visible) shown++
  }

  return { take, rest }
}

/** Ищет литографию студии по имени: список берётся у Шикимори раз за сеанс. Промах штатен. */
async function fillLogo(mine: number, studioName: string): Promise<void> {
  const map = await studioLogos()
  if (mine !== run || map === null) return

  logo.value = map.get(studioName.trim().toLowerCase()) ?? null
}

/** Добирает русские названия верхним строкам: в выдаче только аниме, проход один. */
async function fillTitles(targetIds: readonly number[]): Promise<void> {
  const mine = ++titleRun
  const ids = targetIds.filter((id) => peekRussianName(id) === null)
  if (ids.length === 0) return

  try {
    for (let from = 0; from < ids.length; from += TITLE_CHUNK) {
      if (mine !== titleRun) return

      // Сетке нужно только имя: описание и оценки спросит открытая карточка.
      await prefetchRussianNames(ids.slice(from, from + TITLE_CHUNK))
      if (mine !== titleRun) return

      redraw()
    }
  } catch (e) {
    // Без перевода выдача останется на латинице — не повод ругаться на экране.
    Logger('WARN', 'Студия: названия добрать не вышло', e)
  }
}

/** Снимает отложенный заказ: показанное относилось к другой студии. */
function dropSeen(): void {
  if (seenTimer !== null) clearTimeout(seenTimer)
  seenTimer = null
  seenTiles.clear()
}

/** Поднимает метки доступности со склада по всей сетке разом: сети не касается вовсе. */
async function loadMarks(): Promise<void> {
  const mine = ++playRun
  if (briefs.length === 0) return

  priming = (async () => {
    try {
      const primed = await primePlayable(briefs.map((brief) => brief.mediaId))
      if (mine !== playRun) return
      if (primed > 0) redraw()
    } catch (e) {
      // Без метки сетка живая: плитка про доступность просто молчит.
      Logger('WARN', 'Студия: метки доступности со склада не поднялись', e)
    }
  })()

  await priming
}

/** Заказывает метки у источников для показанных плиток: ответы приезжают подпиской, ждать нечего. */
async function askSeen(): Promise<void> {
  const mine = playRun

  // Склад мог ещё не договорить: иначе в сеть ушли бы вопросы о том,
  // что уже лежит на диске.
  await priming
  if (mine !== playRun) return

  const wanted: PlayAsk[] = []

  for (const brief of briefs) {
    if (!seenTiles.has(brief.mediaId)) continue
    if (peekPlayable(brief.mediaId) !== null) continue

    wanted.push(toPlayAsk(brief))
  }

  seenTiles.clear()

  if (wanted.length === 0) return

  // Реестр источников собирает экран: ядро своих поставщиков не зовёт.
  setupVideoSources()

  requestPlayable(wanted)
}

/** Плитка показалась человеку. Номера копятся пачкой: известная метка не стоит ни одного вопроса. */
function onTileSeen(mediaId: number): void {
  if (peekPlayable(mediaId) !== null) return

  seenTiles.add(mediaId)
  if (seenTimer !== null) return

  seenTimer = setTimeout(() => {
    seenTimer = null
    void askSeen()
  }, SEEN_PAUSE_MS)
}

/** Спрашивает работы студии: `add` добирает норму к показанному, без него — с первой страницы.
 * Заход равен норме показа, а не странице источника: страницы добираются подряд, лишнее — в остаток. */
async function load(add = false): Promise<void> {
  const mine = ++run
  const id = studioId.value

  if (!add) {
    raw = []
    briefs = []
    spare = []
    lastPage = 0
    sourceMore = true
    rows.value = []
    name.value = ''
    logo.value = null
    hidden.value = 0
    hasNext.value = false

    // Показанное относилось к прошлой сетке: спрашивать о нём больше некого.
    dropSeen()
  }

  if (id === 0) {
    busy.value = false
    return
  }

  busy.value = true
  trouble.value = ''

  // Заход начинается с прошлого остатка: он уже добыт и оплачен.
  const pool: MediaBrief[] = [...spare]
  spare = []

  let tries = 0
  let failed = false

  try {
    while (shownCount(pool) < WANT && sourceMore && tries < PAGE_TRIES) {
      // Известным считается и показанное, и добранное в этом заходе: иначе
      // дедупликация источника пропустит повтор внутри одного нажатия.
      const found = await fetchStudioWorks(id, lastPage + 1, [...raw, ...pool])
      if (mine !== run) return

      tries++

      if (found === null) {
        failed = true
        break
      }

      lastPage++
      name.value = found.name
      sourceMore = found.hasNext
      pool.push(...found.items)

      if (!add && tries === 1) void fillLogo(mine, found.name)
    }

    if (failed && pool.length === 0) {
      trouble.value = 'Каталог не ответил. Попробуйте ещё раз через минуту.'
      return
    }

    // Обложки уже в ответе: кладём их в общую память даром для списков и главной.
    for (const brief of pool) rememberBrief(brief)

    const { take, rest } = splitBatch(pool)
    spare = rest
    raw = [...raw, ...take]

    hidden.value = hiddenCount(raw, (brief) => brief.isAdult)
    briefs = keepAllowed(raw, (brief) => brief.isAdult)
    hasNext.value = sourceMore || spare.length > 0
    redraw()
    void loadMarks()
    await fillTitles([...new Set(take.map((item) => item.mediaId))])
  } catch (e) {
    if (mine !== run) return
    trouble.value = describe(e)
  } finally {
    if (mine === run) busy.value = false
  }
}

/** Добор следующей порции. */
function onMore(): void {
  void load(true)
}

/** Переход на карточку тайтла. */
function open(mediaId: number): void {
  navigate('media', { id: String(mediaId) })
}

onMounted(() => {
  void (async () => {
    // Свои метки на постерах требуют поднятого снимка: без него память пуста.
    try {
      await initCollection()
      redraw()
    } catch (e) {
      Logger('WARN', 'Студия: свой список поднять не вышло', e)
    }
  })()

  void load()
})

onBeforeUnmount(() => {
  run++
  titleRun++
  playRun++

  // Отложенный заказ пережил бы экран и будил очередь ради снятой сетки.
  dropSeen()

  // Очередь живёт дольше экрана: неснятая подписка держала бы снятый показ
  // и рисовала в никуда на каждый ответ источника.
  stopPlayWatch()
})

// Переход между двумя студиями не пересобирает экран: грузим сами.
watch(studioId, () => {
  void load()
})
</script>

<template>
  <section class="am-page">
    <div v-if="studioId === 0" class="am-empty">
      <span class="am-empty__mark"><EmptyMark name="question" /></span>
      <span>Студия не выбрана: в адресе нет номера.</span>
      <span>Откройте студию из карточки аниме.</span>
    </div>

    <template v-else>
      <header v-if="name" class="am-studio">
        <!-- Литография только когда она есть: буква в квадрате на её месте
             ничего не сообщала и только шумела рядом с названием. -->
        <img
          v-if="logo"
          class="am-studio__logo"
          :src="logo"
          :alt="name"
          loading="lazy"
          decoding="async"
          @error="logo = null"
        />

        <div class="am-studio__text">
          <h2 class="am-studio__name">{{ name }}</h2>
          <p v-if="hidden > 0" class="am-meta">Скрыто с меткой 18+: {{ hidden }}</p>
        </div>
      </header>

      <p v-else-if="hidden > 0" class="am-meta">Скрыто с меткой 18+: {{ hidden }}</p>

      <p v-if="trouble" class="am-error">{{ trouble }}</p>

      <ul v-if="busy && rows.length === 0" class="am-grid am-studio-grid">
        <li v-for="n in HOLD_COUNT" :key="n" class="am-hold">
          <span class="am-skeleton am-hold__art" />
          <span class="am-skeleton am-hold__line" />
        </li>
      </ul>

      <!-- Пустая студия — не ошибка и не пустой поиск: работы приходят из AniList,
           добавить их отсюда нельзя. Прежняя одна строка читалась как «не прогрузилось». -->
      <div v-else-if="rows.length === 0 && !busy && trouble === ''" class="am-empty">
        <span class="am-empty__mark"><EmptyMark name="studio" /></span>
        <span>У студии пока ничего не числится.</span>
        <span>Так и в AniList: добавить работы отсюда нельзя.</span>
      </div>

      <!-- Отметка показа на каждой плитке: только о попавших в окно
           спрашиваются источники видео. -->
      <ul v-else class="am-grid am-studio-grid">
        <MediaTile
          v-for="row in rows"
          :key="row.mediaId"
          v-seen="() => onTileSeen(row.mediaId)"
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
    </template>
  </section>
</template>

<style scoped>
/* Шапка студии: имя и литография, если она есть у источника. */
.am-studio {
  display: flex;
  gap: 16px;
  align-items: center;
  padding: 14px 18px;
  background: var(--am-glass);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-leaf);
  box-shadow: inset 0 1px 0 var(--am-edge);
  backdrop-filter: blur(var(--am-blur)) saturate(1.4);
}

/* Литография вписывается целиком: обрезка съедала бы слово. Подложка светлая во всех темах:
   знаки источника тёмные на прозрачном, и на тёмной теме исчезали бы целиком. */
.am-studio__logo {
  flex: 0 0 auto;
  box-sizing: border-box;
  width: 84px;
  height: 54px;
  padding: 6px 8px;
  object-fit: contain;
  background: color-mix(in srgb, #fff 90%, transparent);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-m);
}

.am-studio__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.am-studio__name {
  margin: 0;
  font-size: clamp(18px, 1.9vw, 25px);
  font-weight: 700;
  letter-spacing: -0.02em;
}

.am-studio-grid {
  grid-template-columns: repeat(auto-fit, minmax(var(--am-tile), 1fr));
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

.am-more {
  display: flex;
  justify-content: center;
  padding: 6px 0 10px;
}
</style>
