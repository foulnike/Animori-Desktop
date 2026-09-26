<script setup lang="ts">
// Знак сервиса: плита фирменного цвета и вектор из src/app/brand — логотипы не перерисовываем.
// ?raw встраивает файл в разметку, чтобы красить знак отсюда; цветным логотипам tint: false.
import { computed } from 'vue'

import anilistGlyph from '../brand/anilist.svg?raw'
import malGlyph from '../brand/myanimelist.svg?raw'
import shikimoriGlyph from '../brand/shikimori.svg?raw'
import spotifyGlyph from '../brand/spotify.svg?raw'
import yandexDiskGlyph from '../brand/yandex-disk.svg?raw'
import yandexMusicGlyph from '../brand/yandex-music.svg?raw'
import youtubeMusicGlyph from '../brand/youtube-music.svg?raw'

type BrandName =
  | 'anilist'
  | 'shikimori'
  | 'myanimelist'
  | 'yandex-disk'
  | 'spotify'
  | 'youtube-music'
  | 'yandex-music'

type Brand = {
  /** Содержимое файла знака: вставляется в разметку как есть. */
  glyph: string
  /** Плита под знаком — фирменный цвет сервиса. */
  plate: string
  /** Сам знак поверх плиты. */
  ink: string
  /** Доля плиты под знак: оптический размер разный, плотной «AL» нужны поля больше. */
  size: string
  /** Знак нарисован штрихом, а не заливкой. */
  stroke?: boolean
  /** Перекрашивать ли знак в ink: у цветных логотипов цвета — часть знака.
      Флаг задан явно: угадывание по <image> сломалось бы на MAL, где растр есть, а плита нужна. */
  tint?: boolean
  /** Круглый знак: обрезка по кругу срезает белые углы картинки стримингов. */
  round?: boolean
}

const BRANDS: Record<BrandName, Brand> = {
  anilist: {
    glyph: anilistGlyph,
    plate: '#02a9ff',
    ink: '#ffffff',
    size: '58%',
    tint: true,
  },
  shikimori: {
    glyph: shikimoriGlyph,
    plate: '#aad3e7',
    ink: '#16202c',
    size: '78%',
    tint: true,
  },
  // Надпись широкая и низкая: поля меньше остальных, иначе буквы садятся строчкой в пиксель высотой.
  // Цвет букв держит сама картинка, и ink здесь только для порядка.
  myanimelist: {
    glyph: malGlyph,
    plate: '#2e51a2',
    ink: '#ffffff',
    size: '78%',
  },
  'yandex-disk': {
    glyph: yandexDiskGlyph,
    plate: '#fc3f1d',
    ink: '#ffffff',
    size: '64%',
    stroke: true,
    tint: true,
  },
  // Стриминги: круг входит в сам знак, поэтому плита прозрачная,
  // а знак занимает всю площадь без полей.
  spotify: {
    glyph: spotifyGlyph,
    plate: 'transparent',
    ink: '#1db954',
    size: '100%',
    round: true,
  },
  'youtube-music': {
    glyph: youtubeMusicGlyph,
    plate: 'transparent',
    ink: '#ff0000',
    size: '100%',
    round: true,
  },
  'yandex-music': {
    glyph: yandexMusicGlyph,
    plate: 'transparent',
    ink: '#ffcc00',
    size: '100%',
    round: true,
  },
}

const props = defineProps<{ name: BrandName }>()

const brand = computed<Brand>(() => BRANDS[props.name])
</script>

<template>
  <!-- aria-hidden: название сервиса всегда стоит текстом рядом,
       и знак второй раз его не проговаривает. -->
  <span
    class="am-brand"
    :class="{
      'am-brand--stroke': brand.stroke === true,
      'am-brand--tint': brand.tint === true,
      'am-brand--round': brand.round === true,
    }"
    :style="{
      '--am-brand-plate': brand.plate,
      '--am-brand-ink': brand.ink,
      '--am-brand-size': brand.size,
    }"
    aria-hidden="true"
    v-html="brand.glyph"
  />
</template>

<style scoped>
/* Размер приходит снаружи; здесь только форма, цвет и центровка.
   overflow: hidden обязателен: без обрезки заливка вылезала бы за скругление плиты. */
.am-brand {
  display: grid;
  flex: none;
  place-items: center;
  overflow: hidden;
  color: var(--am-brand-ink);
  background: var(--am-brand-plate);
  border-radius: 26%;
}

/* :deep обязателен: вектор встроен через v-html и метки области
   видимости не получает. */
.am-brand :deep(svg) {
  display: block;
  width: var(--am-brand-size);
  height: var(--am-brand-size);
}

/* Одноцветные векторы красятся в ink; цветные логотипы — нет, иначе
   заливка съедает фирменные цвета. */
.am-brand--tint :deep(svg) {
  fill: currentColor;
}

/* Штриховой знак заливать нельзя: она слепила бы контур в пятно. */
.am-brand--stroke :deep(svg) {
  fill: none;
  stroke: currentColor;
}

/* Круглый знак: обрезка по кругу срезает белые углы картинки. */
.am-brand--round {
  border-radius: 50%;
}
</style>
