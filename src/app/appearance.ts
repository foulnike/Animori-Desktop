// Выбор темы оформления. Тема живёт атрибутом data-am-skin на корне документа: фон окна и скроллбары
// задаются выше любого экрана. Подписи тем здесь, а не в labels.ts — там слова предметной области.
import { ref } from 'vue'

import { type AppearanceName, saveSetting, settings } from '@/core/settings'

interface AppearanceOption {
  name: AppearanceName
  title: string
  /** Знак для переключателя в шапке: три слова там шумели бы громче заголовка. */
  mark: string
  /** Подсказка под наведением. Обязательна: у необязательной у новой темы она молча пропадала бы. */
  hint: string
}

export const APPEARANCES: ReadonlyArray<AppearanceOption> = [
  { name: 'dark', title: 'Тёмная', mark: '◐', hint: 'Тёмная: обычный вид приложения' },
  { name: 'light', title: 'Светлая', mark: '☀', hint: 'Светлая: для дневного света' },
  { name: 'amoled', title: 'AMOLED', mark: '⬤', hint: 'AMOLED: чёрный фон, экономит заряд' },
]

/** Тема для разметки: читается переключателем и экраном настроек. */
export const appearance = ref<AppearanceName>(settings.appearance)

function applyAppearance(name: AppearanceName): void {
  document.documentElement.dataset.amSkin = name
}

/** Ставит сохранённую тему до первой отрисовки: смена фона на глазах читается поломкой. */
export function startAppearance(): void {
  appearance.value = settings.appearance
  applyAppearance(settings.appearance)
}

/** Меняет тему и запоминает выбор. Разметка перекрашивается сразу, не дожидаясь записи в хранилище. */
export function setAppearance(name: AppearanceName): void {
  appearance.value = name
  applyAppearance(name)
  void saveSetting('appearance', 'am_appearance', name)
}
