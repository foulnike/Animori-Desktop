<script setup lang="ts">
// Пункт 3.2: рамка окна — рельс меню, шапка, сменный экран; о экранах знает только имена из routes.ts.
// Рельс всегда сложен: раскрывается под курсором или фокусом поверх сетки; мышью фокус снимается сразу.
import { computed, onBeforeUnmount, watch } from 'vue'

import { APPEARANCES, appearance, setAppearance } from '../appearance'
import { currentRoute, goBack, navigate, navDirection } from '../router'
import { MENU, SCREEN_TITLES } from '../router/routes'

import AppMark from './AppMark.vue'

const version = __ANIMORI_VERSION__

const active = computed(() => currentRoute.value.name)
const title = computed(() => SCREEN_TITLES[active.value])

/** Имя экрана из меню: берётся из самого состава, а не перечисляется вторично. */
type MenuName = (typeof MENU)[number]['name']

// «Назад» — только экранам, куда пришли изнутри: на экранах меню он увёл бы в пустую историю окна.
// Журнал обязателен: в меню его нет, и без «Назад» из него не выйти.
const BACK_SCREENS: ReadonlyArray<string> = ['media', 'studio', 'log']

const canGoBack = computed(() => BACK_SCREENS.includes(active.value))

/** Прокрутка каждого экрана: возврат с карточки не должен выбрасывать к началу списка. */
const scrollByScreen = new Map<string, number>()

/** Сколько раз пробуем вернуть прокрутку: экран растёт порциями — заглушки, полки, картинки. */
const SCROLL_TRIES = 20
const SCROLL_STEP_MS = 60

/** Отмена идущего возврата: зовётся при новом переходе и при ручной прокрутке. */
let scrollStop: (() => void) | null = null

/** Возврат прокрутки: повторы, пока страница не доросла до прежнего места. */
function restoreScroll(top: number): void {
  let left = SCROLL_TRIES
  let timer: ReturnType<typeof setTimeout> | null = null

  const stop = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    left = 0
    scrollStop = null
    window.removeEventListener('wheel', stop)
    window.removeEventListener('touchmove', stop)
    window.removeEventListener('keydown', stop)
  }

  const step = (): void => {
    if (left <= 0) return
    window.scrollTo(0, top)

    if (Math.abs(window.scrollY - top) <= 2 || --left <= 0) {
      stop()
      return
    }

    timer = setTimeout(step, SCROLL_STEP_MS)
  }

  // Человек взялся за прокрутку сам — не спорим с ним.
  window.addEventListener('wheel', stop, { passive: true })
  window.addEventListener('touchmove', stop, { passive: true })
  window.addEventListener('keydown', stop)

  scrollStop = stop
  step()
}

// post: место возвращается после отрисовки нового экрана, иначе прокручивать некуда.
watch(
  active,
  (next, prev) => {
    scrollByScreen.set(prev, window.scrollY)
    scrollStop?.()

    window.scrollTo(0, 0)

    const want = scrollByScreen.get(next) ?? 0
    if (want > 0) restoreScroll(want)
  },
  { flush: 'post' },
)

onBeforeUnmount(() => {
  scrollStop?.()
})

/** Выбор пункта меню: у клавиатуры detail нулевой, и фокус остаётся на кнопке; мыши фокус не нужен. */
function onPick(name: MenuName, e: MouseEvent): void {
  if (e.detail > 0 && e.currentTarget instanceof HTMLElement) e.currentTarget.blur()
  navigate(name)
}

/** Обновление окна целиком, как в браузере: одна кнопка на все экраны. */
function onReload(): void {
  window.location.reload()
}
</script>

