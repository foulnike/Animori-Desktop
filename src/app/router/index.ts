// Пункт 3.2: свой маршрутизатор на хэше (страница живёт файлом); свой — на телевизоре нужен контроль над историей.
// Замена переписывает текущую запись истории — без неё плеер и карточка образовывали кольцо по «назад».
import { computed, ref, type ComputedRef } from 'vue'

import { DEFAULT_ROUTE, SCREEN_DEPTH, SCREEN_NAMES, type Route, type ScreenName } from './routes'

const state = ref<Route>(DEFAULT_ROUTE)

/** Направление смены экрана: `deep` — внутрь, `back` — наружу, `even` — вкладка. */
export type NavDirection = 'deep' | 'back' | 'even'

const direction = ref<NavDirection>('even')

/** Направление последнего перехода. Сменяется вместе с currentRoute. */
export const navDirection: ComputedRef<NavDirection> = computed(() => direction.value)

/** Адрес, с которого пришли на нынешний: по нему видно, куда ведёт «назад». */
let before: Route | null = null

/** Экраны, у которых второй кусок адреса — номер сущности. */
const SCREENS_WITH_ID: ReadonlyArray<ScreenName> = ['media', 'studio', 'player']

/** Как переходить: обычно или заменой текущей записи истории. */
export interface NavigateOptions {
  replace?: boolean
}

// Снаружи адрес только читают; менять его можно только через navigate.
export const currentRoute: ComputedRef<Route> = computed(() => state.value)

function isScreenName(value: string): value is ScreenName {
  return (SCREEN_NAMES as readonly string[]).includes(value)
}

// Неизвестный или битый адрес ведёт на главную: пустого экрана
// пользователь видеть не должен ни при каком содержимом строки.
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '')
  const parts = raw.split('/').filter((part) => part !== '')
  const head = parts[0] ?? ''
  if (!isScreenName(head)) return DEFAULT_ROUTE

  const params: Record<string, string> = {}
  const tail = parts[1]
  if (SCREENS_WITH_ID.includes(head) && tail !== undefined) {
    try {
      params.id = decodeURIComponent(tail)
    } catch {
      return DEFAULT_ROUTE
    }
  }
  return { name: head, params }
}

export function buildHash(name: ScreenName, params: Record<string, string> = {}): string {
  const id = params.id
  return id === undefined ? `#/${name}` : `#/${name}/${encodeURIComponent(id)}`
}

/** Адрес, с которого пришли: возврат историю не растит, а переход вперёд на пройденное растит (кольцо). */
export function peekPrevious(): Route | null {
  return before
}

/** Направление берётся из глубины экранов, а не истории: возврат из плеера и переход из поиска в карточку
 * противоположны; одна глубина даёт `even`. */
function step(from: ScreenName, to: ScreenName): NavDirection {
  const gap = SCREEN_DEPTH[to] - SCREEN_DEPTH[from]
  if (gap > 0) return 'deep'
  if (gap < 0) return 'back'
  return 'even'
}

/** Ставит адрес и запоминает прежний. Повтор того же адреса за переход не в счёт. */
function land(next: Route): void {
  const now = state.value
  if (next.name === now.name && next.params.id === now.params.id) return

  direction.value = step(now.name, next.name)
  before = now
  state.value = next
}

export function navigate(
  name: ScreenName,
  params: Record<string, string> = {},
  options: NavigateOptions = {},
): void {
  const next = buildHash(name, params)
  if (window.location.hash === next) return

  if (options.replace !== true) {
    window.location.hash = next
    return
  }

  // replaceState меняет строку адреса молча: hashchange он не поднимает,
  // и без своего вызова экран остался бы прежним при новом адресе.
  window.history.replaceState(null, '', next)
  land(parseHash(next))
}

// На телевизоре «Назад» будет жать сюда же, поэтому шаг назад один.
export function goBack(): void {
  window.history.back()
}

// Возвращает отключатель: без него горячая замена в разработке
// накопила бы по подписчику на каждую пересборку.
export function startRouter(): () => void {
  const apply = (): void => {
    land(parseHash(window.location.hash))
  }

  apply()
  window.addEventListener('hashchange', apply)
  return () => window.removeEventListener('hashchange', apply)
}
