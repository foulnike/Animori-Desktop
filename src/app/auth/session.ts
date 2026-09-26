// Пункт 2.2: единственное место в разметке, которое знает про вызовы Rust; экраны видят только authStatus
// и пару функций. Самого токена здесь нет: он живёт в Rust (src-tauri/src/auth.rs), запросы к API идут оттуда же.

import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { computed, ref, type ComputedRef } from 'vue'

import { setShellSigned } from '@/api/anilist'

/// Форма ответа команд входа. Совпадает с AuthStatus в auth.rs.
export type AuthStatus = {
  authorized: boolean
  /// Секунды эпохи Unix. null — срок неизвестен.
  expiresAt: number | null
}

/// Ответ на начало входа. Совпадает с LoginStart в auth.rs. Адресов здесь нет:
/// окно с формой входа открывает сам Rust, и человеку нечего открывать руками.
export type LoginStart = {
  /// Сколько секунд приёмник ждёт пропуск.
  waitSecs: number
}

// Повторяет EVENT_CHANGED в auth.rs: два места расходиться не должны.
const EVENT_CHANGED = 'animori://auth-changed'

const state = ref<AuthStatus>({ authorized: false, expiresAt: null })

export const authStatus: ComputedRef<AuthStatus> = computed(() => state.value)

/// В браузере (npm run dev:app) моста нет, и вызов invoke упал бы с ошибкой
/// при первой же отрисовке настроек. Лучше сказать об этом вслух.
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/// Запоминает состояние и сообщает клиенту AniList: без этого общий код судил бы о входе по своему токену
/// в разметке, которого в настольном приложении нет, — список оставался бы пустым после входа.
function remember(status: AuthStatus): void {
  state.value = status
  setShellSigned(status.authorized)
}

/// Спросить состояние входа у Rust. Зовётся на старте приложения
/// и при каждом открытии настроек.
export async function refreshAuth(): Promise<void> {
  if (!isDesktop()) return
  remember(await invoke<AuthStatus>('animori_auth_status'))
}

/// Начать вход: Rust поднимает приёмник и открывает окно с формой входа
/// AniList. Токена в ответе нет и быть не может: об успехе сообщит событие.
export async function startLogin(): Promise<LoginStart> {
  return invoke<LoginStart>('animori_auth_start')
}

/// Запасной путь: токен, вставленный руками. Срок не передаётся: его нет
/// ни в токене, ни у человека перед глазами.
export async function submitToken(token: string): Promise<void> {
  remember(await invoke<AuthStatus>('animori_auth_submit', { token, expiresIn: null }))
}

/// Выйти из аккаунта.
export async function logout(): Promise<void> {
  remember(await invoke<AuthStatus>('animori_auth_logout'))
}

/// Подписка на событие входа. Возвращает отключатель — так же, как startRouter.
/// Вход случается в стороннем окне, и событие — единственный способ узнать об успехе сразу.
export async function watchAuth(): Promise<() => void> {
  if (!isDesktop()) return () => {}

  return listen<AuthStatus>(EVENT_CHANGED, (event) => {
    remember(event.payload)
  })
}
