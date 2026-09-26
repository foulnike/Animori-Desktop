// IBridge для десктопной оболочки Tauri. Единственная реализация: псевдопуть '@bridge-impl' из
// vite.config.ts ведёт сюда.

import { invoke } from '@tauri-apps/api/core'
import { writeText } from '@tauri-apps/plugin-clipboard-manager'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { LazyStore } from '@tauri-apps/plugin-store'

import {
  DEFAULT_PROXY,
  PROXY_KEYS,
  normalizeProxyKind,
  proxyBypassList,
  proxyUrl,
  type ProxyConfig,
} from '@/core/proxy'

import {
  BridgeHttpError,
  type HttpBytesResponse,
  type HttpRequestOptions,
  type HttpResponse,
  type IBridge,
  type IClipboard,
  type IExport,
  type IFiles,
  type IHttp,
  type IShell,
  type IStorage,
} from './IBridge'
import { tauriAniList } from './TauriAniList'
import { tauriProxyDiagnostics } from './TauriProxyDiagnostics'

// ==== storage ====

// LazyStore не требует await при создании. autoSave — только сетка безопасности:
// он пишет файл уже после разрешения set(), это дефект 4.5.
const store = new LazyStore('animori-settings.json', { autoSave: true })

/** Снимок файла настроек в памяти: один entries() вместо трёх десятков get() на старте. */
let snapshot: Map<string, unknown> | null = null

/** Незавершённая загрузка снимка: параллельные чтения не дёргают entries() повторно. */
let snapshotLoading: Promise<Map<string, unknown> | null> | null = null

async function loadSnapshot(): Promise<Map<string, unknown> | null> {
  if (snapshot) return snapshot
  if (snapshotLoading) return snapshotLoading

  snapshotLoading = (async () => {
    try {
      const entries = await store.entries()
      snapshot = new Map(entries)
      return snapshot
    } catch (e) {
      // Падать незачем: ниже есть путь через store.get() по одному ключу.
      console.error('[AniMori] Не удалось прочитать файл настроек целиком', e)
      return null
    } finally {
      snapshotLoading = null
    }
  })()

  return snapshotLoading
}

/** Незавершённые записи: вызывающие set() его не ждут, а flush() обязан их дождаться. */
const pendingWrites = new Set<Promise<void>>()

/** Предел проходов flush(): без него непрерывный поток set() держит ожидание вечно. */
const FLUSH_MAX_ROUNDS = 5

// Перегрузки объявлены функцией: объектный литерал перегруженный метод не реализует.
async function storageGet<T>(key: string, defaultValue: T): Promise<T>
async function storageGet<T = unknown>(key: string): Promise<T | undefined>
async function storageGet<T>(key: string, defaultValue?: T): Promise<T | undefined> {
  const hasDefault = arguments.length >= 2

  const cache = await loadSnapshot()
  const value = cache ? (cache.get(key) as T | undefined) : await store.get<T>(key)

  // store.get дефолт не принимает — подставляем сами.
  if (value === undefined && hasDefault) return defaultValue as T
  return value
}

/** Запись значения и немедленная выгрузка файла на диск. */
async function writeValue(key: string, value: unknown): Promise<void> {
  // Снимок правится сразу: чтение сразу после set() обязано видеть новое значение.
  if (snapshot) snapshot.set(key, value)

  await store.set(key, value)
  // Явный save(): контракт IStorage.set требует долговечности к моменту разрешения.
  await store.save()
}

const tauriStorage: IStorage = {
  get: storageGet,

  set(key: string, value: unknown): Promise<void> {
    const write = writeValue(key, value)

    // В реестр идёт ветвь без отклонения: flush() не должен падать из-за чужой ошибки.
    const tracked = write.catch(() => undefined)
    pendingWrites.add(tracked)
    void tracked.then(() => {
      pendingWrites.delete(tracked)
    })

    return write
  },

  async flush(): Promise<void> {
    // Несколько проходов: пока ждём партию, могли прийти новые записи.
    for (let round = 0; round < FLUSH_MAX_ROUNDS; round++) {
      if (pendingWrites.size === 0) return
      await Promise.all([...pendingWrites])
    }
  },
}

