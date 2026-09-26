// Реализация IProxyDiagnostics для десктопа. Вынесена из TauriBridge.ts ради размера.

import { invoke } from '@tauri-apps/api/core'

import type { IProxyDiagnostics, ProxyOutcome, ProxyProbe, ProxyStatus } from './IBridge'

/** Что отдаёт Rust (camelCase). Поля reachable в ответе нет: оно равно outcome === 'applied', а два источника правды разошлись бы. */
type RawProxyProbe = {
  outcome: ProxyOutcome
  server: string
  hasCredentials: boolean
  latencyMs: number
}

export const tauriProxyDiagnostics: IProxyDiagnostics = {
  /**
   * Исход применения прокси при запуске и состояние авторизации на сейчас.
   * Сетевой работы нет, вызов дешёвый.
   */
  async status(): Promise<ProxyStatus> {
    return await invoke<ProxyStatus>('animori_proxy_status')
  },

  /**
   * Живая проверка сохранённого адреса: до двух секунд, поэтому только по кнопке.
   */
  async probe(): Promise<ProxyProbe> {
    const raw = await invoke<RawProxyProbe>('animori_proxy_probe')

    return {
      outcome: raw.outcome,
      server: raw.server,
      reachable: raw.outcome === 'applied',
      latencyMs: raw.latencyMs,
    }
  },
}