<template>
  <div class="am-shell">
    <aside class="am-side">
      <div class="am-side__brand">
        <!-- Знак приложения отдельным компонентом: три темы ему нужны всегда,
             и держать их в разметке рельса было не место. -->
        <AppMark class="am-side__logo" />

        <span class="am-side__name">AniMori</span>
      </div>

      <nav class="am-side__menu">
        <button
          v-for="item in MENU"
          :key="item.name"
          v-tip="item.title"
          class="am-side__item"
          :class="{ 'am-side__item--on': item.name === active }"
          type="button"
          @click="onPick(item.name, $event)"
        >
          <span class="am-side__icon" :class="`am-side__icon--${item.name}`" aria-hidden="true">{{ item.icon }}</span>
          <span class="am-side__text">{{ item.title }}</span>
        </button>
      </nav>

      <span class="am-side__foot">{{ version }}</span>
    </aside>

    <div class="am-body">
      <header class="am-top">
        <!-- Стрелка нарисована, а не набрана знаком ←: текстовая стрелка
             в каждом шрифте своя, и к остальным знакам интерфейса она не подходит. -->
        <button v-if="canGoBack" class="am-top__back" type="button" @click="goBack">
          <span class="am-top__sign" aria-hidden="true">
            <svg class="am-top__arrow" viewBox="0 0 16 16">
              <path d="M9.9 3.3 5.2 8l4.7 4.7" />
            </svg>
          </span>
          <span class="am-top__word">Назад</span>
        </button>
        <h1 class="am-top__title">{{ title }}</h1>

        <span class="am-top__gap" />

        <div class="am-skin" role="group" aria-label="Тема оформления">
          <button
            v-for="item in APPEARANCES"
            :key="item.name"
            v-tip="item.title"
            class="am-skin__btn"
            :class="{ 'am-skin__btn--on': item.name === appearance }"
            type="button"
            :aria-pressed="item.name === appearance"
            @click="setAppearance(item.name)"
          >
            <span aria-hidden="true">{{ item.mark }}</span>
          </button>
        </div>

        <button v-tip="'Обновить окно'" class="am-top__icon" type="button" @click="onReload">
          <span aria-hidden="true">⟳</span>
        </button>
      </header>

      <main class="am-view">
        <div
          :key="active"
          class="am-view__hold"
          :class="{
            'am-view__hold--deep': navDirection === 'deep',
            'am-view__hold--back': navDirection === 'back',
          }"
        >
          <slot />
        </div>
      </main>
    </div>
  </div>
</template>

<style scoped>
/* Место под рельс держит отступ, а не колонка сетки: с fixed-рельсом сетка ставила тело в узкую колонку.
   Ширина по сложенному рельсу: раскрытый ложится поверх содержимого и места не требует. */
.am-shell {
  min-height: 100vh;
  padding-left: var(--am-side-slim);
}

/* Рельс оторван от краёв окна: прижатое стекло читалось бы тёмной полосой.
   Поверх шапки (z-index: 5), чтобы не уезжать под её размытие; обрезка держит подписи сложенными. */
.am-side {
  position: fixed;
  top: 14px;
  bottom: 14px;
  left: 14px;
  z-index: 6;
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: calc(var(--am-side-slim) - 14px);
  padding: 18px 12px 16px;
  overflow: hidden;
  background: var(--am-glass);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-xl);
  box-shadow:
    var(--am-sh-1),
    inset 0 1px 0 var(--am-edge);
  backdrop-filter: blur(var(--am-blur-strong)) saturate(1.3);
  transition:
    width var(--am-mid) var(--am-ease),
    box-shadow var(--am-mid) var(--am-ease);
}

/* Фокус равен курсору: иначе обход меню с клавиатуры шёл бы по слепым значкам.
   После мышиного выбора фокус снимает onPick: это правило держало бы рельс разложенным. */
.am-side:hover,
.am-side:focus-within {
  width: calc(var(--am-side) - 14px);
  box-shadow:
    var(--am-sh-2),
    inset 0 1px 0 var(--am-edge);
}

/* Логотип сдвинут так, чтобы его центр совпал с центрами значков меню:
   6 + 17 ровно 14 + 9. Иначе при раскрытии ряд подпрыгивал бы влево. */
.am-side__brand {
  display: flex;
  gap: 11px;
  align-items: center;
  padding: 2px 6px 6px;
}

/* Здесь только размер и ореол: сам знак и его темы живут в AppMark.vue.
   Ореол без сдвига: со сдвигом центр свечения не совпадал с центром эмблемы. */
.am-side__logo {
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 12px;
  box-shadow: 0 0 22px rgb(var(--am-accent-rgb) / 0.35);
}

/* На AMOLED ореол убирается: знак там сам тёмный, и свечение вокруг него
   на чистом чёрном читается грязным пятном. */
:global([data-am-skin='amoled']) .am-side__logo {
  box-shadow: none;
}

/* Подписи рельса гаснут вместе; display: none нельзя — текст вскакивал бы рывком.
   nowrap обязателен: в узком рельсе слово иначе ломается по буквам и тянет высоту кнопки. */
.am-side__name,
.am-side__text,
.am-side__foot {
  white-space: nowrap;
  opacity: 0;
  transition:
    opacity var(--am-fast) var(--am-ease),
    transform var(--am-mid) var(--am-ease);
  transform: translateX(-6px);
}

