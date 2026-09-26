// Клиент AnimeThemes.moe: опенинги и эндинги по MAL ID. Спрашиваем GraphQL — прежний JSON:API
// помечен устаревшим и отключат его молча, без ошибки в журнале.

import { Bridge, type HttpResponse } from '@/bridge'
import { CACHE_TIME } from '../core/constants'
import { dbGet, dbSet } from '../core/db'
import { reportError, reportStatus } from '../core/net-health'
import { Logger } from '../utils/logger'
import type { MediaCacheRecord } from '../core/types'
import { animeThemesLimiter } from './rate-limit'

/** Адрес запроса: собран конкатенацией — литерал схемы в шаблонной строке ломался при отправке. */
const API_URL = 'https://graphql.animethemes.moe/'

/**
 * Тело запроса: переменная одна (сервис принимает список, нам нужен один тайтл; подстановка избавляет от склейки
 * строк). site: MAL — площадка, имя перечисления не подпись: в JSON:API та же площадка звалась MyAnimeList.
 */
const THEMES_QUERY = `query Themes($malId: [Int!]) {
  findAnimeByExternalSite(site: MAL, id: $malId) {
    animethemes {
      type
      slug
      song {
        title { romaji }
        performances { artist { name { main } } }
        resources { nodes { site link } }
      }
      animethemeentries {
        videos { nodes { audio { link } } }
      }
    }
  }
}`

/** Имя источника для учёта доступности: именно имя, не адрес — net-health по замыслу не знает ни одного хоста. */
export const NET_SOURCE_ANIMETHEMES = 'animethemes'
export const NET_LABEL_ANIMETHEMES = 'AnimeThemes'

/** Пауза ограничителю после 429. Джиттер разводит одновременные карточки. */
const RATE_PAUSE_MS = 1500
const REQUEST_TIMEOUT_MS = 10000

/** Номер вида записи в кэше: поднимается при правке содержимого — кэш тем вечный и само не
 * выветрится. При переезде на GraphQL строение не изменилось, ключ оставлен. */
const SHAPE = 4

const pendingThemes = new Map<number, Promise<MalThemes | null>>()

/** Ссылка на песню во внешней музыкальной службе. */
export interface ThemeLink {
  /** Ключ службы для разметки: spotify, apple, youtube, amazon. */
  site: string
  /** Подпись службы для подсказки. */
  label: string
  url: string
}

export interface ThemeItem {
  seq: string
  title: string
  artist: string
  /** Адрес звукового файла темы; null — у AnimeThemes его нет. */
  audio: string | null
  /** Стриминги песни; пустой список — ссылок не дали. */
  links: ThemeLink[]
}

export interface MalThemes {
  openings: ThemeItem[]
  endings: ThemeItem[]
}

/** Службы, ссылки на которые имеют смысл в карточке: слева имя перечисления, справа ключ и
 * подпись. */
const MUSIC_SITES: ReadonlyArray<{ key: string; site: string; label: string }> = [
  { key: 'SPOTIFY', site: 'spotify', label: 'Spotify' },
  { key: 'APPLE_MUSIC', site: 'apple', label: 'Apple Music' },
  { key: 'YOUTUBE_MUSIC', site: 'youtube', label: 'YouTube Music' },
  { key: 'AMAZON_MUSIC', site: 'amazon', label: 'Amazon Music' },
  { key: 'YOUTUBE', site: 'youtube', label: 'YouTube' },
]

interface AnimeThemesResource {
  site?: string
  link?: string
}

interface AnimeThemesName {
  main?: string
}

interface AnimeThemesPerformance {
  artist?: { name?: AnimeThemesName }
}

interface AnimeThemesSong {
  title?: { romaji?: string }
  performances?: AnimeThemesPerformance[]
  resources?: { nodes?: AnimeThemesResource[] }
}

interface AnimeThemesVideo {
  audio?: { link?: string }
}

interface AnimeThemesThemeEntry {
  videos?: { nodes?: AnimeThemesVideo[] }
}

