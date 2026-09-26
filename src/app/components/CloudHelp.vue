<script setup lang="ts">
// Инструкция к облачной копии: отдельной модалкой, а не абзацами в панели — её читают один раз.
// Своего состояния нет; уводится в body: fixed внутри предка с transform считался бы от предка.
import { onBeforeUnmount, watch } from 'vue'

import { Bridge } from '@/bridge'

const props = defineProps<{
  /** Открыта ли модалка. */
  open: boolean
  /** Путь к файлу копии: спрашивается у ядра, а не переписывается здесь. */
  path: string
}>()

const emit = defineEmits<{ close: [] }>()

/** Где человек заводит своё приложение Яндекса и берёт пропуск. */
const YANDEX_OAUTH_URL = 'https://oauth.yandex.com/client/new/'

/// Внешние адреса открывает оболочка: target="_blank" в WebView2
/// отбрасывается молча, без окна и без ошибки.
function onOauth(): void {
  void Bridge.shell.openExternal(YANDEX_OAUTH_URL)
}

function onClose(): void {
  emit('close')
}

/// Esc закрывает: модалка перекрывает экран целиком, а на пульте мышью
/// до крестика не добраться вовсе.
function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') onClose()
}

// Слушатель живёт только пока модалка открыта: висящий на document
// обработчик закрытого окна перехватывал бы Esc у экранов под ним.
watch(
  () => props.open,
  (open) => {
    if (open) document.addEventListener('keydown', onKey)
    else document.removeEventListener('keydown', onKey)
  },
)

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKey)
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="am-modal"
      role="dialog"
      aria-modal="true"
      aria-label="Облачная копия: порядок действий"
    >
      <!-- Клик мимо закрывает: это справка, и держать её силой незачем. -->
      <div class="am-modal__veil" @click="onClose" />

      <div class="am-modal__box">
        <div class="am-modal__head">
          <h3 class="am-modal__title">Облачная копия: порядок действий</h3>
          <button class="am-modal__x" type="button" aria-label="Закрыть" @click="onClose">✕</button>
        </div>

        <div class="am-modal__body">
          <h4 class="am-modal__h">Пропуск Яндекса — один раз</h4>
          <ol>
            <li>
              Откройте
              <button class="am-modal__link" type="button" @click="onOauth">oauth.yandex.com</button>
              и нажмите «Создать приложение».
            </li>
            <li>Название — любое.</li>
            <li>Платформы → «Веб-сервисы» → кнопка «Подставить URL для отладки».</li>
            <li>
              Доступ к данным → «Приложения на Диске» (<code>cloud_api:disk.app_folder</code>).
            </li>
            <li>Создайте приложение и скопируйте <b>ClientID</b> с его страницы.</li>
            <li>
              Откройте в браузере
              <code>https://oauth.yandex.ru/authorize?response_type=token&amp;client_id=ВАШ_ID</code>
              и разрешите доступ.
            </li>
            <li>
              Скопируйте пропуск из адресной строки: он между <code>access_token=</code>
              и первым <code>&amp;</code>.
            </li>
            <li>
              В панели «Облачная копия»: «Подключить» → поле «Пропуск Яндекс Диска» →
              «Проверить и сохранить».
            </li>
          </ol>

          <h4 class="am-modal__h">Сохранить копию</h4>
          <ol>
            <li>Нажмите <b>Сохранить</b> — список → облако.</li>
            <li>
              Если спросит про копию с другого устройства — <b>Сначала забрать</b> или
              <b>Заменить копию</b>.
            </li>
          </ol>

          <h4 class="am-modal__h">Забрать копию</h4>
          <ol>
            <li>Нажмите <b>Забрать</b> — облако → список.</li>
            <li>
              Выберите способ:
              <ul>
                <li><b>Добавить недостающее</b> — берёт из копии то, чего здесь нет.</li>
                <li><b>Заменить целиком</b> — список станет ровно таким, как в копии.</li>
              </ul>
            </li>
          </ol>

          <h4 class="am-modal__h">Перенести на телевизор</h4>
          <ol>
            <li>На компьютере: раздел «Ссылка для телевизора» → «Создать ссылку».</li>
            <li>Запишите хвост ссылки — знаки после последней косой черты.</li>
            <li>
              На телевизоре: раздел «Забрать по ссылке» → введите хвост → «Найти копию».
              Пропуск там не нужен.
            </li>
            <li>«Добавить недостающее» или «Заменить целиком».</li>
            <li>На компьютере: «Закрыть доступ».</li>
          </ol>

          <h4 class="am-modal__h">Где что искать</h4>
          <ul>
            <li>Файл копии — <code>{{ path }}</code>. На Диске: раздел «Приложения».</li>
            <li>Пропуск — на этом устройстве. В копию он не попадает.</li>
            <li>
              Значки в строке «Яндекс Диск»: <b>↻</b> проверить связь, <b>🔑</b> сменить
              пропуск, <b>✕</b> отключить облако.
            </li>
            <li>После отключения файл остаётся на Диске — удалить его можно там же.</li>
          </ul>

          <div class="am-modal__warn">
            По ссылке копию прочитает любой, кто её знает. После переноса нажмите
            «Закрыть доступ». У публичных ссылок Яндекса есть суточный предел
            скачиваний.
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/* Модалка на весь экран: сама справка узкая, но подложка обязана перекрыть
   всё, иначе клик мимо уходит в панель под ней. */
