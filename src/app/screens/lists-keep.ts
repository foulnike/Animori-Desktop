// Отбор списка живёт вне показа экрана: возврат с карточки собирает экран заново
// и сбрасывал бы закладку, порядок и слово поиска.
import { ref } from 'vue'

/** Порядки показа списка. */
export type SortName = 'updated' | 'score' | 'rating' | 'nameUp' | 'nameDown'

/** Вид показа (постеры, строки, строки с миниатюрой): выбор на сейчас, потому и рядом с закладкой. */
export type ViewName = 'tiles' | 'slim' | 'wide'

export const keptStatus = ref<string>('CURRENT')

export const keptSort = ref<SortName>('updated')

export const keptView = ref<ViewName>('tiles')

export const keptWord = ref('')