interface AnimeThemesEntry {
  type?: string
  slug?: string
  song?: AnimeThemesSong
  animethemeentries?: AnimeThemesThemeEntry[]
}

interface AnimeThemesAnime {
  animethemes?: AnimeThemesEntry[]
}

interface AnimeThemesResponse {
  data?: { findAnimeByExternalSite?: AnimeThemesAnime[] }
  /** Отказ приходит с кодом 200: разбирать его обязательно. */
  errors?: Array<{ message?: string }>
}

/**
 * Звук темы: первая найденная аудиодорожка. Записей у темы несколько (телеверсия, без титров), но песня одна —
 * выбор карточке ничего не даёт.
 */
function pickAudio(entries: readonly AnimeThemesThemeEntry[]): string | null {
  for (const entry of entries) {
    for (const video of entry.videos?.nodes ?? []) {
      const link = video.audio?.link
      if (typeof link === 'string' && link !== '') return link
    }
  }
  return null
}

/**
 * Исполнители песни строкой: свёртываем по имени — на группу приходит по строке на каждого, и без свёртывания
 * имя повторилось бы столько раз, сколько в ней человек.
 */
function pickArtists(song: AnimeThemesSong): string {
  const names: string[] = []
  const seen = new Set<string>()

  for (const perf of song.performances ?? []) {
    const name = perf.artist?.name?.main
    if (typeof name !== 'string' || name === '' || seen.has(name)) continue

    seen.add(name)
    names.push(name)
  }

  return names.join(', ')
}

/** Стриминги песни без повторов: одна служба — одна иконка в строке. */
function pickLinks(resources: readonly AnimeThemesResource[]): ThemeLink[] {
  const out: ThemeLink[] = []
  const seen = new Set<string>()

  for (const res of resources) {
    const url = res.link
    const key = (res.site ?? '').trim().toUpperCase()
    if (typeof url !== 'string' || url === '' || key === '') continue

    const known = MUSIC_SITES.find((s) => s.key === key)
    if (!known || seen.has(known.site)) continue

    seen.add(known.site)
    out.push({ site: known.site, label: known.label, url })
  }

  return out
}

/**
 * Номер темы из слага — первая группа цифр; склеивать все подряд нельзя: у версий (OP1-EN4Kids) получилось бы 14,
 * и тема встала бы на место настоящей четырнадцатой. Без цифр в слаге (OP) — первая заставка.
 */
function seqOf(slug: string): string {
  return slug.match(/\d+/)?.[0] ?? '1'
}

/** Убирает песни, пришедшие дважды: версия заставки (OP1 и OP1-EN) даёт один номер и ту же песню —
 * у One Piece таких пар двенадцать в каждую сторону. */
function dropTwins(items: readonly ThemeItem[]): ThemeItem[] {
  const seen = new Set<string>()
  const out: ThemeItem[] = []

  for (const item of items) {
    const mark = item.title.trim().toLowerCase()
    if (seen.has(mark)) continue

    seen.add(mark)
    out.push(item)
  }

  return out
}

/** Разбирает ответ API в списки опенингов и эндингов. */
function formatThemes(themes: AnimeThemesEntry[]): MalThemes {
  const formattedData: MalThemes = { openings: [], endings: [] }

  themes.forEach((t) => {
    const song = t.song ?? {}
    const slug = t.slug ?? ''
    const title = song.title?.romaji || slug
    const seq = seqOf(slug)
    const item: ThemeItem = {
      seq,
      title,
      artist: pickArtists(song),
      audio: pickAudio(t.animethemeentries ?? []),
      links: pickLinks(song.resources?.nodes ?? []),
    }

    if (t.type === 'OP') formattedData.openings.push(item)
    else if (t.type === 'ED') formattedData.endings.push(item)
  })

  // Повторы отсеиваются после сортировки: из двух записей одной песни первой должна остаться та,
  // что стоит раньше в списке, а порядок он и задаёт.
  const byNumber = (a: ThemeItem, b: ThemeItem): number => Number(a.seq) - Number(b.seq)
  formattedData.openings.sort(byNumber)
  formattedData.endings.sort(byNumber)

  return {
    openings: dropTwins(formattedData.openings),
    endings: dropTwins(formattedData.endings),
  }
}

