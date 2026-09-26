// Сборка реестра источников видео: имена живут здесь, ядро (core/video.ts) знает только форму.
// Порядок вызовов — порядок перебора на экране.

import { registerVideoSource } from '../core/video'
import { anilibertySource } from './aniliberty'
import { kodikSource } from './kodik'

/** Реестр общий на весь запуск, поэтому сборка идёт ровно один раз. */
let done = false

/** Складывает источники в реестр; зовётся перед первым обращением к плееру, повторный вызов ничего не ломает. */
export function setupVideoSources(): void {
  if (done) return

  registerVideoSource(anilibertySource)

  registerVideoSource({
    ...kodikSource,
    /** Вход только по номеру Шикимори: тайтл без номера службе не адресуем. */
    canAskPresence: (req) => req.shikimoriId !== null && req.shikimoriId > 0,
  })

  done = true
}
