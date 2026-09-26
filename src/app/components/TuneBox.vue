<script setup lang="ts">
// Музыка тайтла: опенинги и эндинги с AnimeThemes; плеер один, темы — строки списка.
// Полоса липнет к низу в поле 72px (.am-view): пульт и список уехали в окно за кнопкой.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

import { fetchMalThemes, type ThemeItem, type ThemeLink } from '@/api/animethemes'
import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

import BrandMark from './BrandMark.vue'
import SakuraBloom from './SakuraBloom.vue'

const props = defineProps<{ malId: number | null }>()

/** Шаг перемотки стрелками, секунды. */
const STEP_SEC = 5

/** Таймаут загрузки трека: файл весит мегабайты, десяти секунд ему мало. */
const SAVE_TIMEOUT_MS = 120000

/** Сколько держится отметка «готово» на кнопке, миллисекунды. */
const MARK_MS = 2200

/** Расширения, которые примет оболочка (тот же список в export.rs); незнакомое считаем ogg. */
const TRACK_EXTS = ['.ogg', '.oga', '.opus', '.mp3', '.m4a', '.webm']

/** Поиск на стримингах: к адресу дописывается подпись темы. */
const SEARCH_SPOTIFY = 'https://open.spotify.com/search/'
const SEARCH_YTMUSIC = 'https://music.youtube.com/search?q='
const SEARCH_YANDEX = 'https://music.yandex.ru/search?text='

/** Строка блока: тема с подписью, звуком и ссылками. */
interface TuneRow {
  key: string
  tag: string
  title: string
  artist: string
  audio: string | null
  links: ThemeLink[]
}

/** Кнопка стриминга в строке темы. */
interface TuneStream {
  brand: 'spotify' | 'youtube-music' | 'yandex-music'
  label: string
  url: string
  /** Адрес из ответа службы, а не поиск по подписи. */
  exact: boolean
  hint: string
}

/**
 * Громкость вне компонента: карточка пересобирается на каждом переходе, иначе уровень сбросится.
 */
let keepVol = 0.8

const rows = ref<TuneRow[]>([])

/** Окно списка: через него звучащая строка доводится в видимую часть. */
const listBox = ref<HTMLElement | null>(null)

/** Ключ заряженной темы; null — плеер пуст. */
const pick = ref<string | null>(null)
const playing = ref(false)
const at = ref(0)
const len = ref(0)
const loop = ref(false)
const vol = ref(keepVol)
const mute = ref(false)

/**
 * Перемешивание: автоматически следующая тема берётся случайно, а не по
 * порядку. На кнопки шага оно не влияет — почему, сказано в stepBy.
 */
const shuffle = ref(false)

/** Тянут ручку таймлайна: показания времени в это время наши, не плеера. */
const drag = ref(false)

/**
 * Открыто ли окно тем. Пульт и список живут там, а не в полосе: полосе
 * досталась одна строка, и всё остальное уехало в окно за кнопкой.
 */
const sheet = ref(false)

/** Ключи строк в работе и с отметками: отметка горит у своей кнопки, не у всех. */
const saving = ref<string | null>(null)
const saved = ref<string | null>(null)
const copied = ref<string | null>(null)

let sound: HTMLAudioElement | null = null

/** Номер захода: ответ про прошлое аниме в блок не попадёт. */
let run = 0

const nowRow = computed<TuneRow | null>(
  () => rows.value.find((row) => row.key === pick.value) ?? null,
)

/** Первая тема со звуком: с неё начинает пустой плеер. */
const firstSound = computed<TuneRow | null>(() => rows.value.find((row) => row.audio !== null) ?? null)

/** Проигрываемые темы: у остальных звука нет, и шагать по ним некуда. */
const sounds = computed<TuneRow[]>(() => rows.value.filter((row) => row.audio !== null))

/** Шаг возможен, когда тем хотя бы две: одна и так звучит. */
const canStep = computed<boolean>(() => sounds.value.length > 1)

const donePart = computed<string>(() =>
  len.value > 0 ? `${Math.min(100, (at.value / len.value) * 100)}%` : '0%',
)

const volPart = computed<string>(() => `${Math.round((mute.value ? 0 : vol.value) * 100)}%`)

const atText = computed<string>(() => timeText(at.value))
const lenText = computed<string>(() => (len.value > 0 ? timeText(len.value) : '--:--'))

const playHint = computed<string>(() => {
  if (nowRow.value === null && firstSound.value === null) return 'Записи нет'
  return playing.value ? 'Пауза' : 'Слушать'
})

/** Время вида «1:07». Часов у тем не бывает, так что без третьего разряда. */
function timeText(sec: number): string {
  const whole = Math.max(0, Math.floor(sec))
  const min = Math.floor(whole / 60)
  const rest = whole % 60
  return `${min}:${rest < 10 ? '0' : ''}${rest}`
}

/** Общий на все органы: доля от левого края до курсора. */
function ratioAt(event: PointerEvent, box: HTMLElement): number {
  const rect = box.getBoundingClientRect()
  if (rect.width <= 0) return 0
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
}

/** Звуковой элемент заводится один раз: переключаем ему src, а не плодим новые. */
function gear(): HTMLAudioElement {
  if (sound !== null) return sound

  const next = new Audio()
  next.preload = 'none'
  next.volume = mute.value ? 0 : vol.value

  next.addEventListener('loadedmetadata', () => {
    len.value = Number.isFinite(next.duration) ? next.duration : 0
  })
  // Пока тянут ручку, время считает рука, а не плеер: иначе ручка дёргалась бы назад.
  next.addEventListener('timeupdate', () => {
    if (!drag.value) at.value = next.currentTime
  })
  next.addEventListener('play', () => {
    playing.value = true
  })
  next.addEventListener('pause', () => {
    playing.value = false
  })
  // Повтор снят — уезжаем на следующую тему со звуком: слушают их обычно подряд.
  next.addEventListener('ended', () => {
    playing.value = false
    at.value = 0
    const after = nextRow()
    if (after !== null) charge(after)
  })
  next.addEventListener('error', () => {
    Logger('WARN', `Музыка: звук темы не пошёл (${pick.value ?? '—'})`)
    playing.value = false
  })

  sound = next
  return next
}

/** Следующая тема со звуком: ближайшая ниже заряженной, а с перемешиванием — случайная. */
function nextRow(): TuneRow | null {
  const now = rows.value.findIndex((row) => row.key === pick.value)
  if (now < 0) return null

  if (shuffle.value) {
    const pool = rows.value.filter((row) => row.audio !== null && row.key !== pick.value)
    if (pool.length === 0) return null
    return pool[Math.floor(Math.random() * pool.length)] ?? null
  }

  return rows.value.slice(now + 1).find((row) => row.audio !== null) ?? null
}

