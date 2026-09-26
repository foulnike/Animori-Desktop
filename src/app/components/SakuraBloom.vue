<script setup lang="ts">
// Подложка круглой кнопки: в покое круг, под курсором — сакура со знака; сама ловит :hover хозяина.
// Слой с pointer-events: none (clip-path резал бы нажатие и фокус); прозрачность на корне — против швов.

// Лепесток и его развороты — в app/sakura.ts: тем же цветком помечается
// своё на главной (SakuraMark.vue), и геометрия у знака должна быть одна.
import { SAKURA_PETAL as PETAL, SAKURA_TURNS as TURNS, sakuraTurn as petalTurn } from '../sakura'
</script>

<template>
  <svg class="am-bloom" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <circle class="am-bloom__bud" cx="16" cy="16" r="14" />
    <g class="am-bloom__petals">
      <path v-for="turn in TURNS" :key="turn" :d="PETAL" :transform="petalTurn(turn)" />
    </g>
  </svg>
</template>

<!-- Стили нарочно без scoped: цветку нужен :hover хозяина, а из scoped блока до родителя
     не дотянуться. Имена под префиксом am-bloom заняты только здесь. -->
<style>
.am-bloom {
  /* Нависание за край кнопки: лепестки раскрываются шире круга, иначе цветок втягивался
     бы внутрь себя; считается от размера хозяина, т.к. лепестки выходят за viewBox. */
  position: absolute;
  inset: calc(-1 * var(--am-bloom-out, 2px));

  /* Клики и наведение остаются у кнопки: иначе курсор попадал бы
     на выступающий лепесток и терял его вместе с распуском. */
  pointer-events: none;

  /* Лепестки доходят до радиуса 18 в квадрате 32 — две единицы
     наружу. Без этого концы срезало внешним svg. */
  overflow: visible;

  /* Разбавление всего слоя разом, а не каждой заливки по отдельности:
     почему именно так — в заметке о прозрачности выше. */
  opacity: var(--am-bloom-veil, 0.82);

  filter: drop-shadow(var(--am-bloom-shade, 0 2px 5px var(--am-veil)));
  transition: filter var(--am-mid) var(--am-ease);
}

/* Круг в покое. Под курсором съёживается до сердцевины: оставь его
   в полный рост — он заполнит впадины и цветок снова станет кругом. */
.am-bloom__bud {
  fill: var(--am-bloom-deep, #0b1017);
  transform-box: view-box;
  transform-origin: 16px 16px;
  transition:
    fill var(--am-mid) var(--am-ease),
    transform var(--am-mid) var(--am-ease);
}

/* Закручены и стянуты внутрь круга. Поворот обязателен: без него цветок не распускается,
   а наезжает на зрителя; своя opacity занята распуском и с корневой лишь перемножается. */
.am-bloom__petals {
  fill: var(--am-bloom-petal, #0b1017);
  opacity: 0;
  transform: rotate(-26deg) scale(0.62);
  transform-box: view-box;
  transform-origin: 16px 16px;
  transition:
    fill var(--am-mid) var(--am-ease),
    opacity var(--am-mid) var(--am-ease),
    transform var(--am-mid) var(--am-ease);
}

/* Хозяин описан через :where, чтобы правило не перевешивало собственные
   стили кнопки: вес селектора остаётся как у одного класса. */
:where(button, a, [role='button']):hover > .am-bloom .am-bloom__petals,
:where(button, a, [role='button']):focus-visible > .am-bloom .am-bloom__petals {
  opacity: 1;
  transform: none;
}

:where(button, a, [role='button']):hover > .am-bloom .am-bloom__bud,
:where(button, a, [role='button']):focus-visible > .am-bloom .am-bloom__bud {
  transform: scale(0.93);
}

/* Свечение розовым, а не заливка розовым во всю силу: на чистом
   #f5b3c8 белый крестик даёт контраст 1.7:1 и исчезает. */
:where(button, a, [role='button']):hover > .am-bloom,
:where(button, a, [role='button']):focus-visible > .am-bloom {
  filter: drop-shadow(var(--am-bloom-shade, 0 2px 5px var(--am-veil)))
    drop-shadow(0 0 9px rgb(var(--am-sakura-rgb) / 0.45));
}

/* В покое лепестки не крутятся и не растут: остаётся просто
   появление, а общее правило темы гасит его длительность. */
@media (prefers-reduced-motion: reduce) {
  .am-bloom__petals {
    transform: none;
  }
}
</style>
