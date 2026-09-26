// Выгрузка списка файлом. Путей два: (1) папка выбрана — пишем прямо в неё (диалог и запись живут в src-tauri/src/export.rs, разрешений на диалог разметке не выдано); (2) папки нет или среда её не умеет — прежняя загрузка окном, работает всегда, но куда ляжет файл, отсюда не видно.
// Место — app/, а не shared/core/: здесь Blob, URL и download, то есть DOM. Прежняя шапка ошибалась: новая команда в Rust потребовалась, а разрешение на диалог плагин дёргается только из Rust и права окна не меняет.

import { Bridge } from '@/bridge'
import { settings } from '@/core/settings'
import { Logger } from '@/utils/logger'

/** Сколько держать временный адрес живым: мгновенный отзыв обрывает загрузку. */
const KEEP_MS = 20000

/** Куда в итоге лёг файл. */
export interface SaveResult {
  /** Полный путь файла. Пустая строка, если файл ушёл загрузкой окна. */
  path: string
  /** true — записан в выбранную папку, false — отдан окну. */
  toFolder: boolean
}

/** Отдаёт текст файлом средствами окна: кодировка названа явно, иначе импортёры портят русские буквы;
 * отказ механизма после нажатия отсюда не виден — поэтому выше есть путь с папкой. */
function saveByWindow(name: string, text: string): void {
  let href = ''

  try {
    const blob = new Blob([text], { type: 'application/xml;charset=utf-8' })
    href = URL.createObjectURL(blob)

    const link = document.createElement('a')
    link.href = href
    link.download = name
    link.rel = 'noopener'
    link.style.display = 'none'

    // Ссылка вставляется в документ, а не жмётся в воздухе: часть движков
    // игнорирует нажатие на узле вне дерева.
    document.body.append(link)
    link.click()
    link.remove()

    Logger('DB', `Выгрузка отдана окну: ${name}, байт ${blob.size}`)
  } catch (e) {
    Logger('WARN', `Выгрузку не начать: ${String(e)}`)
    throw new Error('Окно не приняло файл. Подробности в журнале.')
  } finally {
    // Отзыв откладывается даже при ошибке ниже по тексту: адрес уже создан,
    // и без отзыва Blob остался бы в памяти до перезагрузки окна.
    if (href) window.setTimeout(() => URL.revokeObjectURL(href), KEEP_MS)
  }
}

/** Сохраняет выгрузку XML и говорит, куда легла; папка читается в момент вызова — копия устарела бы.
 * Отклоняется с внятным текстом: молчание после нажатия и было дефектом, из-за которого файл искали по диску. */
export async function saveXmlFile(name: string, text: string): Promise<SaveResult> {
  const dir = settings.exportDir.trim()

  if (Bridge.exportFile.available && dir) {
    const path = await Bridge.exportFile.write(dir, name, text)
    Logger('DB', `Выгрузка записана: ${path}, знаков ${text.length}`)
    return { path, toFolder: true }
  }

  saveByWindow(name, text)
  return { path: '', toFolder: false }
}
