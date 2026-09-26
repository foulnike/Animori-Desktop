<script setup lang="ts">
// Свой выпадающий список на место <select>: список у нативного выбора рисует оболочка
// окна, а не наши стили, и на тёмных темах он выпадал белым и нечитаемым.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

/** Строка выбора: ключ уходит наружу, подпись видна человеку. */
export interface PickItem {
  key: string
  title: string
}

const props = withDefaults(
  defineProps<{
    modelValue: string
    items: ReadonlyArray<PickItem>
    /** Значок слева от текущего значения. */
    mark?: string | null
    /** Подпись для читалок экрана. */
    label?: string | null
    /** Ширина во всю доступную полосу: для рядов настроек. */
    wide?: boolean
  }>(),
  { mark: null, label: null, wide: false },
)

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>()

const open = ref(false)

/** Подсвеченная строка при ходьбе стрелками. */
const hot = ref(0)

/** Корень компонента: по нему отличается клик внутри от клика снаружи. */
const root = ref<HTMLElement | null>(null)

const nowTitle = computed<string>(
  () => props.items.find((item) => item.key === props.modelValue)?.title ?? '',
)

function close(): void {
  open.value = false
}

/** Открытие ведёт подсветку на текущее значение, а не на первую строку. */
function show(): void {
  const at = props.items.findIndex((item) => item.key === props.modelValue)
  hot.value = at >= 0 ? at : 0
  open.value = true
}

function toggle(): void {
  if (open.value) close()
  else show()
}

function pick(key: string): void {
  close()
  if (key !== props.modelValue) emit('update:modelValue', key)
}

/** Шаг подсветки с упором в края: прокрутка кольцом здесь только сбивает. */
function move(step: number): void {
  if (props.items.length === 0) return

  if (!open.value) {
    show()
    return
  }

  const next = hot.value + step
  hot.value = Math.min(props.items.length - 1, Math.max(0, next))
}

/** Enter и пробел на открытом списке берут подсвеченную строку. */
function onEnter(): void {
  if (!open.value) {
    show()
    return
  }

  const item = props.items[hot.value]
  if (item) pick(item.key)
}

/** Клик мимо закрывает список: без этого он жил бы поверх экрана вечно. */
function onOutside(e: PointerEvent): void {
  if (!open.value) return

  const box = root.value
  if (box !== null && e.target instanceof Node && !box.contains(e.target)) close()
}

onMounted(() => {
  document.addEventListener('pointerdown', onOutside)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onOutside)
})

// Смена состава снаружи не должна оставлять подсветку за краем списка.
watch(
  () => props.items.length,
  (count) => {
    if (hot.value >= count) hot.value = Math.max(0, count - 1)
  },
)
</script>

<template>
  <div ref="root" class="am-roll" :class="{ 'am-roll--wide': wide }">
    <button
      class="am-roll__hit"
      type="button"
      :aria-label="label ?? undefined"
      :aria-expanded="open"
      aria-haspopup="listbox"
      @click="toggle"
      @keydown.down.prevent="move(1)"
      @keydown.up.prevent="move(-1)"
      @keydown.enter.prevent="onEnter"
      @keydown.space.prevent="onEnter"
      @keydown.esc="close"
    >
      <span v-if="mark" class="am-roll__mark" aria-hidden="true">{{ mark }}</span>
      <span class="am-roll__now">{{ nowTitle }}</span>
      <span class="am-roll__arrow" :class="{ 'am-roll__arrow--up': open }" aria-hidden="true">
        ⌄
      </span>
    </button>

    <!-- Список только в раскрытом виде: скрытый слой перехватывал бы клики
         по плиткам под собой. -->
    <ul v-if="open" class="am-roll__drop" role="listbox" :aria-label="label ?? undefined">
      <li v-for="(item, at) in items" :key="item.key" class="am-roll__line">
        <button
          class="am-roll__item"
          :class="{
            'am-roll__item--on': item.key === modelValue,
            'am-roll__item--hot': at === hot,
          }"
          type="button"
          role="option"
          :aria-selected="item.key === modelValue"
          @click="pick(item.key)"
          @mouseenter="hot = at"
        >
          <span class="am-roll__text">{{ item.title }}</span>
          <span v-if="item.key === modelValue" class="am-roll__tick" aria-hidden="true">✓</span>
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.am-roll {
  position: relative;
  display: inline-flex;
  flex: none;
  min-width: 0;
}

