<script setup lang="ts">
// Кадры и трейлер тайтла: трейлер — от AniList, кадры — от Шикимори, и разницы между источниками
// показ не знает. Невстраиваемые ролики уходят наружу; в сетке уменьшенные кадры, в просмотре — полный.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { fetchMediaShots } from '@/api/media-shots'
import { Bridge } from '@/bridge'
import type { MediaClip, MediaShot, MediaTrailer } from '@/core/types'
import { Logger } from '@/utils/logger'

const props = defineProps<{
  mediaId: number
  malId: number | null
  /** Трейлер из карточки; null — сервер его не знает. */
  trailer: MediaTrailer | null
}>()

/** Клеток восемь в четыре колонки: только так ряд ложится ровно без дыры,
 *  а высота плитки сходится с франшизой (560 против 558) и со стеной галереи. */
const GRID_SHOTS = 8

const shots = ref<MediaShot[]>([])
const clips = ref<MediaClip[]>([])
const busy = ref(false)

/** Кадры не загрузились: источник ответил, а картинки не приехали. */
const broken = ref(false)

/** Номер кадра в просмотре; −1 — просмотр закрыт. */
const look = ref(-1)

/** Открыто ли окно трейлера. */
const reel = ref(false)

/** Открыта ли галерея всех кадров. */
const gal = ref(false)

/** Картинки, уже отработавшие (приехали или отвалились): файлы едут с чужого CDN,
 *  и без заглушки пустые клетки читались бы поломкой. Ключ — адрес картинки. */
const ready = ref<ReadonlySet<string>>(new Set())

/** Ждёт ли картинка своего часа: пока да, на её месте ходит заглушка. */
function pending(url: string | null): boolean {
  return url !== null && !ready.value.has(url)
}

/** Картинка отработала. Отвалившуюся тоже считаем: заглушка на ней
 *  ходила бы вечно и обещала загрузку, которой уже не будет. */
function markReady(url: string | null): void {
  if (url === null || ready.value.has(url)) return
  const next = new Set(ready.value)
  next.add(url)
  ready.value = next
}

/** Номер показа: ответ, пришедший после ухода с тайтла, к показу не относится. */
let run = 0

/** Трейлер к показу: свой из карточки, а без него — первый встраиваемый анонс (`pv`)
 *  из роликов Шикимори, а без анонсов — первый встраиваемый ролик любого вида. */
const reelTrailer = computed<MediaTrailer | null>(() => {
  if (props.trailer) return props.trailer

  const list = clips.value
  const clip =
    list.find((item) => item.kind === 'pv' && item.embed !== null) ??
    list.find((item) => item.embed !== null)
  if (!clip || clip.embed === null) return null

  return { title: clip.name, thumb: clip.thumb, embed: clip.embed, url: clip.url }
})

/** Кадры плитки: счётчик остальных занимает последнюю клетку. */
const rest = computed<number>(() => Math.max(0, shots.value.length - GRID_SHOTS))
const cells = computed<MediaShot[]>(() =>
  shots.value.slice(0, rest.value > 0 ? GRID_SHOTS - 1 : GRID_SHOTS),
)

/** Показывать ли плитку: без кадров и без трейлера показывать нечего. */
const empty = computed<boolean>(() => shots.value.length === 0 && reelTrailer.value === null)

/** Открытый кадр или null. */
const nowShot = computed<MediaShot | null>(() => shots.value[look.value] ?? null)

/** Подпись счётчика кадров: «12 из 55». */
const lookText = computed<string>(() =>
  shots.value.length === 0 ? '' : `${look.value + 1} из ${shots.value.length}`,
)

/** Открывает просмотр на кадре; номер зажимается по списку — шаг за край вернул бы пустоту. */
function openLook(at: number): void {
  if (shots.value.length === 0) return
  look.value = Math.min(Math.max(at, 0), shots.value.length - 1)
}

/** Шаг по кадрам с заворотом: с последнего — на первый. */
function stepLook(by: number): void {
  const count = shots.value.length
  if (count === 0) return
  look.value = (look.value + by + count) % count
}

/** Открывает трейлер: окном, если площадка встраивается, иначе наружу;
 *  `embed` без адреса сюда не приходит — проверено ещё при разборе ответа. */
function openReel(): void {
  const trailer = reelTrailer.value
  if (!trailer) return

  if (trailer.embed === null) {
    openOut(trailer.url)
    return
  }

  reel.value = true
}

