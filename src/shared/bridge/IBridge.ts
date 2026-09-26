// Контракт платформы: ЧТО умеет среда, но не КАК; единственная реализация — TauriBridge.ts.
// Подсистемы: storage, files, exportFile, http, anilist, clipboard, shell, proxyDiagnostics — и только они.

// ==== storage ====

/**
 * Персистентное хранилище ключ-значение. Асинхронный всегда, включая браузер:
 * приводим к общему знаменателю по худшему случаю.
 */
export interface IStorage {
  /** Читает значение, подставляя `defaultValue`, если ключа нет. */
  get<T>(key: string, defaultValue: T): Promise<T>
  /** Читает значение без значения по умолчанию: `undefined`, если ключа нет. */
  get<T = unknown>(key: string): Promise<T | undefined>
  /**
   * Записывает значение. К моменту разрешения промиса оно обязано быть на диске,
   * а не в отложенной записи: иначе настройки теряются при перезагрузке (дефект 4.5).
   */
  set(key: string, value: unknown): Promise<void>
  /**
   * Дожидается всех записей, начатых до вызова: set() почти никто не ждёт,
   * а перезагрузка страницы обгоняет их. Не отклоняется.
   */
  flush(): Promise<void>
}

// ==== files ====

/**
 * Свои файлы в приватном каталоге: второй экземпляр снимка на случай чистки хранилища (п. 2.5.2).
 * Имя, а не путь: каталог выбирает реализация, набор имён ограничен оболочкой.
 */
export interface IFiles {
  /**
   * Есть ли в этой среде файлы вообще. В браузере false, и вызывающий может
   * не заводить лишних записей в журнале на каждый снимок.
   */
  readonly available: boolean
  /**
   * Читает файл целиком. Нет файла, нет файлов в среде, не читается — везде null:
   * дубль страховка, и разница между этими случаями вызывающему бесполезна.
   */
  read(name: string): Promise<string | null>
  /**
   * Пишет файл целиком и возвращает, удалось ли. Не отклоняется: запасная
   * копия не вправе ронять сохранение снимка в основное хранилище.
   */
  write(name: string, text: string): Promise<boolean>
}

// ==== выгрузка ====

/**
 * Выгрузка списка и сохранение трека в папку, выбранную человеком (п. 3.3). Отдельно от IFiles:
 * там служебный каталог оболочки. Окно выбора открывает оболочка: разрешения на диалог разметке нет.
 */
export interface IExport {
  /**
   * Умеет ли среда спрашивать папку и писать в неё. В браузере false:
   * там выгрузка остаётся обычной загрузкой файла окном.
   */
  readonly available: boolean
  /** Спрашивает папку и возвращает её полный путь; null — человек закрыл окно, это отмена, а не ошибка. */
  pickDir(): Promise<string | null>
  /**
   * Пишет текст файлом `name` (только .xml) в `dir`, возвращает полный путь для показа человеку.
   * Отклоняется с внятным текстом: выгрузку затеял человек и ждёт ответа, в отличие от IFiles.write.
   */
  write(dir: string, name: string, text: string): Promise<string>
  /**
   * Спрашивает папку для трека, ответ не запоминается: спрашивать каждый раз — требование.
   * Отдельно от pickDir ради заголовка окна; null читается так же — отмена.
   */
  pickTrackDir(): Promise<string | null>
  /**
   * Пишет звуковой файл `name` в `dir`, возвращает полный путь; тело в base64 — канал строковый.
   * Расширения и предел размера держит оболочка. Отклоняется с внятным текстом.
   */
  writeTrack(dir: string, name: string, bytesBase64: string): Promise<string>
}

// ==== http ====

export type HttpMethod = 'GET' | 'POST' | 'HEAD' | 'PUT' | 'DELETE' | 'PATCH'

