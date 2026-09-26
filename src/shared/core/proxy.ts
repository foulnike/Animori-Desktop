// Прокси для WebView2, только десктоп: чистый модуль — его тянет и приложение, и мост.
// Ключи нельзя держать в core/settings.ts (импорт '@/bridge' замкнул бы цикл); нужен перезапуск.

export type ProxyKind = 'http' | 'socks5'

export interface ProxyConfig {
  enabled: boolean
  kind: ProxyKind
  host: string
  port: number
  login: string
  /**
   * Хранится В ОТКРЫТОМ ВИДЕ в animori-settings.json: панель настроек обязана предупредить.
   */
  password: string
  /**
   * Адреса в обход прокси; разделитель — запятая, точка с запятой или перевод строки.
   */
  bypass: string
}

/** Ключи хранилища. Единственное место, где они объявлены: их читают и мост, и панель. */
export const PROXY_KEYS = {
  enabled: 'set_proxy_on',
  kind: 'set_proxy_kind',
  host: 'set_proxy_host',
  port: 'set_proxy_port',
  login: 'set_proxy_login',
  password: 'set_proxy_pass',
  bypass: 'set_proxy_bypass',
} as const

/**
 * Значения по умолчанию; порт не подстраивается под тип сознательно — петля в исключениях с самого начала.
 */
export const DEFAULT_PROXY: ProxyConfig = {
  enabled: false,
  kind: 'http',
  host: '',
  port: 8080,
  login: '',
  password: '',
  bypass: 'localhost, 127.0.0.1',
}

/**
 * Приводит прочитанное к известному типу: неизвестное значение — http, а не ошибка.
 */
export function normalizeProxyKind(value: unknown): ProxyKind {
  return value === 'socks5' ? 'socks5' : 'http'
}

/**
 * Порт целым в допустимом диапазоне; ноль значит «значения нет», строка — ввод из панели.
 */
export function normalizeProxyPort(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) return 0
  return parsed
}

/** Пригодна ли настройка к применению: включена, адрес задан, порт осмыслен. */
export function isProxyUsable(config: ProxyConfig): boolean {
  return config.enabled && config.host.trim().length > 0 && normalizeProxyPort(config.port) !== 0
}

/**
 * Адрес одной строкой, без учётных данных: они уходят через basicAuth в TauriBridge.
 */
export function proxyUrl(config: ProxyConfig): string | null {
  if (!isProxyUsable(config)) return null

  const scheme = config.kind === 'socks5' ? 'socks5' : 'http'
  return `${scheme}://${config.host.trim()}:${normalizeProxyPort(config.port)}`
}

/** Список исключений в виде отдельных записей, без пустых. */
export function proxyBypassList(config: ProxyConfig): string[] {
  return config.bypass
    .split(/[,;\n]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}
