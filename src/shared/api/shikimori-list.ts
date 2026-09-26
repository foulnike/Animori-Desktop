// Список пользователя с Шикимори: чтение по нику, без входа и без пропуска (вид записи — как у
// anilist-list.ts).

import { Logger } from '../utils/logger'
import type { RawListEntry } from './anilist-list'
import { fetchBriefsByMal } from './anilist-lookup'
import { fetchShikiHistoryDates } from './shikimori-history'
import { hiddenProfileMessage, shikiUserGet } from './shikimori-user'

/** Записей за одну страницу: тысяча укладывается в таймаут и покрывает почти любой живой список. */
const PAGE_SIZE = 1000

/** Потолок страниц: страж от сервера, который перестанет отдавать пустую страницу в конце. */
const MAX_PAGES = 20

/** Сколько названий потерянных записей называть вслух. Дальше — только число. */
const LOST_NAMES = 8

/** Кто нашёлся по нику. */
export interface ShikiUser {
  id: number
  /** Ник в том виде, в каком его пишет сам Сайт, а не как набрал человек. */
  nick: string
}

/** Итог чтения списка с Шикимори до всякого слияния с памятью. */
export interface ShikiImport {
  user: ShikiUser
  /** Записи в общем виде: ядро коллекции примет их как ответ сервера. */
  entries: RawListEntry[]
  /** Сколько записей отдал Шикимори. */
  read: number
  /** Сколько из них привязалось к номерам AniList. */
  matched: number
  /** Сколько осталось без пары и в список не попадёт. */
  lost: number
  /** Названия потерянных, до LOST_NAMES штук: экрану есть что показать. */
  lostTitles: string[]
  /** Сколько записей получило хоть одну дату из журнала изменений. */
  dated: number
}

/** Закладки Шикимори в закладки AniList; незнакомая даёт null и попадает в журнал, а не «смотрю». */
const STATUS_MAP: Readonly<Record<string, string>> = {
  planned: 'PLANNING',
  watching: 'CURRENT',
  rewatching: 'REPEATING',
  completed: 'COMPLETED',
  on_hold: 'PAUSED',
  dropped: 'DROPPED',
}

/** Ответ сервера о пользователе. Лишние поля не описаны: нужны два. */
interface UserReply {
  id?: number
  nickname?: string
}

/** Запись списка в том виде, в каком её отдаёт /anime_rates. */
interface RateReply {
  status?: string | null
  score?: number | null
  episodes?: number | null
  rewatches?: number | null
  text?: string | null
  created_at?: string | null
  updated_at?: string | null
  anime?: {
    id?: number
    name?: string | null
    russian?: string | null
  } | null
}

/** Целое неотрицательное или ноль: чужие пустоты не должны стать NaN. */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** Строка или null. Пустой комментарий равносилен отсутствию комментария. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** Время правки в миллисекундах; нечитаемая дата даёт ноль, а не сегодня — «сейчас» затёрло бы местную правку. */
function when(value: unknown): number {
  if (typeof value !== 'string' || value === '') return 0

  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : 0
}

/** Ник без лишнего; ссылку на профиль целиком тоже принимаем. */
export function cleanNick(raw: string): string {
  const cut = raw.trim().replace(/\/+$/, '')
  if (cut === '') return ''

  const tail = cut.slice(cut.lastIndexOf('/') + 1)
  return tail.startsWith('@') ? tail.slice(1) : tail
}

/**
 * Найти пользователя по нику: списки сервер отдаёт только по номеру, а ник меняется. Отказы разведены по кодам:
 * 404 — нет ника, 403 — профиль закрыт, 429 — подождать.
 */
export async function findShikiUser(nick: string): Promise<ShikiUser> {
  const wanted = cleanNick(nick)
  if (wanted === '') throw new Error('Ник не введён.')

  const path = `/api/users/${encodeURIComponent(wanted)}?is_nickname=1`
  const reply = await shikiUserGet<UserReply>(path)

  if (reply.status === 404) {
    throw new Error(`На Шикимори нет пользователя «${wanted}». Проверьте ник.`)
  }

  if (reply.status === 403 || reply.status === 401) {
    throw new Error(hiddenProfileMessage())
  }

  if (reply.status === 429) {
    throw new Error('Шикимори просит подождать: слишком много запросов. Повторите через минуту.')
  }

  const id = count(reply.data?.id)
  if (!reply.ok || id === 0) {
    throw new Error(`Шикимори ответил отказом (${reply.status}). Попробуйте позже.`)
  }

  return { id, nick: text(reply.data?.nickname) ?? wanted }
}

/**
 * Все закладки аниме постранично; отбора нет сознательно — переносится весь список. Пустая страница и 404 значат
 * одно и то же: страниц больше нет.
 */