/** Грузит темы по MAL ID; кэш — mediaCache, ключ THEMES2_<malId>#<вид>. */
export async function fetchMalThemes(malId: number | null): Promise<MalThemes | null> {
  if (!malId) return null

  const pending = pendingThemes.get(malId)
  if (pending) return pending

  const task = fetchMalThemesAttempt(malId)
  pendingThemes.set(malId, task)
  try {
    return await task
  } finally {
    pendingThemes.delete(malId)
  }
}

async function fetchMalThemesAttempt(malId: number): Promise<MalThemes | null> {
  const cacheKey = `THEMES2_${malId}#${SHAPE}`
  const cached = await dbGet<MediaCacheRecord<MalThemes>>('mediaCache', cacheKey)
  if (cached && Date.now() - cached.ts < CACHE_TIME) return cached.data

  Logger('API', `Запрос AnimeThemes.moe для MAL ID: ${malId}`)

  let res: HttpResponse
  // Замер идёт вместе с ожиданием слота: важно, сколько ждал виджет, а не сервер.
  const startedAt = Date.now()
  try {
    // Слот берём перед отправкой: для счётчика окна это такой же запрос, как все.
    await animeThemesLimiter.acquireSlot()

    res = await Bridge.http.request({
      method: 'POST',
      url: API_URL,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: THEMES_QUERY, variables: { malId: [malId] } }),
      timeoutMs: REQUEST_TIMEOUT_MS,
    })
  } catch (e) {
    // Сюда приходит только транспортный сбой, таймаут или отмена.
    Logger('ERROR', 'AnimeThemes Network Error', e)
    reportError(NET_SOURCE_ANIMETHEMES, NET_LABEL_ANIMETHEMES, e, Date.now() - startedAt)
    return null
  }

  // Отчёт идёт до разбора статусов ниже: net-health сам игнорирует 429 и 401.
  reportStatus(NET_SOURCE_ANIMETHEMES, NET_LABEL_ANIMETHEMES, res.status, Date.now() - startedAt)

  // Код вне 2xx мост исключением не считает, поэтому статусы разбираем сами.
  if (res.status === 429) {
    // Пауза на ограничителе, а не sleep: она притормозит и соседние карточки в очереди.
    const waitMs = RATE_PAUSE_MS + Math.floor(Math.random() * 500)
    animeThemesLimiter.pause(waitMs)

    Logger('ERROR', `AnimeThemes: лимит 429, пауза ${waitMs}мс, темы не загружены (MAL ${malId})`)
    // Не кэшируем: это временный отказ, а не отсутствие тем.
    return null
  }

  if (res.status !== 200) {
    Logger('ERROR', `AnimeThemes Error HTTP ${res.status}`)
    return null
  }

  try {
    const parsed = JSON.parse(res.text) as AnimeThemesResponse

    // Отказ GraphQL приходит с кодом 200, и это не «тем нет»: кэшировать нельзя.
    if (parsed.errors && parsed.errors.length > 0) {
      const reason = parsed.errors[0]?.message ?? 'без пояснения'
      Logger('ERROR', `AnimeThemes: запрос отвергнут — ${reason} (MAL ${malId})`)
      return null
    }

    const animeList = parsed.data?.findAnimeByExternalSite ?? []

    // Не найдено — кэшируем пустой результат.
    if (animeList.length === 0) {
      const emptyData: MalThemes = { openings: [], endings: [] }
      void dbSet('mediaCache', { key: cacheKey, data: emptyData, ts: Date.now() })
      return emptyData
    }

    const formattedData = formatThemes(animeList[0]?.animethemes ?? [])
    void dbSet('mediaCache', { key: cacheKey, data: formattedData, ts: Date.now() })
    return formattedData
  } catch (e) {
    Logger('ERROR', 'Ошибка разбора ответа AnimeThemes', e)
    return null
  }
}