export interface HttpRequestOptions {
  /** По умолчанию 'GET'. */
  method?: HttpMethod
  /** Абсолютный адрес. Относительные пути не поддерживаются: в Tauri нет origin. */
  url: string
  headers?: Record<string, string>
  /** Тело запроса. Сериализацию выполняет вызывающий код. */
  body?: string
  /** Таймаут в миллисекундах на весь запрос. */
  timeoutMs?: number
  /** Отправлять ли куки сессии. Пока обещание пустое: запрос выполняет Rust, куки WebView ему не видны. */
  credentials?: 'omit' | 'include'
}

export interface HttpResponse {
  /** HTTP-код ответа. */
  status: number
  statusText: string
  /** true для 200-299. Ровно то же, что у fetch. */
  ok: boolean
  /** Заголовки ответа. Ключи приведены к нижнему регистру обеими реализациями. */
  headers: Record<string, string>
  /** Тело ответа текстом. Разбор JSON — на стороне вызывающего. */
  text: string
  /** Итоговый адрес после редиректов. */
  url: string
}

/**
 * Ответ с бинарным телом: gzip датасета текстовый канал не переживает.
 * Байты идут в base64 — единственный безпотерьный вид для строки IPC.
 */
export interface HttpBytesResponse {
  /** HTTP-код ответа. */
  status: number
  statusText: string
  /** true для 200-299. Ровно то же, что у fetch. */
  ok: boolean
  /** Заголовки ответа. Ключи приведены к нижнему регистру обеими реализациями. */
  headers: Record<string, string>
  /** Тело ответа байтами, записанными в base64. */
  bytesBase64: string
  /** Итоговый адрес после редиректов. */
  url: string
}

/** Причина транспортного сбоя. Код ответа сюда не относится. */
export type HttpErrorKind = 'network' | 'timeout' | 'abort'

/** Единый тип ошибки транспорта для всех платформ. */
export class BridgeHttpError extends Error {
  readonly kind: HttpErrorKind
  readonly url: string

  constructor(kind: HttpErrorKind, url: string, message?: string) {
    super(message ?? `Bridge HTTP ${kind} error: ${url}`)
    this.name = 'BridgeHttpError'
    this.kind = kind
    this.url = url
  }
}

export interface IHttp {
  /**
   * Выполняет запрос. Код вне 2xx исключением не является: 404 и 429 разбирает клиент.
   * Отклонение — только BridgeHttpError; невыполнимый credentials пишется в журнал.
   */
  request(options: HttpRequestOptions): Promise<HttpResponse>
  /** То же, что request, но тело байтами в base64: сжатые файлы и звук текстом не принять. */
  requestBytes(options: HttpRequestOptions): Promise<HttpBytesResponse>
}

// ==== anilist ====

/**
 * Запросы к AniList GraphQL. Отдельно от http потому, что адрес и пропуск
 * живут внутри реализации: в десктопе пропуск в разметку не попадает вовсе.
 */
export interface IAniList {
  /**
   * Отправляет готовое тело и возвращает ответ как есть: код вне 2xx разбирает клиент в api/anilist.ts.
   * `useAuth` — подписать пропуском текущего входа; сам пропуск вызывающему не передаётся.
   */
  query(body: string, useAuth: boolean): Promise<HttpResponse>
}

// ==== clipboard ====

export interface IClipboard {
  /** Кладёт текст в буфер обмена. */
  writeText(text: string): Promise<void>
}

// ==== shell ====

/**
 * Операции над самим окном. Сюда идёт только то, что WebView не умеет сам
 * или что в десктопе отказывает без участия оболочки.
 */