.am-side:hover .am-side__name,
.am-side:hover .am-side__text,
.am-side:hover .am-side__foot,
.am-side:focus-within .am-side__name,
.am-side:focus-within .am-side__text,
.am-side:focus-within .am-side__foot {
  opacity: 1;
  transform: none;
}

.am-side__name {
  font-size: 16px;
  font-weight: 650;
  letter-spacing: 0.01em;
}

.am-side__menu {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.am-side__item {
  position: relative;
  display: flex;
  gap: 12px;
  align-items: center;
  min-height: var(--am-touch);
  padding: 0 14px;
  font: inherit;
  font-weight: 550;
  color: var(--am-dim);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease);
}

.am-side__item:hover {
  color: var(--am-text);
  background: var(--am-fill-1);
}

.am-side__item--on {
  color: var(--am-text);
  background: linear-gradient(
    100deg,
    rgb(var(--am-accent-rgb) / 0.22),
    rgb(var(--am-accent-2-rgb) / 0.1)
  );
}

/* Сложенный рельс: пункт — узкий бокс со значком по центру, скрытая подпись места не занимает.
   Раскрытие (:hover, :focus-within) возвращает обычную раскладку с подписью у левого края. */
.am-side:not(:hover):not(:focus-within) .am-side__item {
  justify-content: center;
  padding: 0;
  gap: 0;
}
.am-side:not(:hover):not(:focus-within) .am-side__text {
  width: 0;
  height: 0;
  overflow: hidden;
  opacity: 0;
}

/* Активный пункт помечен подложкой, а не каплей слева: капля повторяла штрих заголовков.
   Подложку видно и в узком рельсе, где подписи скрыты, — она единственная метка. */

/* Значок пункта — в своём квадрате с центровкой по двум осям: text-align ровнял лишь по горизонтали,
   и ряд плясал. line-height равен высоте квадрата, чтобы глиф встал ровно в середину. */
.am-side__icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 18px;
  height: 18px;
  font-size: 16px;
  line-height: 18px;
}

/* Лупа в системных шрифтах мельче соседних знаков: кегль чуть больше,
   чтобы все значки читались одной величиной. */
.am-side__icon--search {
  font-size: 18px;
  line-height: 16px;
}

.am-side__foot {
  margin-top: auto;
  padding: 0 10px;
  font-size: 12px;
  color: var(--am-faint);
  font-variant-numeric: tabular-nums;
}

.am-body {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
  min-width: 0;
}

/* Шапка держится сверху: при сетке в тысячу плиток вернуться к ней иначе долго. */
.am-top {
  position: sticky;
  top: 0;
  z-index: 5;
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 14px clamp(18px, 2vw, 44px);
}

/* Граница шапки — перетекание вниз, а не линия: жёсткий край резал плитки пополам.
   Слой отдельный: маска на самой шапке съела бы и кнопки вместе с фоном. */
.am-top::before {
  position: absolute;
  inset: 0 0 -28px;
  content: '';
  background: linear-gradient(180deg, var(--am-bar) 0%, var(--am-bar) 58%, transparent 100%);
  backdrop-filter: blur(var(--am-blur-strong)) saturate(1.2);
  -webkit-mask-image: linear-gradient(180deg, #000 58%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 58%, transparent 100%);
  pointer-events: none;
}

.am-top > * {
  position: relative;
  z-index: 1;
}

/* «Назад» — капсула со знаком в кружке слева. Отступ слева меньше правого:
   у кружка своя подложка, и равные отступы читались бы дырой перед ним. */
.am-top__back {
  display: inline-flex;
  gap: 8px;
  align-items: center;
  min-height: 34px;
  padding: 0 15px 0 5px;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease),
    box-shadow var(--am-mid) var(--am-ease);
}

/* Едет одна стрелка, а не вся кнопка: сдвиг капсулы тащил за собой
   рамку и кольцо фокуса, а они должны стоять на месте. */
.am-top__back:hover,
.am-top__back:focus-visible {
  color: var(--am-text);
  background: var(--am-fill-2);
  border-color: rgb(var(--am-accent-rgb) / 0.45);
  box-shadow: 0 8px 20px rgb(var(--am-accent-rgb) / 0.16);
}

/* Кружок со стрелкой: акцентная подложка держит знак как отдельное
   действие, а не как букву перед словом. */
.am-top__sign {
  display: grid;
  flex: none;
  place-items: center;
  width: 24px;
  height: 24px;
  color: var(--am-accent);
  background: var(--am-accent-soft);
  border-radius: var(--am-r-cap);
  transition:
    background-color var(--am-fast) var(--am-ease),
    transform var(--am-fast) var(--am-ease);
}