.am-modal {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: grid;
  place-items: center;
  padding: 24px;
}

/* Подложка красится темой, а не чᄅрным литералом: на светлой теме чёрная
   вуаль читалась провалом в экране. */
.am-modal__veil {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--am-bg) 76%, transparent);
  backdrop-filter: blur(var(--am-blur-strong));
}

.am-modal__box {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(640px, 100%);
  max-height: min(760px, 88vh);
  background: var(--am-panel-2);
  border: 1px solid var(--am-line);
  border-radius: var(--am-r-m);
  box-shadow: var(--am-sh-2);
  animation: am-modal-in var(--am-mid) var(--am-ease) both;
}

@keyframes am-modal-in {
  from {
    opacity: 0;
    transform: translateY(10px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.am-modal__head {
  display: flex;
  flex: none;
  gap: 12px;
  align-items: center;
  padding: 15px 15px 13px 18px;
  border-bottom: 1px solid var(--am-line-soft);
}

.am-modal__title {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 15px;
  font-weight: 700;
  color: var(--am-text);
}

.am-modal__x {
  display: grid;
  flex: none;
  place-items: center;
  width: 30px;
  height: 30px;
  font: inherit;
  font-size: 13px;
  line-height: 1;
  color: var(--am-dim);
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    color var(--am-fast) var(--am-ease),
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease);
}

.am-modal__x:hover {
  color: var(--am-text);
  background: var(--am-hover);
  border-color: rgb(var(--am-accent-rgb) / 0.45);
}

/* Текст справки прокручивается внутри рамки: шаги все нужны, и резать
   их на страницы незачем. */
.am-modal__body {
  display: flex;
  flex-direction: column;
  gap: 11px;
  padding: 16px 18px 20px;
  overflow-y: auto;
  font-size: 13px;
  line-height: 1.6;
  color: var(--am-dim);
}

.am-modal__body p {
  margin: 0;
}

.am-modal__body b {
  color: var(--am-text);
}

.am-modal__h {
  margin: 7px 0 0;
  font-size: 12px;
  font-weight: 700;
  color: var(--am-text);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.am-modal__body ol,
.am-modal__body ul {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0;
  padding-left: 20px;
}

/* Вложенный список — варианты внутри шага, а не новый шаг: отступ поменьше
   и своё поле сверху, иначе он сливается со строкой шага. */
.am-modal__body li > ul {
  gap: 4px;
  margin-top: 5px;
  padding-left: 16px;
}

/* Адреса и права в тексте — набранные, а не пересказанные: их копируют как есть.
   Перенос по любому месту обязателен: ссылка с ClientID в одну строку панели не встаёт. */
.am-modal__body code {
  padding: 1px 6px;
  font-size: 12px;
  background: var(--am-fill-2);
  border-radius: var(--am-r-s);
  overflow-wrap: anywhere;
}

/* Предупреждение тем же тоном, что и вопросы в панели: это не поломка,
   и красным его показывать неправильно. */
.am-modal__warn {
  padding: 11px 13px;
  background: color-mix(in srgb, var(--am-warn) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--am-warn) 42%, transparent);
  border-radius: var(--am-r-m);
}

.am-modal__link {
  padding: 0;
  font: inherit;
  color: var(--am-accent);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
  background: none;
  border: 0;
}

@media (prefers-reduced-motion: reduce) {
  .am-modal__box {
    animation: none;
  }
}
</style>