/** Открывает галерею всех кадров отдельным окном. */
function openGal(): void {
  if (shots.value.length === 0) return
  gal.value = true
}

/** Внешняя ссылка: тот же путь, что у ссылок в описании. */
function openOut(url: string): void {
  void Bridge.shell.openExternal(url).catch((e) => {
    Logger('WARN', `Кадры: внешняя ссылка не открылась (${url})`, e)
  })
}

/** Закрывает верхнее из открытого: просмотр, потом трейлер и только затем галерею. */
function closeTop(): void {
  if (look.value >= 0) {
    look.value = -1
    return
  }
  if (reel.value) {
    reel.value = false
    return
  }
  gal.value = false
}

/** Клавиши: Escape закрывает, стрелки ходят по кадрам. Слушаем окно, а не корень
 *  плитки: просмотр и трейлер живут в общем слое, и фокус бывает уже там. */
function onKey(event: KeyboardEvent): void {
  if (gal.value || reel.value || look.value >= 0) {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeTop()
      return
    }
  }

  if (look.value < 0) return

  if (event.key === 'ArrowRight') {
    event.preventDefault()
    stepLook(1)
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    stepLook(-1)
  }
}

async function load(): Promise<void> {
  const mine = ++run

  shots.value = []
  clips.value = []
  ready.value = new Set()
  look.value = -1
  reel.value = false
  gal.value = false
  broken.value = false

  if (props.mediaId === 0) return

  busy.value = true

  try {
    const found = await fetchMediaShots(props.mediaId, props.malId)
    if (mine !== run || found === null) return

    shots.value = found.shots
    clips.value = found.clips
  } catch (e) {
    // Без кадров карточка полноценна: плитка просто не появится.
    Logger('WARN', `Кадры аниме ${props.mediaId}: добыть не вышло`, e)
  } finally {
    if (mine === run) busy.value = false
  }
}

onMounted(() => {
  void load()
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  // Показ прекращается вместе с уходом с тайтла: ответ, пришедший следом,
  // к показу уже не относится.
  run++
})

watch(() => [props.mediaId, props.malId], load)
</script>