/**
 * Шаг по списку: +1 — следующая тема, −1 — предыдущая; ход по кругу намеренный.
 * Перемешивание на шаг не влияет: кнопка ведёт в одно место списка, иначе «назад» не туда.
 */
function stepBy(delta: 1 | -1): void {
  const list = sounds.value
  if (list.length < 2) return

  const now = list.findIndex((row) => row.key === pick.value)
  // Ничего не заряжено: «дальше» начинает с первой темы, «назад» — с последней,
  // так же как главная кнопка пустого плеера начинает с первой.
  const from = now < 0 ? (delta > 0 ? -1 : 0) : now
  const row = list[(from + delta + list.length) % list.length]
  if (row === undefined) return

  charge(row)
}

function onPrev(): void {
  stepBy(-1)
}

function onNext(): void {
  stepBy(1)
}

/** Заряжает тему в плеер и пускает её. */
function charge(row: TuneRow): void {
  if (row.audio === null) return

  const box = gear()
  pick.value = row.key
  at.value = 0
  len.value = 0
  box.loop = loop.value
  box.src = row.audio

  void box.play().catch((e) => {
    Logger('WARN', `Музыка: воспроизведение не началось (${row.tag})`, e)
    playing.value = false
  })
}

/** Доводит звучащую строку в окно списка ближним краем: тема сменяется и сама. */
function showPick(): void {
  const box = listBox.value
  const key = pick.value
  if (box === null || key === null) return

  const item = box.querySelector(`[data-key="${key}"]`)
  item?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

/**
 * Открывает окно тем; доводка ждёт появления списка в разметке — у закрытого окна его нет.
 */
function openSheet(): void {
  sheet.value = true
  void nextTick(showPick)
}

/** Нажатие по строке: своя тема — пауза и пуск, чужая — смена. */
function onRow(row: TuneRow): void {
  if (row.audio === null) return
  if (row.key === pick.value) {
    onPlay()
    return
  }
  charge(row)
}

/** Главная кнопка. Пустой плеер начинает с первой темы со звуком. */
function onPlay(): void {
  const row = nowRow.value
  if (row === null || sound === null) {
    const first = firstSound.value
    if (first !== null) charge(first)
    return
  }

  if (playing.value) {
    sound.pause()
    return
  }

  void sound.play().catch((e) => {
    Logger('WARN', `Музыка: воспроизведение не началось (${row.tag})`, e)
    playing.value = false
  })
}

function onLoop(): void {
  loop.value = !loop.value
  if (sound !== null) sound.loop = loop.value
}

/** Перемешивание меняет только выбор следующей темы: звук не трогаем. */
function onShuffle(): void {
  shuffle.value = !shuffle.value
}

/** Перемотка на месте: и стрелками, и прыжком по полосе. */
function seekTo(sec: number): void {
  if (sound === null || len.value <= 0) return
  const fixed = Math.min(len.value, Math.max(0, sec))
  at.value = fixed
  sound.currentTime = fixed
}

function onSeekDown(event: PointerEvent): void {
  const box = event.currentTarget as HTMLElement
  if (len.value <= 0) return

  box.setPointerCapture(event.pointerId)
  drag.value = true
  at.value = ratioAt(event, box) * len.value
}

function onSeekMove(event: PointerEvent): void {
  if (!drag.value) return
  at.value = ratioAt(event, event.currentTarget as HTMLElement) * len.value
}

function onSeekUp(): void {
  if (!drag.value) return
  drag.value = false
  seekTo(at.value)
}

function setVol(part: number): void {
  vol.value = part
  keepVol = part
  mute.value = part <= 0
  if (sound !== null) sound.volume = part
}

function onVolDown(event: PointerEvent): void {
  const box = event.currentTarget as HTMLElement
  box.setPointerCapture(event.pointerId)
  drag.value = false
  setVol(ratioAt(event, box))
}

function onVolMove(event: PointerEvent): void {
  if (event.buttons === 0) return
  setVol(ratioAt(event, event.currentTarget as HTMLElement))
}

/** Тишина без потери уровня: обратное нажатие возвращает прежнюю громкость. */
function onMute(): void {
  mute.value = !mute.value
  if (sound !== null) sound.volume = mute.value ? 0 : vol.value
}

/**
 * Клавиши внутри блока: пробел — пуск и пауза, стрелки — перемотка.
 * Пробел на кнопках отдаём кнопке: там он и так нажатие.
 */
function onKey(event: KeyboardEvent): void {
  const onButton = (event.target as HTMLElement | null)?.closest('button') !== null

  if (event.key === ' ' && !onButton) {
    event.preventDefault()
    onPlay()
    return
  }
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    seekTo(at.value + STEP_SEC)
    return
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    seekTo(at.value - STEP_SEC)
  }
}

/** Подпись темы одной строкой: её несут в поиск на стримингах. */
function rowLabel(row: TuneRow): string {
  return row.artist ? `${row.title} — ${row.artist}` : row.title
}

/**
 * Готовая ссылка темы на службу или null.
 * onlyMusic нужен Ютубу: под ключом youtube служба держит и обычные ролики, а не только Музыку.
 */
function readyLink(row: TuneRow, site: string, onlyMusic: boolean): string | null {
  const hit = row.links.find(
    (link) => link.site === site && (!onlyMusic || /music/i.test(link.label)),
  )
  return hit?.url ?? null
}

/** Собирает кнопку: готовый адрес или поиск службы. */
function stream(
  brand: TuneStream['brand'],
  label: string,
  ready: string | null,
  search: string,
): TuneStream {
  const exact = ready !== null
  return {
    brand,
    label,
    url: ready ?? search,
    exact,
    hint: `${exact ? 'Открыть в' : 'Искать в'} ${label}`,
  }
}

/** Три стриминга строки в постоянном порядке — почему так, см. шапку. */
function streamsFor(row: TuneRow): TuneStream[] {
  const query = encodeURIComponent(rowLabel(row))

  return [
    stream('spotify', 'Spotify', readyLink(row, 'spotify', false), `${SEARCH_SPOTIFY}${query}`),
    stream(
      'youtube-music',
      'YouTube Music',
      readyLink(row, 'youtube', true),
      `${SEARCH_YTMUSIC}${query}`,
    ),
    stream('yandex-music', 'Яндекс Музыке', null, `${SEARCH_YANDEX}${query}`),
  ]
}

