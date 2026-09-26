// Общий слой источников видео: наружу одно и то же — озвучки, эпизоды, дорожки и срок ссылок.
// Сети здесь нет: типы, реестр и проверка срока; резолверы живут в api/ и кладутся в реестр там же.

import { Logger } from '../utils/logger'

/** Имя источника: ключ реестра, подпись в журнале и значение в настройках. */
export type VideoSourceId = 'aniliberty' | 'kodik'

/** Одно качество одного эпизода. */
export interface VideoTrack {
  /** Высота кадра: 480, 720, 1080. И ключ выбора, и подпись кнопки. */
  height: number
  /** Прямой адрес манифеста HLS. */
  url: string
}

/** Отрезок, который человек вправе пропустить одним нажатием. */
export interface VideoSkip {
  startSec: number
  stopSec: number
}

/** Эпизод в том виде, в каком его знает источник. */
export interface VideoEpisode {
  /** Номер эпизода у источника. Нумерация чужая: бывают дубли и пропуски. */
  number: number
  title?: string
  durationSec?: number
  /** Заставка и титры, если источник их знает. Кнопку пропуска рисует экран. */
  opening?: VideoSkip
  ending?: VideoSkip
}

/** Озвучка: у Aniliberty она одна, у Kodik их пять и больше. */
export interface VideoVoice {
  /** Ключ источника, а не наш: он же уедет обратно в listEpisodes и resolve. */
  id: string
  label: string
  /** Сколько серий озвучено. Ноль читается как «источник не сказал». */
  episodes: number
}

/** Готовый к воспроизведению эпизод. */
export interface VideoStream {
  source: VideoSourceId
  /** Дорожки по убыванию высоты кадра. Пустым список не бывает. */
  tracks: VideoTrack[]
  /** С какой дорожки начинать. Всегда одна из tracks. */
  preferred: VideoTrack
  /** Момент протухания адресов (мс эпохи) или null — источник срока не сообщает. */
  expiresAt: number | null
}

/**
 * Что известно о тайтле до обращения к источнику: номера идут все сразу — Kodik входит по номеру Шикимори,
 * у Aniliberty чужих номеров нет и остаются названия.
 */
export interface VideoRequest {
  anilistId: number
  malId: number | null
  shikimoriId: number | null
  /** Названия по убыванию пригодности для поиска: романдзи, английское, русское. */
  titles: string[]
  year?: number
  episodesTotal?: number
}

/**
 * Есть ли вход к тайтлу (ключ — anilistId); ключа нет — источник не высказался: «не знаю», а не «нет».
 */
export type PresenceMap = Map<number, boolean>

/**
 * Цена вопроса о наличии: 'batch' — один запрос на пачку, 'each' — по запросу на тайтл.
 */
export type PresenceCost = 'batch' | 'each'

/** Источник видео: три шага раздельны — озвучки, эпизоды, ссылки (в кэш не кладутся, у Kodik живут часы). */
export interface VideoSource {
  readonly id: VideoSourceId
  readonly label: string
  /** Пустой список означает честное «этого тайтла у источника нет». */
  listVoices(req: VideoRequest): Promise<VideoVoice[]>
  listEpisodes(req: VideoRequest, voiceId: string): Promise<VideoEpisode[]>
  /** null — эпизода нет или цепочка не прошла. Причину в журнал пишет резолвер. */
  resolve(req: VideoRequest, voiceId: string, episode: number): Promise<VideoStream | null>

  /**
   * Дешёвый ответ «есть ли вход» пачкой — нужен метке доступности; объявлен — обязан быть presenceCost.
   */
  askPresence?(reqs: readonly VideoRequest[]): Promise<PresenceMap>
  readonly presenceCost?: PresenceCost

  /**
   * Можно ли задать вопрос об этом тайтле (Kodik — по номеру Шикимори, Aniliberty — по названию).
   */
  canAskPresence?(req: VideoRequest): boolean
}

const sources = new Map<VideoSourceId, VideoSource>()

/** Кладёт источник в реестр. Повтор — не отказ, а замена с записью в журнал. */
export function registerVideoSource(source: VideoSource): void {
  if (sources.has(source.id)) {
    Logger('WARN', `Источник видео ${source.id} зарегистрирован повторно, беру последний`)
  }
  sources.set(source.id, source)
}

/** Все источники в порядке добавления: он же порядок перебора при отказе. */
export function listVideoSources(): VideoSource[] {
  return [...sources.values()]
}

export function getVideoSource(id: VideoSourceId): VideoSource | null {
  return sources.get(id) ?? null
}

/** Только для проверок: реестр общий на весь запуск и сам себя не чистит. */
export function forgetVideoSources(): void {
  sources.clear()
}

/** Запас перед сроком: минута на цепочку и минута на первый буфер. */
export const STREAM_MARGIN_MS = 120000

/** Годится ли поток к запуску: ссылка без срока годна всегда, со сроком — пока до него больше запаса. */
export function isStreamFresh(stream: VideoStream, now = Date.now()): boolean {
  if (stream.expiresAt === null) return true
  return stream.expiresAt - now > STREAM_MARGIN_MS
}

/** Дорожка нужной высоты или ближайшая снизу, а если таких нет — самая мелкая. */
export function pickTrack(tracks: VideoTrack[], height: number): VideoTrack | null {
  const sorted = [...tracks].sort((a, b) => b.height - a.height)
  const fits = sorted.find((t) => t.height <= height)
  return fits ?? sorted.at(-1) ?? null
}
