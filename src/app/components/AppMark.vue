<script setup lang="ts">
// Знак приложения в рельсе: та же картинка, что иконка окна (src-tauri/icons/128x128.png),
// вектор заменён ей, т.к. собранный вручную цветок расходился с иконкой окна и ломался на 34px.
import markSrc from '../../../src-tauri/icons/128x128.png'
</script>

<template>
  <!-- alt пустой: название программы уже стоит рядом текстом.
       draggable="false": иначе знак таскался бы мышью, как любая картинка в браузере. -->
  <img class="am-mark" :src="markSrc" alt="" draggable="false" />
</template>

<style scoped>
/* Ширины и высоты здесь нет сознательно: их задаёт тот, кто ставит
   знак, и свой размер перебивал бы его класс. */
.am-mark {
  display: block;
  flex: none;
  object-fit: contain;
}
</style>