/** Запрещённые в именах Windows символы — пробелом: иначе запись откажет. */
function safePart(text: string): string {
  return text
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Расширение из адреса без запроса и якоря; незнакомое — считаем ogg.
 * Обрезка идёт поиском разделителя, а не split: элемент при noUncheckedIndexedAccess пуст.
 */
function extOf(url: string): string {
  const cut = url.search(/[?#]/)
  const path = cut < 0 ? url : url.slice(0, cut)
  const dot = path.lastIndexOf('.')
  const ext = dot >= 0 ? path.slice(dot).toLowerCase() : ''
  return TRACK_EXTS.includes(ext) ? ext : '.ogg'
}

/** Имя файла вида «OP1 · Название — Исполнитель.ogg». */
function fileName(row: TuneRow): string {
  const head = safePart(`${row.tag} · ${rowLabel(row)}`)
  return `${head || row.tag}${extOf(row.audio ?? '')}`
}

/** Отметка гаснет сама и только если с тех пор не сменилась строка. */
function markFor(box: typeof saved, key: string): void {
  box.value = key
  setTimeout(() => {
    if (box.value === key) box.value = null
  }, MARK_MS)
}

/**
 * Название с автором в буфер: готовая строка для поиска на стриминге,
 * когда кнопки поиска мало и подпись несут куда-то ещё.
 */
function onCopy(row: TuneRow): void {
  void Bridge.clipboard
    .writeText(rowLabel(row))
    .then(() => {
      markFor(copied, row.key)
    })
    .catch((e) => {
      Logger('WARN', `Музыка: подпись не скопировалась (${row.tag})`, e)
    })
}

/**
 * Загрузка одной темы файлом: сперва папка, потом сеть — скачивать мегабайты впустую незачем.
 * Запрос через мост (байты нужны оболочке), мимо ограничителя AnimeThemes: он стережёт его 429.
 */
async function onSave(row: TuneRow): Promise<void> {
  if (row.audio === null || saving.value !== null) return

  const url = row.audio

  try {
    // Папка спрашивается на КАЖДОЕ нажатие. null — человек закрыл окно, это не сбой.
    const dir = await Bridge.exportFile.pickTrackDir()
    if (dir === null) return

    saving.value = row.key

    const res = await Bridge.http.requestBytes({ url, timeoutMs: SAVE_TIMEOUT_MS })
    if (!res.ok) {
      Logger('WARN', `Музыка: трек не отдался (${row.tag}, код ${res.status})`)
      return
    }

    const path = await Bridge.exportFile.writeTrack(dir, fileName(row), res.bytesBase64)
    Logger('INFO', `Музыка: трек сохранён (${path})`)
    markFor(saved, row.key)
  } catch (e) {
    Logger('WARN', `Музыка: трек не сохранён (${row.tag})`, e)
  } finally {
    if (saving.value === row.key) saving.value = null
  }
}

/** Стриминг — наружу через оболочку: в WebView2 обычный переход уносит окно. */
function openLink(url: string): void {
  void Bridge.shell.openExternal(url).catch((e) => {
    Logger('WARN', `Музыка: ссылка не открылась (${url})`, e)
  })
}

/** Глушит звук и забывает элемент: переход на другой тайтл обязан быть тишиной. */
function stop(): void {
  if (sound !== null) {
    sound.pause()
    sound.src = ''
    sound = null
  }
  pick.value = null
  playing.value = false
  at.value = 0
  len.value = 0
}

/** Забирает темы по MAL ID. Неудача тихая: блок просто не появится. */
async function load(): Promise<void> {
  const mine = ++run

  stop()
  rows.value = []
  saving.value = null
  saved.value = null
  copied.value = null

  const id = props.malId
  if (id === null) return

  try {
    const themes = await fetchMalThemes(id)
    if (mine !== run || themes === null) return

    // Ключ обязан быть уникален даже при совпавших номерах: слаг без цифры и версия вроде
    // OP1-EN4Kids дают тот же тег, а с одинаковыми ключами Vue путает строки при обновлении.
    const out: TuneRow[] = []
    const taken = new Map<string, number>()

    const add = (kind: 'OP' | 'ED', t: ThemeItem): void => {
      const tag = `${kind}${t.seq}`
      const seen = taken.get(tag) ?? 0
      taken.set(tag, seen + 1)

      out.push({
        key: seen === 0 ? tag : `${tag}.${seen + 1}`,
        tag,
        title: t.title,
        artist: t.artist,
        audio: t.audio,
        links: t.links,
      })
    }

    themes.openings.forEach((t) => add('OP', t))
    themes.endings.forEach((t) => add('ED', t))

    rows.value = out
  } catch (e) {
    Logger('WARN', 'Музыка: темы не загрузились', e)
  }
}

watch(
  () => props.malId,
  () => {
    void load()
  },
  { immediate: true },
)

watch(pick, showPick)

onBeforeUnmount(stop)
</script>

<template>
  <!-- Полоса вместо плитки: пуск, шаг, звучащая тема и время одной строкой,
       а пульт и список тем — в окне по кнопке справа. -->
  <div v-if="rows.length > 0" class="am-tune" @keydown="onKey">
    <div class="am-tune__top">
      <button
        v-tip="'Предыдущая тема'"
        class="am-tune__step"
        type="button"
        aria-label="Предыдущая тема"
        :disabled="!canStep"
        @click="onPrev"
      >
        <svg class="am-tune__glyph am-tune__glyph--fill" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M11.9 3.5 6.2 8l5.7 4.5z" />
          <rect x="4" y="3.9" width="1.3" height="8.2" rx="0.65" />
        </svg>
      </button>

      <button
        v-tip="playHint"
        class="am-tune__hit"
        :class="{ 'am-tune__hit--live': playing }"
        type="button"
        :aria-label="playHint"
        @click="onPlay"
      >
        <SakuraBloom />
        <span class="am-tune__mark" aria-hidden="true">
          <svg v-if="playing" class="am-tune__sign" viewBox="0 0 16 16">
            <rect x="4" y="3.2" width="2.9" height="9.6" rx="1.2" />
            <rect x="9.1" y="3.2" width="2.9" height="9.6" rx="1.2" />
          </svg>
          <svg v-else class="am-tune__sign" viewBox="0 0 16 16">
            <path d="M5.2 3.4 12.4 8l-7.2 4.6z" />
          </svg>
        </span>
      </button>

      <button
        v-tip="'Следующая тема'"
        class="am-tune__step"
        type="button"
        aria-label="Следующая тема"
        :disabled="!canStep"
        @click="onNext"
      >
        <svg class="am-tune__glyph am-tune__glyph--fill" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M4.1 3.5 9.8 8l-5.7 4.5z" />
          <rect x="10.7" y="3.9" width="1.3" height="8.2" rx="0.65" />
        </svg>
      </button>

      <span v-if="nowRow" class="am-tune__tag">{{ nowRow.tag }}</span>

      <!-- Подпись звучащего занимает всю середину полосы, а длинное название
           режется многоточием: целиком оно в подсказке. -->
      <span v-tip="nowRow ? rowLabel(nowRow) : 'Тема не выбрана'" class="am-tune__now">
        <span class="am-tune__nowname">{{ nowRow ? nowRow.title : 'Выберите тему' }}</span>
        <span v-if="nowRow && nowRow.artist" class="am-tune__nowartist">{{ nowRow.artist }}</span>
      </span>

      <span class="am-tune__clock">{{ atText }} / {{ lenText }}</span>

      <button
        v-tip="`Все темы: ${rows.length}`"
        class="am-tune__open"
        type="button"
        aria-label="Все темы"
        @click="openSheet"
      >
        <svg class="am-tune__glyph" viewBox="0 0 16 16" aria-hidden="true">
          <path d="M3.4 4.6h9.2" />
          <path d="M3.4 8h9.2" />
          <path d="M3.4 11.4h6" />
        </svg>
        <span class="am-tune__opennum">{{ rows.length }}</span>
      </button>
    </div>

    <!-- Таймлайн — нижняя кромка полосы: отдельного ряда у него нет, а тяга
         идёт по тому же обработчику, что и в пульте. -->
    <div
      class="am-tune__seek"
      :class="{ 'am-tune__seek--hold': drag }"
      role="slider"
      aria-label="Перемотка"
      :aria-valuetext="`${atText} из ${lenText}`"
      @pointerdown="onSeekDown"
      @pointermove="onSeekMove"
      @pointerup="onSeekUp"
      @pointercancel="onSeekUp"
    >
      <span class="am-tune__track">
        <span class="am-tune__done" :style="{ width: donePart }" />
      </span>
      <span class="am-tune__knob" :style="{ left: donePart }" />
    </div>
  </div>

  <!-- Окно тем: пульт целиком и полный список. Уезжает в body — окно поверх
       всего, и с полосой по разметке оно не соседствует. -->
  <Teleport to="body">
    <div v-if="sheet && rows.length > 0" class="am-sheet am-tune__sheet">
      <button class="am-sheet__veil" type="button" aria-label="Закрыть" @click="sheet = false" />

      <div
        class="am-sheet__box"
        role="dialog"
        aria-modal="true"
        aria-label="Музыка тайтла"
        @keydown="onKey"
      >
        <header class="am-sheet__top">
          <h3 class="am-h3">Музыка</h3>
          <span class="am-tune__count">{{ rows.length }}</span>
          <span class="am-bar__gap" />
          <button class="am-btn am-btn--ghost" type="button" @click="sheet = false">
            Закрыть
          </button>
        </header>

        <div class="am-sheet__body">
            <div class="am-tune__deck">
              <div class="am-tune__organs">
                <!-- Порядок звучания: перемешивание и повтор; иначе правая колонка выходит на
                     40 пикселей шире левой и первой вылезает за панель при узком окне. -->
                <div class="am-tune__tools am-tune__tools--left">
                  <button
                    v-tip="shuffle ? 'Перемешивание включено' : 'Перемешать темы'"
                    class="am-tune__tool"
                    :class="{ 'am-tune__tool--on': shuffle }"
                    type="button"
                    aria-label="Перемешать темы"
                    :aria-pressed="shuffle"
                    @click="onShuffle"
                  >
                    <svg class="am-tune__glyph" viewBox="0 0 16 16">
                      <path d="M2.6 4.4h2.2l6 7.2h2.4" />
                      <path d="M2.6 11.6h2.2l2.1-2.6" />
                      <path d="M9.5 6.3l1.3-1.9h2.4" />
                      <path d="M11.3 2.6l2 1.8-2 1.8" />
                      <path d="M11.3 9.8l2 1.8-2 1.8" />
                    </svg>
                  </button>

                  <button
                    v-tip="loop ? 'Повтор включён' : 'Повторять тему'"
                    class="am-tune__tool"
                    :class="{ 'am-tune__tool--on': loop }"
                    type="button"
                    aria-label="Повторять тему"
                    :aria-pressed="loop"
                    @click="onLoop"
                  >
                    <svg class="am-tune__glyph" viewBox="0 0 16 16">
                      <path d="M4.4 5.2h5.2a2.8 2.8 0 0 1 2.8 2.8v.4" />
                      <path d="M11.6 10.8H6.4a2.8 2.8 0 0 1-2.8-2.8V7.6" />
                      <path d="M6.2 3.2 4.1 5.2l2.1 2" />
                      <path d="M9.8 12.8l2.1-2-2.1-2" />
                    </svg>
                  </button>
                </div>

                <div class="am-tune__mid">
                  <!-- Шаг стоит рядом с пуском: это один орган — перевод звучащего. Пуск крупнее
                       не от важности, а потому что его рисует сакура, и у неё свой слой. -->
                  <button
                    v-tip="'Предыдущая тема'"
                    class="am-tune__tool"
                    type="button"
                    aria-label="Предыдущая тема"
                    :disabled="!canStep"
                    @click="onPrev"
                  >
                    <svg class="am-tune__glyph am-tune__glyph--fill" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M11.9 3.5 6.2 8l5.7 4.5z" />
                      <rect x="4" y="3.9" width="1.3" height="8.2" rx="0.65" />
                    </svg>
                  </button>

                  <button
                    v-tip="playHint"
                    class="am-tune__hit"
                    :class="{ 'am-tune__hit--live': playing }"
                    type="button"
                    :aria-label="playHint"
                    @click="onPlay"
                  >
                    <SakuraBloom />
                    <span class="am-tune__mark" aria-hidden="true">
                      <svg v-if="playing" class="am-tune__sign" viewBox="0 0 16 16">
                        <rect x="4" y="3.2" width="2.9" height="9.6" rx="1.2" />
                        <rect x="9.1" y="3.2" width="2.9" height="9.6" rx="1.2" />
                      </svg>
                      <svg v-else class="am-tune__sign" viewBox="0 0 16 16">
                        <path d="M5.2 3.4 12.4 8l-7.2 4.6z" />
                      </svg>
                    </span>
                  </button>

                  <button
                    v-tip="'Следующая тема'"
                    class="am-tune__tool"
                    type="button"
                    aria-label="Следующая тема"
                    :disabled="!canStep"
                    @click="onNext"
                  >
                    <svg class="am-tune__glyph am-tune__glyph--fill" viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M4.1 3.5 9.8 8l-5.7 4.5z" />
                      <rect x="10.7" y="3.9" width="1.3" height="8.2" rx="0.65" />
                    </svg>
                  </button>
                </div>

                <!-- Правая сторона: громкость. -->
                <div class="am-tune__tools am-tune__tools--right">
                  <button
                    v-tip="mute ? 'Включить звук' : 'Без звука'"
                    class="am-tune__tool"
                    type="button"
                    aria-label="Громкость"
                    @click="onMute"
                  >
                    <svg class="am-tune__glyph" viewBox="0 0 16 16">
                      <path d="M3 6.2h2.1L8.4 3.4v9.2L5.1 9.8H3z" />
                      <template v-if="!mute">
                        <path d="M10.6 6.1a2.6 2.6 0 0 1 0 3.8" />
                        <path d="M12.4 4.4a5 5 0 0 1 0 7.2" />
                      </template>
                      <template v-else>
                        <path d="M10.8 6.4l3.2 3.2" />
                        <path d="M14 6.4l-3.2 3.2" />
                      </template>
                    </svg>
                  </button>

                  <!-- Громкость тем же органом, что таймлайн, только короче: две разные
                       полосы в одном пульте читались бы деталями от разных приборов. -->
                  <div
                    class="am-tune__vol"
                    role="slider"
                    aria-label="Уровень громкости"
                    :aria-valuetext="volPart"
                    @pointerdown="onVolDown"
                    @pointermove="onVolMove"
                  >
                    <span class="am-tune__track">
                      <span class="am-tune__done" :style="{ width: volPart }" />
                    </span>
                    <span class="am-tune__knob" :style="{ left: volPart }" />
                  </div>
                </div>
              </div>

              <!-- Полоса своя: у родного ползунка ни формы темы, ни нужной толщины.
                   Захват указателя нужен, чтобы тяга не срывалась за краем полосы. -->
              <div class="am-tune__wave">
                <span class="am-tune__clock">{{ atText }}</span>
                <div
                  class="am-tune__seek"
                  :class="{ 'am-tune__seek--hold': drag }"
                  role="slider"
                  aria-label="Перемотка"
                  :aria-valuetext="`${atText} из ${lenText}`"
                  @pointerdown="onSeekDown"
                  @pointermove="onSeekMove"
                  @pointerup="onSeekUp"
                  @pointercancel="onSeekUp"
                >
                  <span class="am-tune__track">
                    <span class="am-tune__done" :style="{ width: donePart }" />
                  </span>
                  <span class="am-tune__knob" :style="{ left: donePart }" />
                </div>
                <span class="am-tune__clock">{{ lenText }}</span>
              </div>

              <div class="am-tune__now">
                <span v-if="nowRow" class="am-tune__nowtag">{{ nowRow.tag }}</span>
                <span class="am-tune__nowname">{{ nowRow ? nowRow.title : 'Выберите тему' }}</span>
                <span v-if="nowRow && nowRow.artist" class="am-tune__nowartist">{{ nowRow.artist }}</span>
              </div>
            </div>

            <!-- Окно в четыре строки: остальные темы достаются прокруткой, и рост блока от их числа
                 не зависит. -->
            <ul ref="listBox" class="am-tune__list">
              <!-- Пункт списка и есть строка: одежда, подсветка и рамка выбора на нём, а кнопка
                   выбора со спутниками — соседи внутри. -->
              <li
                v-for="row in rows"
                :key="row.key"
                :data-key="row.key"
                class="am-tune__item"
                :class="{ 'am-tune__item--on': row.key === pick }"
              >
                <button
                  v-tip="row.audio === null ? 'Записи нет' : `Слушать ${row.tag}`"
                  class="am-tune__row"
                  :class="{ 'am-tune__row--mute': row.audio === null }"
                  type="button"
                  :disabled="row.audio === null"
                  @click="onRow(row)"
                >
                  <!-- Три палочки у звучащей строки: место под знак занято всегда,
                       иначе пуск сдвигал бы названия соседних строк. -->
                  <span class="am-tune__beat" aria-hidden="true">
                    <span v-if="row.key === pick && playing" class="am-tune__beats">
                      <i /><i /><i />
                    </span>
                    <span v-else class="am-tune__dot" />
                  </span>

                  <span class="am-tune__tag">{{ row.tag }}</span>

                  <span class="am-tune__text">
                    <span class="am-tune__name">{{ row.title }}</span>
                    <span v-if="row.artist" class="am-tune__artist">{{ row.artist }}</span>
                  </span>
                </button>

                <!-- Три стриминга круглыми знаками, как ярлычки под постером. -->
                <span class="am-tune__tunes">
                  <button
                    v-for="place in streamsFor(row)"
                    :key="place.brand"
                    v-tip="place.hint"
                    class="am-tune__jump"
                    type="button"
                    :aria-label="place.hint"
                    @click="openLink(place.url)"
                  >
                    <BrandMark class="am-tune__brand" :name="place.brand" />
                  </button>
                </span>

                <span class="am-tune__acts">
                  <button
                    v-tip="copied === row.key ? 'Скопировано' : 'Скопировать название и автора'"
                    class="am-tune__act"
                    :class="{ 'am-tune__act--done': copied === row.key }"
                    type="button"
                    aria-label="Скопировать название и автора"
                    @click="onCopy(row)"
                  >
                    <svg v-if="copied === row.key" class="am-tune__glyph" viewBox="0 0 16 16">
                      <path d="M3.6 8.4 6.4 11.2 12.4 5" />
                    </svg>
                    <svg v-else class="am-tune__glyph" viewBox="0 0 16 16">
                      <rect x="5.6" y="2.6" width="7.8" height="9.4" rx="1.6" />
                      <path d="M10.4 13.4H4.2a1.6 1.6 0 0 1-1.6-1.6V5.2" />
                    </svg>
                  </button>

                  <!-- Без звуковой записи скачивать нечего: у темы есть только подпись. -->
                  <button
                    v-tip="
                      row.audio === null
                        ? 'Записи нет'
                        : saving === row.key
                          ? 'Скачивается…'
                          : saved === row.key
                            ? 'Сохранено'
                            : 'Скачать трек'
                    "
                    class="am-tune__act"
                    :class="{
                      'am-tune__act--done': saved === row.key,
                      'am-tune__act--wait': saving === row.key,
                    }"
                    type="button"
                    :disabled="row.audio === null || saving !== null"
                    aria-label="Скачать трек"
                    @click="onSave(row)"
                  >
                    <svg v-if="saving === row.key" class="am-tune__glyph" viewBox="0 0 16 16">
                      <path d="M8 2.2a5.8 5.8 0 1 1-5.8 5.8" />
                    </svg>
                    <svg v-else-if="saved === row.key" class="am-tune__glyph" viewBox="0 0 16 16">
                      <path d="M3.6 8.4 6.4 11.2 12.4 5" />
                    </svg>
                    <svg v-else class="am-tune__glyph" viewBox="0 0 16 16">
                      <path d="M8 2.8v6.8" />
                      <path d="M5.2 7.2 8 10l2.8-2.8" />
                      <path d="M3.2 12.4h9.6" />
                    </svg>
                  </button>
                </span>
              </li>
            </ul>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Токены роста списка. Объявлены и на полосе, и на окне: список живёт в окне, а окно уезжает в body
 * — общего предка у них нет, и унаследовать эти числа от полосы окну нечем. */
.am-tune,
.am-tune__sheet {
  /* На этих числах стоит рост окна списка: строка в 36px — это 32px кнопки строки и по 2px
     отступов пункта, просвет между строками 2px. Токенами, а не числом: высота разъехалась бы. */
  --am-tune-row: 36px;
  --am-tune-gap: 2px;
}

/* Полоса: одна строка над нижней кромкой окна, липнет к низу в поле .am-view и плиток не
   накрывает. Стекло, а не заливка: сквозь него угадывается, что страница кончилась. */
.am-tune {
  position: sticky;
  bottom: 0;
  z-index: 5;

  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 4px 12px 0;
  /* Стекло плотнее общего: полоса едет поверх содержимого, сквозь прежнее читались строки
     под ней. Насквозь всё же видно: под полосой должно угадываться, что страница кончилась. */
  background: var(--am-glass-deep);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-l);
  box-shadow: var(--am-sh-2);
  backdrop-filter: blur(var(--am-blur-strong)) saturate(1.25);
}

/* Верхний ряд полосы: шаг, пуск, тема, время, кнопка списка. Высота задана, а не набрана
   содержимым — по ней посчитан рост полосы. Имя с __top: __row занято кнопкой строки списка. */
.am-tune__top {
  display: flex;
  gap: 10px;
  align-items: center;
  height: 34px;
  min-width: 0;
}

/* Сорок шесть пикселей здесь задавали бы рост всей полосы, а цветку и на тридцати двух есть где
 * распуститься: нависание за край уменьшено вместе с кнопкой. */
.am-tune .am-tune__hit {
  --am-bloom-out: 2px;

  width: 32px;
  height: 32px;
}

/* Шаг по темам — круглыш того же роста, что кнопка списка: органы одной
   полосы должны быть одного размера, иначе ряд читается кривым. */
.am-tune__step,
.am-tune__open {
  display: grid;
  flex: none;
  place-items: center;
  height: 26px;
  padding: 0;
  color: var(--am-dim);
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease);
}