export interface IShell {
  /**
   * Перезагружает страницу. Промис разрешается после отправки команды:
   * на код после await полагаться нельзя, всё важное ждём ДО вызова.
   */
  reload(): Promise<void>
  /**
   * Перезапускает приложение целиком: ключи запуска WebView2 читаются один раз, при создании окна.
   * Ответа нет: процесс уходит целиком, обещание разрешается сразу после отправки команды.
   */
  restart(): Promise<void>
  /**
   * Открывает адрес в браузере пользователя: в WebView2 target="_blank" молча
   * отбрасывается. Только http и https; внутренние переходы сюда не идут.
   */
  openExternal(url: string): Promise<void>
  /**
   * Шаг назад по истории окна: тулбара и акселераторов у окна нет; идти некуда — ничего не делает.
   * Кнопка «Назад» в рамке ходит в свой роутер, не сюда.
   */
  back(): Promise<void>
  /** Шаг вперёд по истории. Всё сказанное про back() верно и здесь. */
  forward(): Promise<void>
  /** Переключает полный экран и возвращает НОВОЕ состояние; в браузере всегда false. */
  toggleFullscreen(): Promise<boolean>
  /**
   * Открывает системный выбор приёмника трансляции: своей трансляции нет, зеркалит сама Windows.
   * Исход выбора система не сообщает — отказ только когда панель не открылась вовсе.
   */
  castPanel(): Promise<void>
}

// ==== proxy diagnostics ====

/**
 * Чем закончилась попытка применить прокси к окну; `applied` не обещает, что трафик ходит.
 * `windowUnsupported` — адрес отвечает, но передать его окну на этой платформе нечем.
 */
export type ProxyOutcome = 'off' | 'invalid' | 'unreachable' | 'windowUnsupported' | 'applied'

/**
 * Как окно живёт с авторизацией у прокси. `accepted` косвенный: кода ошибки
 * в событии нет, и принятие видно лишь по отсутствию повторного запроса.
 */
export type ProxyAuth = 'none' | 'pending' | 'accepted' | 'rejected'

/** Что случилось с прокси при запуске приложения плюс живой исход авторизации. */
export interface ProxyStatus {
  outcome: ProxyOutcome
  /** Адрес вида `http://127.0.0.1:8080`. Пустая строка, если выключен или негоден. */
  server: string
  /** Задан ли логин. Сам логин и пароль сюда НЕ попадают. */
  hasCredentials: boolean
  /** Собирается на момент вызова: авторизация случается позже снимка запуска. */
  auth: ProxyAuth
}

/** Результат ручной проверки адреса, сохранённого в настройках ПРЯМО СЕЙЧАС. */
export interface ProxyProbe {
  /** Здесь `applied` читается как «адрес годен и отвечает». */
  outcome: ProxyOutcome
  server: string
  reachable: boolean
  /** Сколько миллисекунд заняло соединение. При отказе — время до отказа. */
  latencyMs: number
}

/**
 * Состояние прокси. Живёт в мосту, а не в карточке настроек: invoke по инварианту 1
 * допустим только здесь. В браузерной сборке честно отвечает `off`.
 */
export interface IProxyDiagnostics {
  /**
   * Чем закончилось применение прокси при запуске. Неизменно всё, кроме `auth`:
   * адрес движок читает один раз, а авторизация меняется по ходу сеанса.
   */
  status(): Promise<ProxyStatus>
  /**
   * Проверяет СОХРАНЁННЫЙ адрес соединением — то, что заработает после перезапуска.
   * Недоступный прокси — не ошибка, а результат с reachable: false.
   */
  probe(): Promise<ProxyProbe>
}

// ==== корневой контракт ====

export interface IBridge {
  /**
   * Идентификатор среды для журнала и текстов. Со сборочным __ANIMORI_PLATFORM__ словари разные:
   * там цель сборки ('app'), здесь — оболочка окна.
   */
  readonly platform: 'tauri'
  readonly storage: IStorage
  /** Пункт 2.5.2: запасная копия снимка файлом. В браузере честная заглушка. */
  readonly files: IFiles
  /**
   * П. 3.3: выгрузка списка и сохранение трека в папку, выбранную человеком.
   * File в имени, а не просто export: короткое слово путалось бы с экспортом модуля.
   */
  readonly exportFile: IExport
  readonly http: IHttp
  /** Пункт 2.3: запросы к AniList. В десктопе идут из Rust вместе с пропуском. */
  readonly anilist: IAniList
  readonly clipboard: IClipboard
  readonly shell: IShell
  readonly proxyDiagnostics: IProxyDiagnostics
}
