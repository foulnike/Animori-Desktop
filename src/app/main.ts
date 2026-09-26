// Точка входа своего клиента (режим сборки app).
// Отличие от скрипта: разметка своя и готова сразу, ждать нечего.

import { createApp } from 'vue'
import App from './App.vue'
import { startAppearance } from './appearance'
import { seen } from './see-tile'
import { tip } from './tip'
import { initCollection } from '@/core/collection'
import { initDatasetNames, updateDatasetNamesInBackground } from '@/core/dataset-names'
import { loadSettings } from '@/core/settings'
import { installGlobalErrorHandlers } from '@/utils/logger'

// Стиль всплывающих подписей: плашка живёт в body, и scoped-правила
// компонентов до неё не достают.
import './styles/tip.css'

// Корень обязан существовать: он лежит в нашем же index.html.
// Если его нет, разметка разошлась с кодом — молчать об этом вредно.
const root = document.getElementById('app')
if (!root) throw new Error('AniMori: корень #app не найден в index.html')

/** Снимает заставку index.html сразу после монтирования: раньше нельзя — Vue дописывает своё, не стирая. */
function hideBoot(): void {
  document.getElementById('boot')?.remove()
}

/** Настройки — до первой отрисовки, коллекция — после монтирования (список односторонний), датасет фоном. */
async function start(): Promise<void> {
  await loadSettings()

  // Тема ставится до первой отрисовки и сразу после настроек: светлое окно,
  // темнеющее на глазах, читается как поломка, а не как выбор оформления.
  startAppearance()

  // Перехватчики ставятся до первой отрисовки: сбой монтирования — тоже
  // событие для журнала. Раньше настроек нельзя: тумблер журнала не прочтён.
  installGlobalErrorHandlers()

  // Подписи v-tip и v-seen регистрируются на всё приложение: их просят метки плиток, кнопки шапок и полки
  // карточек. У каждой один наблюдатель на всё окно, место ей здесь же.
  createApp(App)
    .directive('tip', tip)
    .directive('seen', seen)
    .mount(root as HTMLElement)

  hideBoot()

  // Ошибка подъёма окно не роняет — список просто останется пустым до
  // первого действия, а причина уйдёт в журнал.
  try {
    await initCollection()
  } catch (e: unknown) {
    console.error('AniMori: список не поднялся из снимка', e)
  }

  void initDatasetNames()
  updateDatasetNamesInBackground()
}

void start()