.am-tune__step {
  width: 26px;
}

.am-tune__step:hover,
.am-tune__step:focus-visible,
.am-tune__open:hover,
.am-tune__open:focus-visible {
  color: var(--am-text);
  background: var(--am-fill-2);
}

.am-tune__step:disabled {
  color: var(--am-faint);
  cursor: default;
}

.am-tune__step:disabled:hover {
  background: none;
}

/* Кнопка списка шире прочих: в ней кнопка и счётчик тем одним органом.
   Счётчик — часть кнопки, а не подпись рядом: нажатие одно. */
.am-tune__open {
  grid-auto-flow: column;
  gap: 5px;
  padding: 0 8px;
}

.am-tune__opennum {
  font-size: 11px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}

/* Подпись звучащего занимает всю середину полосы и прижата влево:
   центровка осталась пульту, где ей есть что центровать. */
.am-tune .am-tune__now {
  flex: 1;
  justify-content: flex-start;
}

/* Таймлайн нижней кромкой: своя высота, растягиваться ему некуда —
   в колонке полосы рост по главной оси был бы вертикальным. */
.am-tune .am-tune__seek {
  flex: none;
  height: 14px;
}

/* Знаки полосы мельче, чем в пульте: девятнадцать пикселей на кнопке
   в двадцать шесть — это знак во всю кнопку, без воздуха вокруг. */