async function readRates(userId: number): Promise<RateReply[]> {
  const all: RateReply[] = []

  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = `/api/users/${userId}/anime_rates?limit=${PAGE_SIZE}&page=${page}`
    const reply = await shikiUserGet<RateReply[]>(path)

    if (reply.status === 403 || reply.status === 401) throw new Error(hiddenProfileMessage())

    if (reply.status === 429) {
      throw new Error(
        'Шикимори просит подождать: слишком много запросов. Повторите через минуту.',
      )
    }

    if (reply.status === 404) break

    if (!reply.ok) {
      // Молчать об отказе страницы нельзя: половину списка человек примет за полный.
      throw new Error(`Шикимори ответил отказом (${reply.status}) на странице ${page}.`)
    }

    const chunk = reply.data
    if (!Array.isArray(chunk) || chunk.length === 0) break

    all.push(...chunk)
    Logger('API', `Шикимори: страница ${page}, записей ${chunk.length}`)

    // Неполная страница — последняя: лишний запрос за пустотой ни к чему.
    if (chunk.length < PAGE_SIZE) break
  }

  return all
}

/** Номер MAL из ответа: номер тайтла у Шикимори совпадает с номером MAL. */
function malIdOf(rate: RateReply): number {
  return count(rate.anime?.id)
}

/** Имя для жалобы о потере: русское, иначе латиница, иначе номер. */
function nameOf(rate: RateReply): string {
  return text(rate.anime?.russian) ?? text(rate.anime?.name) ?? `#${malIdOf(rate)}`
}

/** День события в виде ГГГГ-ММ-ДД по местным суткам: toISOString() уехал бы в UTC и разошёлся с сайтом. */
function dayOf(ms: number): string {
  const date = new Date(ms)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')

  return `${date.getFullYear()}-${month}-${day}`
}

/**
 * Читает список с Шикимори и переводит его в общий вид записи; слияние и замена — дело ядра коллекции.
 * Дат в закладках нет: они приезжают из журнала изменений (api/shikimori-history.ts).
 */
export async function importShikiList(nick: string): Promise<ShikiImport> {
  const user = await findShikiUser(nick)
  const rates = await readRates(user.id)

  Logger('API', `Шикимори: список ${user.nick} прочитан, записей ${rates.length}`)

  // Журнал читается после списка, а не вровень: второй поток к тому же серверу наперегонки не пускаем.
  const history = await fetchShikiHistoryDates(user.id)

  // Тайтл в закладках встречается раз, но страницы могут зайти внахлёст при правке во время обхода.
  const byMal = new Map<number, RateReply>()
  for (const rate of rates) {
    const malId = malIdOf(rate)
    if (malId === 0) continue

    const known = byMal.get(malId)
    if (!known || when(known.updated_at) <= when(rate.updated_at)) byMal.set(malId, rate)
  }

  const wanted = Array.from(byMal.keys())
  const briefs = wanted.length === 0 ? [] : await fetchBriefsByMal(wanted)

  const found = new Map<number, (typeof briefs)[number]>()
  for (const brief of briefs) if (brief.malId !== null) found.set(brief.malId, brief)

  const entries: RawListEntry[] = []
  const lostTitles: string[] = []
  let lost = 0
  let dated = 0

  for (const [malId, rate] of byMal) {
    const brief = found.get(malId)
    if (!brief) {
      // Тайтла нет у AniList либо связь с MAL не записана; молчать нельзя — считаем потерю.
      lost++
      if (lostTitles.length < LOST_NAMES) lostTitles.push(nameOf(rate))
      continue
    }

    const status = text(rate.status)
    const mapped = status === null ? null : (STATUS_MAP[status] ?? null)
    if (status !== null && mapped === null) {
      Logger('WARN', `Шикимори: незнакомая закладка «${status}» у ${nameOf(rate)}`)
    }

    // Время правки обязательно: по нему слияние решает, чья запись свежее; без него — самая старая.
    const edited = when(rate.updated_at) || when(rate.created_at)

    // Даты из журнала; пустое место остаётся пустым: у запланированного просмотров не было.
    const seen = history.dates.get(`anime:${malId}`)
    const startedAt = seen?.start == null ? null : dayOf(seen.start)
    const completedAt = seen?.end == null ? null : dayOf(seen.end)
    if (startedAt !== null || completedAt !== null) dated++

    entries.push({
      mediaId: brief.mediaId,
      malId,
      status: mapped,
      score: count(rate.score),
      progress: count(rate.episodes),
      repeat: count(rate.rewatches),
      startedAt,
      completedAt,
      notes: text(rate.text),
      updatedAt: edited,
      isAdult: brief.isAdult,
      romaji: brief.romaji,
      english: brief.english,
    })
  }

  Logger(
    'API',
    `Шикимори: привязано ${entries.length} из ${byMal.size}, без пары ${lost}, ` +
      `с датами ${dated}`,
  )

  return {
    user,
    entries,
    read: rates.length,
    matched: entries.length,
    lost,
    lostTitles,
    dated,
  }
}