// ==== files ====

/**
 * Запасная копия снимка файлом в приватном каталоге (пункт 2.5.2); каталог и имена — в files.rs.
 * Отказ не отклоняется: дубль — страховка и портить сохранение в основное хранилище не должен.
 */
const tauriFiles: IFiles = {
  available: true,

  async read(name: string): Promise<string | null> {
    try {
      const text = await invoke<string | null>('animori_file_read', { name })
      return text ?? null
    } catch (e) {
      console.error('[AniMori] Не удалось прочитать файл приложения', name, e)
      return null
    }
  },

  async write(name: string, text: string): Promise<boolean> {
    try {
      await invoke('animori_file_write', { name, text })
      return true
    } catch (e) {
      console.error('[AniMori] Не удалось записать файл приложения', name, e)
      return false
    }
  },
}

// ==== выгрузка ====

/**
 * Выгрузка в папку человека (пункт 3.3) и сохранение трека; окно выбора открывает Rust (export.rs).
 * Отказы не глотаются, в отличие от tauriFiles: выгрузку человек затеял руками и ждёт ответа.
 */
const tauriExport: IExport = {
  available: true,

  async pickDir(): Promise<string | null> {
    // null — человек закрыл окно выбора. Это не ошибка и наверх идёт как есть.
    const picked = await invoke<string | null>('animori_export_pick_dir')
    return picked ?? null
  },

  async write(dir: string, name: string, text: string): Promise<string> {
    // Ответ команды — полный путь записанного файла, его и отдаём.
    return await invoke<string>('animori_export_write', { dir, name, text })
  },

  async pickTrackDir(): Promise<string | null> {
    // Своя команда, а не animori_export_pick_dir: разница в заголовке окна выбора.
    // Выбранная папка никуда не записывается: спрашиваем каждый раз.
    const picked = await invoke<string | null>('animori_track_pick_dir')
    return picked ?? null
  },

  async writeTrack(dir: string, name: string, bytesBase64: string): Promise<string> {
    // Ключ именно bytes: в export.rs параметр назван одним словом, иначе
    // пришлось бы помнить про перевод camelCase в snake_case на стороне Tauri.
    return await invoke<string>('animori_track_write', { dir, name, bytes: bytesBase64 })
  },
}

// ==== прокси ====

/**
 * Прокси нашего канала — запросов из процесса оболочки; страницу в WebView2 настраивает proxy.rs.
 * Запросы к AniList сюда не идут: им прокси собирает anilist.rs из тех же ключей.
 */
type TauriFetchOptions = NonNullable<Parameters<typeof tauriFetch>[1]>
type TauriProxyOption = TauriFetchOptions['proxy']

/** Ответ плагина: тип выведен, чтобы не гадать с именем экспорта. */
type TauriResponse = Awaited<ReturnType<typeof tauriFetch>>

/**
 * Подпись последней настройки, о негодности которой уже сказано в журнал; пароля в ней нет.
 * Живёт в памяти до конца сеанса, чтобы не повторять одно и то же на каждый запрос.
 */
let warnedBadProxy = ''

/** Один раз на настройку: включённый тумблер с пустым адресом — трафик напрямую. */
function warnBadProxy(config: ProxyConfig): void {
  const mark = `${config.kind}|${config.host}|${config.port}`
  if (mark === warnedBadProxy) return

  warnedBadProxy = mark
  console.warn('[AniMori] Прокси включён, но адрес или порт заданы неверно — запросы идут напрямую')
}

/**
 * Прокси для одного запроса: читается каждый раз, а не однажды за сеанс — иначе смена адреса не
 * доходила бы до перезапуска. Цены нет: значения берутся из снимка настроек в памяти.
 */