.am-tune .am-tune__glyph {
  width: 15px;
  height: 15px;
}

/* Счётчик тем бледной пилюлей: цифра рядом с заголовком заменяет подпись
   «всего тем» и не занимает строки. */
.am-tune__count {
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 650;
  color: var(--am-faint);
  background: var(--am-fill-1);
  border-radius: var(--am-r-cap);
  font-variant-numeric: tabular-nums;
}

/* Окно тем: тот же приём, что у подбора и записи в список; классы общие (.am-sheet), правила
   свои — у каждого окна свой scoped-блок. Ширина 760: строка темы шире узкой коробки. */
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
  animation: am-tune-veil var(--am-mid) var(--am-ease) both;
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
  animation: am-tune-in var(--am-mid) var(--am-ease-soft) both;
}

@keyframes am-tune-veil {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes am-tune-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* Шапка держится на месте: список тем длинный, и уехавший заголовок
   с кнопкой закрытия заставлял бы искать их прокруткой. */
.am-sheet__top {
  display: flex;
  flex: 0 0 auto;
  gap: 10px;
  align-items: center;
  padding: 14px clamp(14px, 1.8vw, 22px);
  border-bottom: 1px solid var(--am-line-soft);
}

.am-sheet__top .am-h3 {
  margin: 0;
}

/* Середина окна ездит сама: пульт и список вместе выше коробки. */
.am-sheet__body {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding: 14px clamp(14px, 1.8vw, 22px) 16px;
  overflow-y: auto;
  overscroll-behavior-y: contain;
}

/* Пульт тремя рядами по центру: органы, таймлайн, подпись звучащего. */
.am-tune__deck {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 13px 11px;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-l);
}

