// Общий слой окошка человека: ссылку может нажать описание тайтла или другого человека, а два окошка
// спорили бы за Escape. Своей истории здесь нет: переходы «человек → человек» живут внутри окошка.

import { shallowRef } from 'vue'

import type { PersonTarget } from '@/api/anilist-person'

/** Кто показан прямо сейчас. `null` — окошка нет. */
export const shownPerson = shallowRef<PersonTarget | null>(null)

/** Открывает окошко даже при уже открытом: окошко само положит прежнего в свою историю. */
export function openPerson(target: PersonTarget): void {
  shownPerson.value = target
}

/** Закрывает окошко. */
export function closePerson(): void {
  shownPerson.value = null
}