async function readProxyOption(): Promise<TauriProxyOption> {
  try {
    const [enabled, kind, host, port, login, password, bypass] = await Promise.all([
      storageGet(PROXY_KEYS.enabled, DEFAULT_PROXY.enabled),
      storageGet(PROXY_KEYS.kind, DEFAULT_PROXY.kind),
      storageGet(PROXY_KEYS.host, DEFAULT_PROXY.host),
      storageGet(PROXY_KEYS.port, DEFAULT_PROXY.port),
      storageGet(PROXY_KEYS.login, DEFAULT_PROXY.login),
      storageGet(PROXY_KEYS.password, DEFAULT_PROXY.password),
      storageGet(PROXY_KEYS.bypass, DEFAULT_PROXY.bypass),
    ])

    const config: ProxyConfig = {
      // Строго true, как matches!(…, Bool(true)) в proxy.rs: «да» строкой
      // движок за включение не считает, и мост обязан судить так же.
      enabled: enabled === true,
      kind: normalizeProxyKind(kind),
      host: String(host ?? ''),
      port,
      login: String(login ?? ''),
      password: String(password ?? ''),
      bypass: String(bypass ?? ''),
    }

    const url = proxyUrl(config)

    if (!url) {
      // Инвариант 4: иначе включённый тумблер врёт, а трафик идёт напрямую.
      if (config.enabled) warnBadProxy(config)
      return undefined
    }

    const noProxy = proxyBypassList(config).join(',')
    const trimmedLogin = config.login.trim()

    return {
      all: {
        url,
        // Отдельно от адреса: пароль с ':' или '@' сломал бы склейку user:pass@host.
        ...(trimmedLogin
          ? { basicAuth: { username: trimmedLogin, password: config.password } }
          : {}),
        ...(noProxy ? { noProxy } : {}),
      },
    }
  } catch (e) {
    console.error('[AniMori] Не удалось прочитать настройки прокси, запрос идёт напрямую', e)
    return undefined
  }
}

// ==== http ====

/** Без своего представления reqwest подписывается собой: 403 у AnimeThemes, 5.3.5. */
const DEFAULT_USER_AGENT = `AniMori/${__ANIMORI_VERSION__} (+https://github.com/foulnike/Animori-Desktop)`

/**
 * Общая часть обоих запросов: прокси, таймаут на весь запрос и разбор
 * транспортных сбоев. Коды вне 2xx не трогаем: их разбирает вызывающий.
 */
async function sendRequest(options: HttpRequestOptions): Promise<TauriResponse> {
  const { url, method = 'GET', headers, body, timeoutMs, credentials = 'include' } = options

  // До таймера: первое чтение идёт в оболочку и съело бы таймаут запроса.
  const proxy = await readProxyOption()

  // connectTimeout покрывает только установку соединения, нужен таймаут на весь запрос.
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined

  if (timeoutMs !== undefined) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
  }

  try {
    return await tauriFetch(url, {
      method,
      // Свой заголовок под заголовками вызывающего: клиент вправе его перебить.
      headers: { 'User-Agent': DEFAULT_USER_AGENT, ...headers },
      body,
      credentials,
      signal: controller.signal,
      // Ключ только при настроенном прокси: пустой proxy путает разбор сбоев.
      ...(proxy ? { proxy } : {}),
    })
  } catch (e) {
    // Сюда приходят только транспортные сбои; мёртвый прокси от них неотличим.
    if (timedOut) throw new BridgeHttpError('timeout', url)

    const name = e instanceof Error ? e.name : ''
    if (name === 'AbortError') throw new BridgeHttpError('abort', url)

    // BridgeHttpError несёт только вид сбоя — «проверьте сеть»; в консоль идёт строка с ошибкой:
    // адрес не в capabilities/default.json: «url not allowed on the configured scope».
    console.error('[AniMori] Запрос не ушёл', url, e)

    throw new BridgeHttpError('network', url)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** Заголовки ответа в словарь. Headers сам приводит имена к нижнему регистру. */
function readHeaders(res: TauriResponse): Record<string, string> {
  const responseHeaders: Record<string, string> = {}
  res.headers.forEach((value, name) => {
    responseHeaders[name.toLowerCase()] = value
  })
  return responseHeaders
}

/** Байты в base64 кусками: одним spread на всём массиве роняется стек. */
function toBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let out = ''
  for (let at = 0; at < bytes.length; at += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(at, at + CHUNK))
  }
  return btoa(out)
}