/* Центр держит сетка, а не отступы: крайние колонки равные, просвет широкий нарочно — мелкие
   органы не липнут к цветку. container-type на ряде: у него нет отступов и рамки. */
.am-tune__organs {
  container-type: inline-size;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 18px;
  align-items: center;
}

/* Кнопка остаётся прямоугольной и без своей одежды: круг и распускающуюся сакуру рисует вложенный
 * слой, а кнопке остаются попадание курсора по всей цели и кольцо фокуса. */
.am-tune__hit {
  --am-bloom-deep: var(--am-hover);
  --am-bloom-petal: color-mix(in srgb, var(--am-sakura) 30%, var(--am-hover));
  --am-bloom-shade: var(--am-sh-1);
  --am-bloom-out: 3px;

  position: relative;
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  padding: 0;
  color: var(--am-dim);
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  transition: color var(--am-fast) var(--am-ease);
}

.am-tune__hit:hover,
.am-tune__hit:focus-visible {
  color: var(--am-text);
}

/* Знак поднят над цветком: тот лежит своим слоем и накрыл бы содержимое. */
.am-tune__mark {
  position: relative;
  display: block;
}

.am-tune__sign {
  display: block;
  width: 18px;
  height: 18px;
  fill: currentcolor;
}

/* Играет — цветок остаётся распущенным сам, без курсора, и живёт: лепестки медленно крутятся,
 * сердцевина дышит. Ровным ходом, а не по громкости: почему — в шапке файла. */
