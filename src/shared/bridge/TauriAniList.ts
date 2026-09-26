// Реализация IAniList для десктопа. Вынесена из TauriBridge.ts ради размера.

import { invoke } from '@tauri-apps/api/core'

import { BridgeHttpError, type HttpResponse, type IAniList } from './IBridge'

/** Адрес повторяет GRAPHQL_URL из anilist.rs: ответ его не несёт, а контракт требует. */
const GRAPHQL_URL = 'https://graphql.anilist.co'

/** Что отдаёт Rust. Ни statusText, ни адреса там нет: второе постоянно, а первое
 * в HTTP/2 не передаётся вовсе. */
type RawReply = {
  status: number
  headers: Record<string, string>
  text: string
}

/**
 * Вид сбоя из текста отказа: через invoke приходит только строка, и префиксы
 * её — единственный способ различить таймаут и сеть. Парное место — classify() в anilist.rs.
 */
function toBridgeError(error: unknown): Error {
  const text = typeof error === 'string' ? error : String(error)

  if (text.startsWith('timeout:')) {
    return new BridgeHttpError('timeout', GRAPHQL_URL, text)
  }

  if (text.startsWith('network:')) {
    return new BridgeHttpError('network', GRAPHQL_URL, text)
  }

  // Остальное — не транспорт: например, вход не выполнен. Повторять такое нечего.
  return new Error(text)
}

export const tauriAniList: IAniList = {
  /**
   * Запрос собирает оболочка: сюда идёт только тело и просьба подписать его.
   * Куки окна не участвуют вовсе — запрос идёт из Rust своим клиентом.
   */
  async query(body: string, useAuth: boolean): Promise<HttpResponse> {
    let raw: RawReply

    try {
      raw = await invoke<RawReply>('animori_anilist_query', { body, useAuth })
    } catch (e) {
      throw toBridgeError(e)
    }

    return {
      status: raw.status,
      statusText: '',
      ok: raw.status >= 200 && raw.status < 300,
      headers: raw.headers,
      text: raw.text,
      url: GRAPHQL_URL,
    }
  },
}