<template>
  <!-- Плитка молчит, пока кадры едут: заглушки стоят ровно на месте сетки,
       и появление кадров не перекладывает доску. -->
  <div v-if="busy && empty" class="am-panel am-shots">
    <h3 class="am-h3">Кадры</h3>
    <div class="am-shots__grid">
      <span v-for="at in GRID_SHOTS" :key="at" class="am-skeleton am-shots__hold" />
    </div>
  </div>

  <!-- Ни кадров, ни трейлера — плитки нет вовсе: пустая коробка «Кадры»
       у половины старых тайтлов была бы честной, но бесполезной. -->
  <div v-else-if="!empty" class="am-panel am-shots">
    <!-- Кнопки трейлера в шапке нет: кадр ролика стоит тут же, и вторая
         дверь в него — лишняя. -->
    <div class="am-bar">
      <h3 class="am-h3">Кадры</h3>
      <span v-if="shots.length > 0" class="am-shots__count">{{ shots.length }}</span>
    </div>

    <!-- Трейлер и сетка одной обёрткой: раскладку решает один запрос по ширине плитки. -->
    <div class="am-shots__body">
      <!-- Трейлер кадром во всю ширину плитки: кадр 16:9, и в узкой клетке он был бы огрызком. -->
      <button
        v-if="reelTrailer"
        v-tip="`Смотреть: ${reelTrailer.title}`"
        class="am-shots__reel"
        :class="{ 'am-skeleton': pending(reelTrailer.thumb) }"
        type="button"
        @click="openReel"
      >
        <img
          v-if="reelTrailer.thumb"
          class="am-shots__reelart"
          :src="reelTrailer.thumb"
          alt=""
          loading="lazy"
          decoding="async"
          @load="markReady(reelTrailer.thumb)"
          @error="markReady(reelTrailer.thumb)"
        />
        <span class="am-shots__play" aria-hidden="true">
          <svg viewBox="0 0 16 16">
            <path d="M5.2 3.4 12.4 8l-7.2 4.6z" />
          </svg>
        </span>
      </button>

      <div v-if="shots.length > 0 && !broken" class="am-shots__grid">
        <button
          v-for="(shot, at) in cells"
          :key="shot.preview"
          class="am-shots__cell"
          :class="{ 'am-skeleton': pending(shot.preview) }"
          type="button"
          @click="openLook(at)"
        >
          <img
            class="am-shots__art"
            :src="shot.preview"
            alt=""
            loading="lazy"
            decoding="async"
            @load="markReady(shot.preview)"
            @error="broken = true"
          />
        </button>

        <button
          v-if="rest > 0"
          v-tip="'Открыть все кадры'"
          class="am-shots__cell am-shots__more"
          type="button"
          @click="openGal"
        >
          +{{ rest }}
        </button>
      </div>

      <p v-else-if="broken" class="am-meta">Кадры не загрузились: источник их отдал, картинки не приехали.</p>
    </div>
  </div>

  <!-- ГАЛЕРЕЯ. Все кадры сеткой в отдельном окне; кадры уменьшенные и грузятся лениво. -->
  <Teleport to="body">
    <div v-if="gal" class="am-sheet am-shots__gal">
      <button class="am-sheet__veil" type="button" aria-label="Закрыть" @click="gal = false" />

      <div
        class="am-sheet__box"
        role="dialog"
        aria-modal="true"
        aria-label="Кадры тайтла"
        tabindex="-1"
      >
        <header class="am-sheet__top">
          <h3 class="am-h3">Кадры</h3>
          <span class="am-shots__count">{{ shots.length }}</span>
          <span class="am-bar__gap" />
          <button class="am-btn am-btn--ghost" type="button" @click="gal = false">Закрыть</button>
        </header>

        <div class="am-sheet__body">
          <div class="am-shots__wall">
            <button
              v-for="(shot, at) in shots"
              :key="shot.preview"
              class="am-shots__cell"
              :class="{ 'am-skeleton': pending(shot.preview) }"
              type="button"
              @click="openLook(at)"
            >
              <img
                class="am-shots__art"
                :src="shot.preview"
                alt=""
                loading="lazy"
                decoding="async"
                @load="markReady(shot.preview)"
                @error="markReady(shot.preview)"
              />
            </button>
          </div>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- ПРОСМОТР КАДРА. Один кадр во весь экран, шаг по стрелкам и счёт.
       Полный кадр грузится только здесь — в сетке стоят уменьшенные. -->
  <Teleport to="body">
    <div v-if="look >= 0 && nowShot" class="am-look">
      <button class="am-look__veil" type="button" aria-label="Закрыть" @click="look = -1" />

      <div class="am-look__box" role="dialog" aria-modal="true" aria-label="Кадр">
        <img class="am-look__art" :src="nowShot.original" alt="" decoding="async" />

        <div class="am-look__row">
          <button
            v-tip="'Предыдущий кадр'"
            class="am-look__step"
            type="button"
            aria-label="Предыдущий кадр"
            @click="stepLook(-1)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M11.9 3.5 6.2 8l5.7 4.5z" />
              <rect x="4" y="3.9" width="1.3" height="8.2" rx="0.65" />
            </svg>
          </button>

          <span class="am-look__num">{{ lookText }}</span>

          <button
            v-tip="'Следующий кадр'"
            class="am-look__step"
            type="button"
            aria-label="Следующий кадр"
            @click="stepLook(1)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.1 3.5 9.8 8l-5.7 4.5z" />
              <rect x="10.7" y="3.9" width="1.3" height="8.2" rx="0.65" />
            </svg>
          </button>

          <button class="am-btn am-btn--ghost am-look__close" type="button" @click="look = -1">
            Закрыть
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- ОКНО ТРЕЙЛЕРА. Ролик играет здесь же, а ссылка наружу остаётся:
       ютюб вправе отказать во встраивании отдельному видео. -->
  <Teleport to="body">
    <div v-if="reel && reelTrailer" class="am-reel">
      <button class="am-reel__veil" type="button" aria-label="Закрыть" @click="reel = false" />

      <div class="am-reel__box" role="dialog" aria-modal="true" :aria-label="reelTrailer.title">
        <iframe
          v-if="reelTrailer.embed"
          class="am-reel__frame"
          :src="reelTrailer.embed"
          :title="reelTrailer.title"
          allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
          referrerpolicy="strict-origin-when-cross-origin"
          allowfullscreen
        />

        <div class="am-reel__row">
          <span class="am-reel__name">{{ reelTrailer.title }}</span>
          <span class="am-bar__gap" />
          <button
            v-tip="'Открыть ролик в браузере'"
            class="am-btn am-btn--ghost"
            type="button"
            @click="openOut(reelTrailer.url)"
          >
            В браузере
          </button>
          <button class="am-btn am-btn--ghost" type="button" @click="reel = false">Закрыть</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Плитка — контейнер запроса: её ширину задаёт доска, и медиазапрос по окну срабатывал бы вразнобой. */