.am-tune__hit--live {
  color: var(--am-text);
}

.am-tune__hit--live :deep(.am-bloom__petals) {
  opacity: 1;
  animation: am-tune-turn 9s linear infinite;
}

.am-tune__hit--live :deep(.am-bloom__bud) {
  animation: am-tune-beat 2.4s var(--am-ease-soft) infinite;
}

.am-tune__hit--live :deep(.am-bloom) {
  filter: drop-shadow(var(--am-sh-1)) drop-shadow(0 0 10px rgb(var(--am-sakura-rgb) / 0.45));
}

@keyframes am-tune-turn {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes am-tune-beat {
  0%,
  100% {
    transform: scale(0.9);
  }
  50% {
    transform: scale(1);
  }
}

/* Подпись звучащего под полосой и по центру: заголовок пульта, а не
   строка слева. */
.am-tune__now {
  display: flex;
  gap: 7px;
  align-items: baseline;
  justify-content: center;
  min-width: 0;
}

.am-tune__nowtag {
  flex: none;
  padding: 2px 7px;
  font-size: 10.5px;
  font-weight: 700;
  color: var(--am-accent);
  background: rgb(var(--am-accent-rgb) / 0.14);
  border-radius: var(--am-r-cap);
}

.am-tune__nowname {
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.am-tune__nowartist {
  overflow: hidden;
  font-size: 12px;
  color: var(--am-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.am-tune__nowartist::before {
  margin-right: 5px;
  content: '·';
}

.am-tune__wave {
  display: flex;
  gap: 9px;
  align-items: center;
  min-width: 0;
}

.am-tune__clock {
  flex: none;
  font-size: 11px;
  color: var(--am-faint);
  font-variant-numeric: tabular-nums;
}

/* Цель тяги высокая, а сама полоса тонкая: ручку в четыре пикселя
   мышью не поймать, поэтому под ней прозрачный запас по высоте. */
.am-tune__seek,
.am-tune__vol {
  position: relative;
  display: flex;
  align-items: center;
  height: 22px;
  cursor: pointer;
  touch-action: none;
}

.am-tune__seek {
  flex: 1;
  min-width: 0;
}

/* Громкость: база 96px, но с разрешением сжаться — при flex: none ползунок выезжал за панель
   в узком окне. Короче таймлайна нарочно: на 60px деление шло 6 процентов, уровень наугад. */
.am-tune__vol {
  flex: 0 1 96px;
  min-width: 0;
}

/* Предохранитель: ниже 48px ползунок убирается — деление по два процента, попасть нечем;
   звук гасит кнопка рядом. Порог 340 по container-type ряда: (340 − 166) / 2 − 40 = 47px. */
@container (max-width: 340px) {
  .am-tune__vol {
    display: none;
  }
}

.am-tune__track {
  display: block;
  width: 100%;
  height: 6px;
  overflow: hidden;
  background: var(--am-fill-3);
  border-radius: var(--am-r-cap);
}

.am-tune__done {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--am-accent), var(--am-accent-2));
  border-radius: inherit;
}

/* Ручка — лепесток, а не серый шарик системы: тот же розовый, что у цветка. */
.am-tune__knob {
  position: absolute;
  top: 50%;
  width: 13px;
  height: 13px;
  background: var(--am-sakura);
  border-radius: var(--am-r-blob);
  box-shadow: 0 0 0 3px rgb(var(--am-sakura-rgb) / 0.2);
  transform: translate(-50%, -50%);
  transition:
    box-shadow var(--am-fast) var(--am-ease),
    transform var(--am-fast) var(--am-ease);
}

.am-tune__seek:hover .am-tune__knob,
.am-tune__vol:hover .am-tune__knob,
.am-tune__seek--hold .am-tune__knob {
  box-shadow: 0 0 0 5px rgb(var(--am-sakura-rgb) / 0.26);
  transform: translate(-50%, -50%) rotate(38deg) scale(1.1);
}

/* Середина пульта: шаг по списку и пуск одним рядом. Зазор уже, чем между колонками сетки: шаг и
 * пуск — один орган, и зазор в 18 пикселей разорвал бы его натрое. */
.am-tune__mid {
  display: flex;
  gap: 8px;
  align-items: center;
}

/* Боковые группы занимают колонку целиком, а к цветку прижимается содержимое: при
   justify-self ширина мерится по содержимому, и минимум колонки поднимался до 136px. */
.am-tune__tools {
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}

.am-tune__tools--left {
  justify-content: flex-end;
}

.am-tune__tools--right {
  justify-content: flex-start;
}

/* Органы пульта размером под палец, а не под прицел: рядом
   с цветком в 46px кнопки в 28 читались мелочью. */
.am-tune__tool {
  display: grid;
  flex: none;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  color: var(--am-faint);
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease);
}

.am-tune__tool:hover,
.am-tune__tool:focus-visible {
  color: var(--am-text);
  background: var(--am-fill-2);
}

/* Шаг выключен, когда тема со звуком одна: шагать некуда, и кнопка
   говорит об этом, а не молча повторяет ту же тему с начала. */
.am-tune__tool:disabled {
  color: var(--am-faint);
  cursor: default;
  opacity: 0.4;
}

.am-tune__tool:disabled:hover {
  background: none;
}

/* Включённый орган светится акцентом: без этого состояние кнопки
   приходилось бы проверять на слух. */
.am-tune__tool--on {
  color: var(--am-accent);
  background: var(--am-accent-soft);
}

.am-tune__glyph {
  width: 19px;
  height: 19px;
  fill: none;
  stroke: currentcolor;
  stroke-width: 1.4;
  stroke-linecap: round;
  stroke-linejoin: round;
}

/* Заливкой, а не обводкой: обведённый на девятнадцати пикселях треугольник читается пустой
   скобкой. Полоса записана прямоугольником — отрезком заливка оставила бы её нулевой. */
.am-tune__glyph--fill {
  fill: currentcolor;
  stroke: none;
}

/* Окно списка ростом ровно в шесть строк, просветы в счёте участвуют: иначе снизу полоска
   седьмой. Прокрутка не уходит на страницу; шесть, а не четыре: у One Piece их двенадцать. */
.am-tune__list {
  display: flex;
  flex-direction: column;
  gap: var(--am-tune-gap);
  max-height: calc(var(--am-tune-row) * 6 + var(--am-tune-gap) * 5);
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
  overscroll-behavior-y: contain;
}

/* Пункт списка и есть строка: отступы, подсветка и рамка выбора висят здесь. Рост задан, и
   сжиматься строке запрещено: иначе flex сдавил бы восемь строк вместо прокрутки. */
.am-tune__item {
  display: flex;
  flex: none;
  gap: 3px;
  align-items: center;
  min-width: 0;
  height: var(--am-tune-row);
  padding: 2px 8px;
  border-radius: var(--am-r-m);
  transition: background-color var(--am-fast) var(--am-ease);
}

.am-tune__item:hover {
  background: var(--am-fill-1);
}

.am-tune__item--on {
  background: rgb(var(--am-accent-rgb) / 0.1);
  box-shadow: inset 0 0 0 1px rgb(var(--am-accent-rgb) / 0.3);
}

/* Вся строка — цель нажатия: выбор темы мышью не должен требовать
   попадания в круглыш. Своей одежды у кнопки нет, она на пункте. */
.am-tune__row {
  display: flex;
  flex: 1;
  gap: 9px;
  align-items: center;
  min-width: 0;
  min-height: 32px;
  padding: 3px 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-m);
}