.am-roll--wide {
  display: flex;
  flex: 1 1 auto;
}

/* Закрытый вид повторяет пилюлю поля рядом: свой выбор не должен
   выглядеть гостем среди остальных органов управления. */
.am-roll__hit {
  display: inline-flex;
  flex: 1 1 auto;
  gap: 9px;
  align-items: center;
  min-width: 0;
  min-height: var(--am-ctl);
  padding: 0 13px;
  font: inherit;
  font-size: 13px;
  color: var(--am-text);
  text-align: left;
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    border-color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    box-shadow var(--am-mid) var(--am-ease);
}

.am-roll__hit:hover {
  background: var(--am-fill-2);
}

.am-roll__hit[aria-expanded='true'] {
  border-color: rgb(var(--am-accent-rgb) / 0.5);
  box-shadow: var(--am-sh-glow);
}

/* Значок слева — тоже в своём квадрате: символы вроде ⚑ и ◆ имеют
   разную высоту коробки и без рамки сдвигали строку каждый своё число пикселей. */
.am-roll__mark {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 16px;
  height: 16px;
  font-size: 13px;
  line-height: 1;
  color: var(--am-faint);
}

.am-roll__now {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Стрелка поворачивается на раскрытии: иначе непонятно, открыт список или нет.
   Свой квадрат под знак обязателен: голый ⌄ сидел ниже середины пилюли. */
.am-roll__arrow {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 16px;
  height: 16px;
  margin-top: -2px;
  font-size: 15px;
  line-height: 1;
  color: var(--am-faint);
  transition: transform var(--am-mid) var(--am-ease);
}

.am-roll__arrow--up {
  margin-top: 2px;
  transform: rotate(180deg);
}

/* Раскрытый список — стекло на плотной подложке. Плотность обязательна:
   сквозь полупрозрачный список читалась сетка постеров под ним. */
.am-roll__drop {
  position: absolute;
  top: calc(100% + 7px);
  left: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 100%;
  max-height: 320px;
  padding: 6px;
  margin: 0;
  overflow-y: auto;
  list-style: none;
  background: var(--am-panel-2);
  border: 1px solid var(--am-line);
  border-radius: var(--am-r-m);
  box-shadow: var(--am-sh-2);
  backdrop-filter: blur(var(--am-blur-strong)) saturate(1.4);
  animation: am-roll-in var(--am-fast) var(--am-ease) both;
}

@keyframes am-roll-in {
  from {
    opacity: 0;
    transform: translateY(-6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.am-roll__line {
  display: flex;
}

.am-roll__item {
  display: flex;
  flex: 1 1 auto;
  gap: 10px;
  align-items: center;
  min-height: 34px;
  padding: 0 11px;
  font: inherit;
  font-size: 13px;
  color: var(--am-dim);
  text-align: left;
  white-space: nowrap;
  cursor: pointer;
  background: none;
  border: 0;
  border-radius: var(--am-r-s);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease);
}

/* Подсветка одна и та же для курсора и для ходьбы стрелками. */
.am-roll__item--hot {
  color: var(--am-text);
  background: var(--am-fill-2);
}

.am-roll__item--on {
  color: var(--am-text);
  background: linear-gradient(
    100deg,
    rgb(var(--am-accent-rgb) / 0.2),
    rgb(var(--am-accent-2-rgb) / 0.1)
  );
}

.am-roll__text {
  flex: 1 1 auto;
}

/* Галка тоже в квадрате: без него она тянула строку вниз на пиксель. */
.am-roll__tick {
  display: grid;
  flex: 0 0 auto;
  place-items: center;
  width: 14px;
  height: 14px;
  font-size: 12px;
  line-height: 1;
  color: var(--am-accent);
}

@media (prefers-reduced-motion: reduce) {
  .am-roll__drop {
    animation: none;
  }

  .am-roll__arrow {
    transition: none;
  }
}
</style>