.am-shots {
  container-type: inline-size;
}

/* Сетка кадров: четыре в ряд. Пропорция задана клетке, а не картинке: кадры
   приходят разной ширины, и по картинке ряды вышли бы разной высоты. */
.am-shots__grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin-top: 10px;
}

.am-shots__cell {
  position: relative;
  display: block;
  overflow: hidden;
  aspect-ratio: 16 / 9;
  padding: 0;
  cursor: pointer;
  background: var(--am-fill-1);
  border: 0;
  border-radius: var(--am-r-m);
  transition: transform var(--am-fast) var(--am-ease);
}

.am-shots__cell:hover,
.am-shots__cell:focus-visible {
  transform: translateY(-1px);
}

.am-shots__art {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/* Заглушка на месте кадра: та же пропорция, что у клетки, — появление
   кадров не перекладывает сетку. */
.am-shots__hold {
  aspect-ratio: 16 / 9;
  border-radius: var(--am-r-m);
}

/* Счётчик остальных: не клетка кадра, а дверь в просмотр. Своим тоном,
   чтобы его не приняли за ещё один кадр. */
.am-shots__more {
  display: grid;
  place-items: center;
  font-size: 15px;
  font-weight: 650;
  color: var(--am-accent);
  background: rgb(var(--am-accent-rgb) / 0.12);
  font-variant-numeric: tabular-nums;
}

/* Трейлер: кадр во всю ширину плитки с цветком пуска; подписи нет — кадр и так узнаётся по цветку. */
.am-shots__reel {
  position: relative;
  display: block;
  width: 100%;
  overflow: hidden;
  aspect-ratio: 16 / 9;
  margin-top: 10px;
  padding: 0;
  cursor: pointer;
  background: var(--am-fill-1);
  border: 0;
  border-radius: var(--am-r-m);
}

.am-shots__reelart {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--am-slow) var(--am-ease);
}

.am-shots__reel:hover .am-shots__reelart,
.am-shots__reel:focus-visible .am-shots__reelart {
  transform: scale(1.03);
}

.am-shots__play {
  position: absolute;
  top: 50%;
  left: 50%;
  display: grid;
  place-items: center;
  width: 46px;
  height: 46px;
  color: #0b1017;
  background: rgb(245 179 200 / 0.92);
  border-radius: var(--am-r-blob);
  transform: translate(-50%, -50%);
  transition: transform var(--am-fast) var(--am-ease);
}

.am-shots__play svg {
  width: 20px;
  height: 20px;
  fill: currentcolor;
}

.am-shots__reel:hover .am-shots__play,
.am-shots__reel:focus-visible .am-shots__play {
  transform: translate(-50%, -50%) scale(1.08);
}

/* ШИРОКАЯ ПЛИТКА: трейлер и сетка рядом, кадру треть, сетке две трети — только при
   отношении один к двум высоты сходятся; ниже 820px клетки мелки, плитка в столбик. */
@container (min-width: 820px) {
  .am-shots__body:has(.am-shots__reel) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 2fr);
    /* Просвет тот же, что между клетками сетки: кадр и сетка читаются
       одним полотном, а не двумя блоками рядом. */
    gap: 6px;
    align-items: start;
    margin-top: 10px;
  }

  /* Поля, которые при столбике разводят кадр и сетку, здесь не нужны:
     их разводит просвет между колонками. */
  .am-shots__body:has(.am-shots__reel) > .am-shots__reel,
  .am-shots__body:has(.am-shots__reel) > .am-shots__grid {
    margin-top: 0;
  }

  /* Строка «кадры не загрузились» — во всю плитку, а не в узкий столбец. */
  .am-shots__body:has(.am-shots__reel) > .am-meta {
    grid-column: 1 / -1;
  }
}

/* Счётчик кадров бледной пилюлей — как у музыки и персонажей. */
.am-shots__count {
  padding: 2px 8px;
  font-size: 11px;
  font-weight: 650;
  color: var(--am-faint);
  background: var(--am-fill-1);
  border-radius: var(--am-r-cap);
  font-variant-numeric: tabular-nums;
}

