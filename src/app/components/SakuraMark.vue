<script setup lang="ts">
// Малая сакура — знак в потоке строки, а не подложка кнопки: не SakuraBloom (тот внутри кнопки),
// без сердцевины, viewBox расширен под выступ лепестков; геометрия общая — в app/sakura.ts.
import { SAKURA_PETAL, SAKURA_TURNS, sakuraTurnMark } from '../sakura'
</script>

<template>
  <svg class="am-sakura" viewBox="-2.1 -2.1 36.2 36.2" aria-hidden="true" focusable="false">
    <path
      v-for="turn in SAKURA_TURNS"
      :key="turn"
      :d="SAKURA_PETAL"
      :transform="sakuraTurnMark(turn)"
    />
  </svg>
</template>

<!-- Стили без scoped: имя am-sakura короткое, но префикс всё равно свой,
     и правил у знака немного. scoped добавил бы хеш без пользы. -->
<style>
/* Размер задаёт тот, кто ставит знак, через --am-sakura-size; по умолчанию 1em —
   соразмерно кеглю текста рядом, без размера знак растягивался бы во весь блок. */
.am-sakura {
  display: block;
  flex: none;
  width: var(--am-sakura-size, 1em);
  height: var(--am-sakura-size, 1em);
  fill: currentcolor;
}
</style>