const tauriHttp: IHttp = {
  async request(options: HttpRequestOptions): Promise<HttpResponse> {
    const res = await sendRequest(options)
    const text = await res.text()

    return {
      status: res.status,
      statusText: res.statusText,
      ok: res.status >= 200 && res.status < 300,
      headers: readHeaders(res),
      text,
      url: res.url || options.url,
    }
  },

  async requestBytes(options: HttpRequestOptions): Promise<HttpBytesResponse> {
    const res = await sendRequest(options)
    const buffer = await res.arrayBuffer()

    return {
      status: res.status,
      statusText: res.statusText,
      ok: res.status >= 200 && res.status < 300,
      headers: readHeaders(res),
      bytesBase64: toBase64(new Uint8Array(buffer)),
      url: res.url || options.url,
    }
  },
}

// ==== clipboard ====

const tauriClipboard: IClipboard = {
  async writeText(text: string): Promise<void> {
    // Без фоллбэка: отказ означает невыданное разрешение, это надо видеть.
    await writeText(text)
  },
}

// ==== shell ====

/**
 * Оболочка: свои команды из lib.rs плюс история WebView; они требуют разрешений (build.rs и
 * capabilities). Перезагрузка, внешние ссылки, полный экран и трансляция — только командами.
 */
const tauriShell: IShell = {
  async reload(): Promise<void> {
    await invoke('animori_reload')
  },

  restart(): Promise<void> {
    // Ответа не будет: команда уводит процесс целиком, и обещание invoke не разрешится никогда —
    // отдаём управление сразу. Отказ не глотается: невыданное разрешение или нет команды.
    void invoke('animori_restart').catch((e) => {
      console.error('[AniMori] Перезапуск не удался', e)
    })

    return Promise.resolve()
  },

  async openExternal(url: string): Promise<void> {
    // Проверка схемы на стороне Rust: разметка вправе позвать это с любым адресом.
    await invoke('animori_open_external', { url })
  },

  back(): Promise<void> {
    // Через историю WebView: шаг по истории окна, а не по своему стеку экранов.
    history.back()
    return Promise.resolve()
  },

  forward(): Promise<void> {
    history.forward()
    return Promise.resolve()
  },

  async toggleFullscreen(): Promise<boolean> {
    // Ответ команды — состояние ПОСЛЕ переключения, его и отдаём как есть.
    return await invoke<boolean>('animori_toggle_fullscreen')
  },

  async castPanel(): Promise<void> {
    // Своя команда, а не animori_open_external: там разрешены только http и https, а панель
    // системы живёт по своей схеме. Ответа нет намеренно: какая панель открылась, знает Rust.
    await invoke('animori_cast_panel')
  },
}

// ==== сборка ====

export const tauriBridge: IBridge = {
  platform: 'tauri',
  storage: tauriStorage,
  files: tauriFiles,
  // Реализация выше: чужая папка и окно выбора, отдельно от служебных files.
  exportFile: tauriExport,
  http: tauriHttp,
  // Реализация в TauriAniList.ts: запрос собирает Rust вместе с пропуском.
  anilist: tauriAniList,
  clipboard: tauriClipboard,
  shell: tauriShell,
  // Реализация в TauriProxyDiagnostics.ts.
  proxyDiagnostics: tauriProxyDiagnostics,
}

// Имя экспорта, которого ждёт '@bridge-impl'. Общее для любой реализации.
export { tauriBridge as platformBridge }
