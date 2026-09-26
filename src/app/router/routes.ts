// Пункт 3.2: список экранов и их подписи — один источник правды.
// Новый экран = имя здесь, подпись в SCREEN_TITLES, компонент в App.vue; меню — четвёртое, необязательное.

export const SCREEN_NAMES = [
  'home',
  'lists',
  'history',
  'search',
  'media',
  'studio',
  'player',
  'settings',
  'log',
] as const

export type ScreenName = (typeof SCREEN_NAMES)[number]

export type Route = {
  name: ScreenName
  params: Record<string, string>
}

export const DEFAULT_ROUTE: Route = { name: 'home', params: {} }

export type MenuItem = {
  name: ScreenName
  title: string
  icon: string
}

// В меню нет карточек, студий, плеера и журнала — у них свои входы. История рядом со списками: список — планы,
// история — просмотренное. Подписи от имён раздельны: имя 'lists' в адресе и памяти отбора не меняется.
export const MENU: ReadonlyArray<MenuItem> = [
  { name: 'home', title: 'Главная', icon: '⌂' },
  { name: 'lists', title: 'Моё', icon: '≡' },
  { name: 'history', title: 'История', icon: '◷' },
  { name: 'search', title: 'Поиск', icon: '⌕' },
  { name: 'settings', title: 'Настройки', icon: '⚙' },
]

/** Глубина экрана: по ней смена получает направление (navDirection). Вкладки вровень, карточка глубже,
 * студия и плеер глубже карточки; журнал глубже вкладок — вход из настроек это шаг внутрь. */
export const SCREEN_DEPTH: Record<ScreenName, number> = {
  home: 0,
  lists: 0,
  history: 0,
  search: 0,
  settings: 0,
  log: 1,
  media: 1,
  studio: 2,
  player: 2,
}

export const SCREEN_TITLES: Record<ScreenName, string> = {
  home: 'Главная',
  lists: 'Моё',
  history: 'История',
  search: 'Поиск',
  media: 'Аниме',
  studio: 'Студия',
  player: 'Просмотр',
  settings: 'Настройки',
  log: 'Журнал',
}