/* ГАЛЕРЕЯ. Тот же приём, что у прочих окон (.am-sheet): классы общие, правила свои.
   Ширина 1080: клетка 16:9 в четыре столбца — видно, что на кадре, а не только что он есть. */
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
  animation: am-shots-veil var(--am-mid) var(--am-ease) both;
}

.am-sheet__box {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(1080px, 100%);
  max-height: min(86vh, 900px);
  overflow: hidden;
  background: var(--am-panel);
  border: 1px solid var(--am-line);
  border-radius: var(--am-r-drop);
  box-shadow:
    var(--am-sh-2),
    inset 0 1px 0 var(--am-edge);
  animation: am-shots-in var(--am-mid) var(--am-ease-soft) both;
}

@keyframes am-shots-veil {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes am-shots-in {
  from {
    opacity: 0;
    transform: translateY(14px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* Шапка держится на месте: кадров полсотни, и уехавший заголовок с кнопкой
   закрытия заставлял бы искать их прокруткой. */
.am-sheet__top {
  display: flex;
  flex: 0 0 auto;
  gap: 10px;
  align-items: center;
  padding: 14px clamp(14px, 1.8vw, 22px);
  border-bottom: 1px solid var(--am-line-soft);
}

/* Заголовок в ряду не несёт своего нижнего отступа: он там для отбивки
   от содержимого, а в ряду с выравниванием по центру сдвигал бы счётчик. */
.am-sheet__top .am-h3 {
  margin: 0;
}

.am-sheet__body {
  flex: 1 1 auto;
  min-height: 0;
  padding: 14px clamp(14px, 1.8vw, 22px) 16px;
  overflow-y: auto;
  overscroll-behavior-y: contain;
}

/* Стена кадров: четыре в ряд. Пропорция задана клетке, как и в плитке, —
   кадры приходят разной ширины, и по картинке ряды вышли бы разной высоты. */
.am-shots__wall {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}

/* ПРОСМОТР. Занавес глуше, чем у окон: под кадром не должно читаться
   содержимое страницы — иначе полный кадр спорит с ней за внимание. */
.am-look,
.am-reel {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: clamp(12px, 3vw, 32px);
}

.am-look__veil,
.am-reel__veil {
  position: absolute;
  inset: 0;
  padding: 0;
  cursor: default;
  background: rgb(4 6 10 / 0.9);
  border: 0;
}

.am-look__box {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
  max-width: min(1400px, 100%);
  max-height: 100%;
}

/* Полный кадр вписан, а не обрезан: смотреть пришли на кадр целиком. */
.am-look__art {
  display: block;
  max-width: 100%;
  max-height: calc(100vh - 130px);
  object-fit: contain;
  border-radius: var(--am-r-m);
  box-shadow: var(--am-sh-2);
}

.am-look__row,
.am-reel__row {
  position: relative;
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
}

.am-look__step {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  padding: 0;
  color: #eef3fb;
  cursor: pointer;
  background: rgb(255 255 255 / 0.1);
  border: 0;
  border-radius: var(--am-r-cap);
  transition: background-color var(--am-fast) var(--am-ease);
}

.am-look__step:hover,
.am-look__step:focus-visible {
  background: rgb(255 255 255 / 0.2);
}

.am-look__step svg {
  width: 16px;
  height: 16px;
  fill: currentcolor;
}

.am-look__num {
  font-size: 12px;
  color: #eef3fb;
  font-variant-numeric: tabular-nums;
}

.am-look__close {
  margin-left: auto;
}

/* ОКНО ТРЕЙЛЕРА. Кадр держит пропорцию сам: у встраиваемой страницы своя
   разметка, и растянуть её по высоте нельзя. */
.am-reel__box {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(1100px, 100%);
}

.am-reel__frame {
  width: 100%;
  aspect-ratio: 16 / 9;
  background: #000;
  border: 0;
  border-radius: var(--am-r-l);
  box-shadow: var(--am-sh-2);
}

.am-reel__name {
  overflow: hidden;
  font-size: 12px;
  color: #eef3fb;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Окно галереи в уменьшенном движении появляется без сдвига: появление
   не должно быть движением. */
@media (prefers-reduced-motion: reduce) {
  .am-sheet,
  .am-sheet__box {
    animation: none;
  }
}
</style>
