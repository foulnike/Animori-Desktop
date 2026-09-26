// Единственная точка входа к мосту: код вне src/bridge импортирует только '@/bridge'. Напрямую
// нельзя: иначе шов моста расползётся по коду, а он должен быть один.

export {
  BridgeHttpError,
  type HttpBytesResponse,
  type HttpErrorKind,
  type HttpMethod,
  type HttpRequestOptions,
  type HttpResponse,
  type IAniList,
  type IBridge,
  type IClipboard,
  type IHttp,
  type IProxyDiagnostics,
  type IShell,
  type IStorage,
  type ProxyOutcome,
  type ProxyProbe,
  type ProxyStatus,
} from './IBridge'

/** Мост к платформе: хранилище, свои файлы, выгрузка списка в выбранную папку, сеть, запросы к
 * AniList, буфер обмена, окно и диагностика прокси. */
export { platformBridge as Bridge } from '@bridge-impl'