/* Темы без записи встречаются: строка остаётся в списке со ссылками
   и подписью, но не зовёт нажать. */
.am-tune__row--mute {
  cursor: default;
  opacity: 0.55;
}

/* Кнопки строки видны под курсором и при фокусе; прячется прозрачность, а не кнопка — место
   под значки занято всегда, иначе названия прыгали бы, а фокус не дошёл бы до скрытой. */
.am-tune__tunes,
.am-tune__acts {
  display: flex;
  flex: none;
  gap: 2px;
  align-items: center;
  opacity: 0;
  transition: opacity var(--am-fast) var(--am-ease);
}

.am-tune__item:hover .am-tune__tunes,
.am-tune__item:hover .am-tune__acts,
.am-tune__item:focus-within .am-tune__tunes,
.am-tune__item:focus-within .am-tune__acts {
  opacity: 1;
}

/* Стриминги строки: три круглых знака перед кнопками копирования и загрузки. Знак цветной и своего
 * цвета, поэтому кнопка под ним прозрачная, а подсветка наведения — бледное кольцо. */
.am-tune__jump {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  transition:
    background-color var(--am-fast) var(--am-ease),
    transform var(--am-fast) var(--am-ease);
}

.am-tune__jump:hover,
.am-tune__jump:focus-visible {
  background: var(--am-fill-2);
  transform: scale(1.08);
}

/* Знак того же размера, что ярлычки оценок под постером. */
.am-tune__brand {
  width: 18px;
  height: 18px;
}

.am-tune__act {
  display: grid;
  flex: none;
  place-items: center;
  width: 28px;
  height: 28px;
  padding: 0;
  color: var(--am-faint);
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease);
}

.am-tune__act:hover:not(:disabled),
.am-tune__act:focus-visible {
  color: var(--am-text);
  background: var(--am-fill-2);
}

.am-tune__act:disabled {
  cursor: default;
  opacity: 0.45;
}

/* Отметка о сделанном акцентом и на пару секунд: уведомление на полэкрана
   ради одной строки в буфере было бы перебором. */
.am-tune__act--done {
  color: var(--am-accent);
  background: var(--am-accent-soft);
}

/* Ожидание крутит дугу: трек весит мегабайты, и без знака жизни нажатие
   казалось бы провалившимся. */
.am-tune__act--wait {
  color: var(--am-accent);
}

.am-tune__act--wait .am-tune__glyph {
  animation: am-tune-turn 0.9s linear infinite;
}

/* Скачивание идёт и без курсора над строкой: отметка о работе не должна
   исчезать вместе с наведением. */
.am-tune__item .am-tune__act--wait,
.am-tune__item .am-tune__act--done {
  opacity: 1;
}

.am-tune__beat {
  display: grid;
  flex: none;
  place-items: center;
  width: 14px;
  height: 14px;
}

.am-tune__dot {
  width: 5px;
  height: 5px;
  background: var(--am-faint);
  border-radius: var(--am-r-cap);
}

.am-tune__item--on .am-tune__dot {
  background: var(--am-accent);
}

/* Три палочки эквалайзера у звучащей строки: нарисованы полосками,
   а не картинкой, и качаются со своим сдвигом каждая. */
.am-tune__beats {
  display: flex;
  gap: 2px;
  align-items: flex-end;
  height: 12px;
}

.am-tune__beats i {
  width: 2px;
  height: 100%;
  background: var(--am-accent);
  border-radius: var(--am-r-cap);
  animation: am-tune-wag 1.1s var(--am-ease-soft) infinite;
}

.am-tune__beats i:nth-child(2) {
  animation-delay: 0.22s;
}

.am-tune__beats i:nth-child(3) {
  animation-delay: 0.44s;
}

@keyframes am-tune-wag {
  0%,
  100% {
    transform: scaleY(0.4);
  }
  50% {
    transform: scaleY(1);
  }
}

/* Номер темы пилюлей акцентом: OP1 и ED2 ищут глазом первыми. */
.am-tune__tag {
  flex: none;
  min-width: 34px;
  padding: 3px 7px;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.2;
  color: var(--am-accent);
  text-align: center;
  background: rgb(var(--am-accent-rgb) / 0.14);
  border-radius: var(--am-r-cap);
}

.am-tune__text {
  display: flex;
  flex: 1;
  gap: 4px;
  align-items: baseline;
  min-width: 0;
}

.am-tune__name {
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Исполнитель через точку и бледнее: это подпись к названию, а не вторая
   строка — иначе блок из восьми тем вырастал вдвое. */
.am-tune__artist {
  overflow: hidden;
  font-size: 12px;
  color: var(--am-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.am-tune__artist::before {
  margin-right: 4px;
  content: '·';
}

/* Просьба о покое сильнее красот: цветок просто остаётся распущенным,
   палочки — поднятыми. */
@media (prefers-reduced-motion: reduce) {
  .am-tune__hit--live :deep(.am-bloom__petals),
  .am-tune__hit--live :deep(.am-bloom__bud),
  .am-tune__beats i,
  .am-tune__act--wait .am-tune__glyph {
    animation: none;
  }

  .am-tune__seek:hover .am-tune__knob,
  .am-tune__vol:hover .am-tune__knob,
  .am-tune__seek--hold .am-tune__knob {
    transform: translate(-50%, -50%);
  }

  .am-tune__jump:hover,
  .am-tune__jump:focus-visible {
    transform: none;
  }
}
</style>