.am-top__back:hover .am-top__sign,
.am-top__back:focus-visible .am-top__sign {
  background: rgb(var(--am-accent-rgb) / 0.22);
  transform: translateX(-2px);
}

.am-top__arrow {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.am-top__title {
  margin: 0;
  font-size: 17px;
  font-weight: 650;
  letter-spacing: -0.012em;
}

.am-top__gap {
  flex: 1;
}

/* Переключатель тем: три знака в одной капсуле. Подписи живут в подсказке:
   три слова в шапке шумели бы громче заголовка экрана. */
.am-skin {
  display: inline-flex;
  gap: 2px;
  padding: 3px;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
}

/* Знаки тем разной высоты (солнце, луна, круг), поэтому центр считается
   от кнопки, а не от строки текста. */
.am-skin__btn {
  display: grid;
  place-items: center;
  width: 30px;
  height: 28px;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1;
  color: var(--am-faint);
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-mid) var(--am-ease);
}

.am-skin__btn:hover,
.am-skin__btn:focus-visible {
  color: var(--am-text);
}

.am-skin__btn > span {
  display: block;
  transition: transform var(--am-fast) var(--am-ease);
}

/* Знак поднимается вместо подсветки целой кнопки: подложка здесь
   занята выбранной темой. */
.am-skin__btn:hover > span,
.am-skin__btn:focus-visible > span {
  transform: translateY(-1px);
}

.am-skin__btn--on {
  color: var(--am-text);
  background: var(--am-glass-2);
  box-shadow:
    var(--am-sh-1),
    inset 0 1px 0 var(--am-edge);
}

/* Круглая кнопка справа: обновляет окно целиком. */
.am-top__icon {
  display: grid;
  flex: none;
  place-items: center;
  width: 34px;
  height: 34px;
  font: inherit;
  font-size: 16px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease);
}

.am-top__icon:hover,
.am-top__icon:focus-visible {
  color: var(--am-text);
  border-color: var(--am-accent);
}

/* Крутится сам знак, а не кнопка: поворот всей кнопки тащил за собой
   рамку и фокусное кольцо, а они должны стоять на месте. */
.am-top__icon > span {
  display: block;
  transition: transform var(--am-slow) var(--am-ease);
}

.am-top__icon:hover > span,
.am-top__icon:focus-visible > span {
  transform: rotate(180deg);
}

.am-view {
  flex: 1;
  width: 100%;
  padding: clamp(16px, 1.6vw, 30px) clamp(18px, 2vw, 44px) 72px;
}

/* Потолок ширины с центровкой: без него на широком окне
   строка текста тянулась бы метрами. */
.am-view__hold {
  width: 100%;
  max-width: var(--am-page-max);
  margin: 0 auto;
  animation: am-rise var(--am-mid) var(--am-ease) both;
}

/* Смена экрана всплывает, а не моргает: ключ на имени экрана перезапускает анимацию.
   На смене вкладок то же движение: сдвиг вбок сообщал бы о переходе, которого не было. */
@keyframes am-rise {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* Экран въезжает со стороны, куда шёл человек; движется только приходящий — уходящий уже снят разметкой.
   Сдвиг 18px — ровно боковое поле .am-view; обрезать его нельзя: внутри прилипающая панель плеера. */
.am-view__hold--deep {
  animation-name: am-deep;
}

.am-view__hold--back {
  animation-name: am-back;
}

@keyframes am-deep {
  from {
    opacity: 0;
    transform: translate3d(18px, 0, 0);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@keyframes am-back {
  from {
    opacity: 0;
    transform: translate3d(-18px, 0, 0);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* Узкое окно: у «Назад» убирается слово, капсула становится кружком — правый отступ лишний. */
@media (max-width: 1080px) {
  .am-top__word {
    display: none;
  }

  .am-top__back {
    padding: 0 5px;
  }
}

/* Спокойное движение: системная просьба сильнее наших красот. */
@media (prefers-reduced-motion: reduce) {
  .am-view__hold {
    animation: none;
  }

  .am-side__name,
  .am-side__text,
  .am-side__foot,
  .am-top__back:hover .am-top__sign,
  .am-top__back:focus-visible .am-top__sign,
  .am-skin__btn:hover > span,
  .am-skin__btn:focus-visible > span,
  .am-top__icon:hover > span,
  .am-top__icon:focus-visible > span {
    transform: none;
  }
}
</style>
