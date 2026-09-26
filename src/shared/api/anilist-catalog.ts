// Витрина каталога для главной: сезон, тренды, лучшее, жанровый подбор, советы «по мотивам», жанры
// для профиля вкуса и лента подбора.

import {
  isFresh,
  isFreshAt,
  LIFE_FEED,
  LIFE_GENRES,
  LIFE_RECS,
  LIFE_SHELF_AIRING,
  LIFE_SHELF_GENRE,
  LIFE_SHELF_TOP,
  LIFE_SHELF_TRENDING,
  LIFE_TAGS,
} from '../core/cache-life'
import { dbGet, dbSet } from '../core/db'
import type { MediaCacheRecord } from '../core/types'
import { Logger } from '../utils/logger'
import { anilistQuery } from './anilist'
import type { MediaBrief } from './anilist-media'
import { once } from './rate-limit'

/**
 * Сколько плиток просит полка: показ держит 14, остальное — запас на «не интересно» (отмеченное уходит из полки).
 */
const SHELF_PAGE = 30

/** Сколько советов просим у семени: после склейки повторов останется меньше. */
const SEED_PAGE = 25

/** Потолок страницы у AniList — пятьдесят записей за запрос. */
const LOOKUP_PAGE_SIZE = 50

/**
 * Размер страницы ленты с запасом к порции показа: своё, скрытое и взрослое выбрасываются после ответа, остаток
 * ждёт в ленте следующего «Показать ещё».
 */
const FEED_PAGE_SIZE = 40

/** Что в ленте не показывается никогда: перечисление сервера уходит в запрос как есть. */
const FEED_SKIP_STATUS = 'NOT_YET_RELEASED'

/**
 * Ключи склада; цифра — поколение формы: сменился состав полей — сменилась и она, прежние записи перестанут находиться.
 */
const SHELF_PREFIX = 'SHELF2_'
const TAGS_KEY = 'TAGS1_all'
const GENRE_PREFIX = 'GENRE1_'
const RECS_PREFIX = 'RECS1_'

/** Сроки хранения полок по видам. Смысл каждого срока — в cache-life.ts. */
const SHELF_LIFE: Readonly<Record<ShelfKind, number>> = {
  airing: LIFE_SHELF_AIRING,
  trending: LIFE_SHELF_TRENDING,
  top: LIFE_SHELF_TOP,
  genre: LIFE_SHELF_GENRE,
}

/**
 * Сколько страниц ленты помнить в запаске: листается вниз почти всегда; потолок — ради долгих сеансов с перебором отборов.
 */
const FEED_MEMORY_MAX = 60

/** Справочник тэгов этого запуска: он один на всё приложение. */
let tagsMemory: CatalogTag[] | null = null

/** Жанры тайтлов, уже поднятые со склада в этом запуске. */
const genreMemory = new Map<number, string[]>()

/** Страницы ленты в памяти запуска вместе со временем добычи. */
const feedMemory = new Map<string, { at: number; page: BriefPage }>()

// Поля плитки без записи хозяина; вид нужен не ради показа, а ради отбора: в советах аниме и манга вперемешку.
const BRIEF_FIELDS = `
      id
      idMal
      type
      format
      status
      episodes
      seasonYear
      averageScore
      isAdult
      nextAiringEpisode {
        episode
        airingAt
      }
      title {
        romaji
        english
        native
      }
      coverImage {
        large
        medium
        color
      }`

/** Те же поля фрагментом для пачек: три полки в одном запросе иначе повторили бы их трижды. */
const BRIEF_FRAGMENT = `fragment Brief on Media {${BRIEF_FIELDS}
}`

/** Виды полок витрины: отбор и порядок зашиты в запрос, а не в вызов. */
export type ShelfKind = 'airing' | 'trending' | 'top' | 'genre'

const SHELF_WHERE: Record<ShelfKind, string> = {
  airing: 'season: $season, seasonYear: $seasonYear, sort: [POPULARITY_DESC]',
  trending: 'sort: [TRENDING_DESC]',
  top: 'sort: [SCORE_DESC]',
  genre: 'genre_in: $genres, sort: [SCORE_DESC]',
}

// Лишняя переменная в объявлении роняет запрос: собирается своя под вид, а вид вписан словом — манги на главной не бывает.
function shelfQuery(kind: ShelfKind): string {
  let extra = ''
  if (kind === 'airing') extra = ', $season: MediaSeason, $seasonYear: Int'
  if (kind === 'genre') extra = ', $genres: [String]'

  return `query ($page: Int!, $perPage: Int!${extra}) {
  Page(page: $page, perPage: $perPage) {
    pageInfo {
      hasNextPage
    }
    media(type: ANIME, ${SHELF_WHERE[kind]}) {
${BRIEF_FIELDS}
    }
  }
}`
}

/** Три полки каталога за один поход. Псевдонимы обязательны: без них сервер увидел бы три одинаковых поля Page
    и оставил последнее. */
const PACK_QUERY = `${BRIEF_FRAGMENT}

query ($perPage: Int!, $season: MediaSeason, $seasonYear: Int) {
  airing: Page(page: 1, perPage: $perPage) {
    pageInfo {
      hasNextPage
    }
    media(type: ANIME, season: $season, seasonYear: $seasonYear, sort: [POPULARITY_DESC]) {
      ...Brief
    }
  }
  trending: Page(page: 1, perPage: $perPage) {
    pageInfo {
      hasNextPage
    }
    media(type: ANIME, sort: [TRENDING_DESC]) {
      ...Brief
    }
  }
  top: Page(page: 1, perPage: $perPage) {
    pageInfo {
      hasNextPage
    }
    media(type: ANIME, sort: [SCORE_DESC]) {
      ...Brief
    }
  }
}`

const RECS_QUERY = `query ($id: Int!, $perPage: Int!) {
  Media(id: $id) {
    recommendations(sort: RATING_DESC, page: 1, perPage: $perPage) {
      edges {
        node {
          rating
          mediaRecommendation {
${BRIEF_FIELDS}
          }
        }
      }
    }
  }
}`

const GENRE_QUERY = `query ($ids: [Int], $perPage: Int!) {
  Page(page: 1, perPage: $perPage) {
    media(id_in: $ids, type: ANIME) {
      id
      genres
    }
  }
}`

/** Справочник тэгов каталога. Переменных нет вовсе: список один на всех. */
const TAGS_QUERY = `query {
  MediaTagCollection {
    name
    category
    isAdult
    isGeneralSpoiler
  }
}`

/** Ближайшая серия: номер и срок выхода в секундах. */
interface AiringReply {
  episode?: number | null
  airingAt?: number | null
}

interface BriefReply {
  id?: number
  idMal?: number | null
  type?: string | null
  format?: string | null
  status?: string | null
  episodes?: number | null
  seasonYear?: number | null
  averageScore?: number | null
  isAdult?: boolean | null
  nextAiringEpisode?: AiringReply | null
  title?: { romaji?: string | null; english?: string | null; native?: string | null } | null
  coverImage?: { large?: string | null; medium?: string | null; color?: string | null } | null
}

/** Одна выборка страницы: и у полки, и у каждой доли пачки вид общий. */
interface PageReply {
  pageInfo?: { hasNextPage?: boolean | null } | null
  media?: Array<BriefReply | null> | null
}

interface ShelfReply {
  Page?: PageReply | null
}

type PackReply = Partial<Record<PackKind, PageReply | null>>

interface RecsReply {
  Media?: {
    recommendations?: {
      edges?: Array<{
        node?: { rating?: number | null; mediaRecommendation?: BriefReply | null } | null
      } | null> | null
    } | null
  } | null
}

interface GenreReply {
  Page?: {
    media?: Array<{ id?: number; genres?: Array<string | null> | null } | null> | null
  } | null
}

interface TagReply {
  name?: string | null
  category?: string | null
  isAdult?: boolean | null
  isGeneralSpoiler?: boolean | null
}

interface TagsReply {
  MediaTagCollection?: Array<TagReply | null> | null
}

/** Совет сервера: плитка и вес связи. Вес нужен склейке повторов. */
export interface ServerRec {
  brief: MediaBrief
  rating: number
}

/** Виды полок пачки: три независимые выборки одним походом в сеть. */
export type PackKind = 'airing' | 'trending' | 'top'

/** Пачка полок каталога. Пустая доля значит «эта полка не встанет». */
export type ShelfPack = Record<PackKind, BriefPage>

const PACK_KINDS: readonly PackKind[] = ['airing', 'trending', 'top']

/** Тэг каталога: имя для запроса, раздел для меню, метка взрослого. */
export interface CatalogTag {
  name: string
  category: string
  adult: boolean
}

/** Порядок ленты. Ключи свои: перечисление сервера наружу не выносится. */
export type FeedSort = 'score' | 'popular' | 'trending' | 'new'

const FEED_SORT: Readonly<Record<FeedSort, string>> = {
  score: 'SCORE_DESC',
  popular: 'POPULARITY_DESC',
  trending: 'TRENDING_DESC',
  new: 'START_DATE_DESC',
}

/** Отбор подбора: пустые списки и пустые годы значат «весь каталог». */
export interface CatalogPick {
  genres: string[]
  tags: string[]
  formats: string[]
  yearFrom: number | null
  yearTo: number | null
  sort: FeedSort
}

/** Страница плиток: приехавшее и признак продолжения. Одна форма и у ленты подбора, и у полки витрины: добор
    везде идёт страницами. */
export interface BriefPage {
  items: MediaBrief[]
  hasNext: boolean
}

/** Отбор по умолчанию: весь каталог по оценке. */
export function emptyPick(): CatalogPick {
  return { genres: [], tags: [], formats: [], yearFrom: null, yearTo: null, sort: 'score' }
}

/**
 * Сужен ли отбор; порядок сюда не входит: смена сортировки меняет ленту, но не отбор — прятать из-за неё полки было бы неожиданно.
 */
export function pickIsSet(pick: CatalogPick): boolean {
  return (
    pick.genres.length > 0 ||
    pick.tags.length > 0 ||
    pick.formats.length > 0 ||
    pick.yearFrom !== null ||
    pick.yearTo !== null
  )
}

/** Ключ отбора для памяти запуска: одинаковый отбор — одна загрузка. */
export function pickKey(pick: CatalogPick): string {
  return [
    pick.genres.slice().sort().join('+'),
    pick.tags.slice().sort().join('+'),
    pick.formats.slice().sort().join('+'),
    pick.yearFrom ?? '',
    pick.yearTo ?? '',
    pick.sort,
  ].join('|')
}

/** Целое положительное или `null`: чужие пустоты в нули превращать нельзя. */
function countOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && value > 0 ? value : null
}

/** Строка или `null`. Пустая строка равносильна отсутствию значения. */
function textOrNull(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/**
 * Ответ сервера в плитку; манга отбрасывается здесь — советы мешают виды, а глав у аниме не бывает.
 */
function toBrief(item: BriefReply | null | undefined): MediaBrief | null {
  if (!item || typeof item.id !== 'number') return null
  if (item.type === 'MANGA') return null

  return {
    mediaId: item.id,
    malId: countOrNull(item.idMal),
    type: 'ANIME',
    format: textOrNull(item.format),
    status: textOrNull(item.status),
    episodes: countOrNull(item.episodes),
    chapters: null,
    seasonYear: countOrNull(item.seasonYear),
    averageScore: countOrNull(item.averageScore),
    isAdult: item.isAdult === true,
    romaji: textOrNull(item.title?.romaji),
    english: textOrNull(item.title?.english),
    native: textOrNull(item.title?.native),
    cover: textOrNull(item.coverImage?.large) ?? textOrNull(item.coverImage?.medium),
    color: textOrNull(item.coverImage?.color),
    airingEpisode: countOrNull(item.nextAiringEpisode?.episode),
    airingAt: countOrNull(item.nextAiringEpisode?.airingAt),
    ownEntry: null,
  }
}

/** Плитки из ответа одной выборки. Мусор и манга отсеиваются по пути. */
function toBriefs(media: Array<BriefReply | null> | null | undefined): MediaBrief[] {
  if (!Array.isArray(media)) return []

  const items: MediaBrief[] = []
  for (const item of media) {
    const brief = toBrief(item)
    if (brief) items.push(brief)
  }
  return items
}

/** Текущий сезон года для полки «Сейчас выходит». */
export function currentSeason(): { season: string; seasonYear: number } {
  const now = new Date()
  const month = now.getMonth()
  const season = month <= 2 ? 'WINTER' : month <= 5 ? 'SPRING' : month <= 8 ? 'SUMMER' : 'FALL'
  return { season, seasonYear: now.getFullYear() }
}

/**
 * Ключ полки на складе; у жанровой в ключе сам отбор, жанры сортируются — иначе порядок нажатий плодил бы дубли.
 */
function shelfKey(kind: ShelfKind, genres?: string[]): string {
  if (kind !== 'genre') return `${SHELF_PREFIX}${kind}`
  return `${SHELF_PREFIX}genre_${(genres ?? []).slice().sort().join('+')}`
}

/** Полка со склада, если она там есть и не просрочена. */
async function readShelf(kind: ShelfKind, genres?: string[]): Promise<BriefPage | null> {
  const key = shelfKey(kind, genres)
  const stored = await dbGet<MediaCacheRecord<BriefPage>>('mediaCache', key)
  if (!stored || !Array.isArray(stored.data?.items) || stored.data.items.length === 0) return null
  if (!isFresh(key, stored.ts, SHELF_LIFE[kind])) return null

  return stored.data
}

/**
 * Кладёт полку на склад; пустая не пишется — отказ не должен запомниться на шесть часов.
 */
async function writeShelf(kind: ShelfKind, page: BriefPage, genres?: string[]): Promise<void> {
  if (page.items.length === 0) return

  await dbSet('mediaCache', { key: shelfKey(kind, genres), data: page, ts: Date.now() })
}

/** Сетевой поход за страницей полки. */
async function loadShelf(kind: ShelfKind, page: number, genres?: string[]): Promise<BriefPage> {
  const vars: Record<string, unknown> = { page, perPage: SHELF_PAGE }
  if (kind === 'airing') Object.assign(vars, currentSeason())
  if (kind === 'genre') vars.genres = genres

  const reply = await anilistQuery<ShelfReply>(shelfQuery(kind), vars)
  const media = reply.data?.Page?.media
  if (!Array.isArray(media)) {
    Logger('WARN', `Витрина «${kind}»: сервер ответил пустотой`, reply.errors)
    return { items: [], hasNext: false }
  }

  const items = toBriefs(media)
  const hasNext = reply.data?.Page?.pageInfo?.hasNextPage === true
  Logger('API', `Витрина «${kind}»: страница ${page}, пришло ${items.length}`)

  // Глубокая страница нужна один раз — когда полку подчистили
  // «не интересно» — и на склад не идёт.
  if (page === 1) {
    void writeShelf(kind, { items, hasNext }, genres).catch((e) => {
      Logger('WARN', `Витрина «${kind}»: на склад не легла`, e)
    })
  }

  return { items, hasNext }
}

/**
 * Страница полки: склад, затем сеть, одинаковые вопросы склеиваются; отказ — пустая страница. Первая страница
 * живёт на складе по сроку вида, глубокая в нём не нуждается — её добирают после отметок.
 */
export async function fetchShelf(
  kind: ShelfKind,
  genres?: string[],
  page = 1,
): Promise<BriefPage> {
  if (kind === 'genre' && (genres === undefined || genres.length === 0)) {
    return { items: [], hasNext: false }
  }

  if (page === 1) {
    const stored = await readShelf(kind, genres)
    if (stored) return stored
  }

  return await once(`${shelfKey(kind, genres)}|${page}`, () => loadShelf(kind, page, genres))
}

/** Пачка со склада — только целиком: неполная витрина хуже свежей. */
async function readPack(): Promise<ShelfPack | null> {
  const [airing, trending, top] = await Promise.all([
    readShelf('airing'),
    readShelf('trending'),
    readShelf('top'),
  ])

  if (!airing || !trending || !top) return null

  return { airing, trending, top }
}

/** Сетевой поход за пачкой и запись всех трёх полок на склад. */
async function loadPack(): Promise<ShelfPack> {
  const vars: Record<string, unknown> = { perPage: SHELF_PAGE, ...currentSeason() }
  const reply = await anilistQuery<PackReply>(PACK_QUERY, vars)

  const pack: ShelfPack = {
    airing: { items: [], hasNext: false },
    trending: { items: [], hasNext: false },
    top: { items: [], hasNext: false },
  }

  for (const kind of PACK_KINDS) {
    const page = reply.data?.[kind]
    const media = page?.media
    if (!Array.isArray(media)) {
      Logger('WARN', `Витрина «${kind}»: сервер ответил пустотой`, reply.errors)
      continue
    }

    pack[kind] = { items: toBriefs(media), hasNext: page?.pageInfo?.hasNextPage === true }
  }

  Logger(
    'API',
    `Витрина пачкой: сезон ${pack.airing.items.length}, тренд ${pack.trending.items.length}, ` +
      `лучшее ${pack.top.items.length}`,
  )

  void Promise.all(PACK_KINDS.map((kind) => writeShelf(kind, pack[kind]))).catch((e) => {
    Logger('WARN', 'Витрина пачкой: на склад не легла', e)
  })

  return pack
}

/**
 * Три полки одним походом: отказ роняет всю пачку — плата за один запрос; со склада только целиком.
 */
export async function fetchShelfPack(): Promise<ShelfPack> {
  const stored = await readPack()
  if (stored) return stored

  return await once('shelf-pack', loadPack)
}

/**
 * Запрос страницы ленты: объявление переменных собирается вместе с условием — незанятая роняет запрос.
 * Год приходит границами нечёткой даты AniList (ГГГГММДД: «с 2010» → 20100000, «по 2015» → 20151231).
 */
function feedQuery(pick: CatalogPick, page: number): { query: string; vars: Record<string, unknown> } {
  const decls = ['$page: Int!', '$perPage: Int!']
  const where = ['type: ANIME']
  const vars: Record<string, unknown> = { page, perPage: FEED_PAGE_SIZE }

  if (pick.genres.length > 0) {
    decls.push('$genres: [String]')
    where.push('genre_in: $genres')
    vars.genres = pick.genres
  }

  if (pick.tags.length > 0) {
    decls.push('$tags: [String]')
    where.push('tag_in: $tags')
    vars.tags = pick.tags
  }

  if (pick.formats.length > 0) {
    decls.push('$formats: [MediaFormat]')
    where.push('format_in: $formats')
    vars.formats = pick.formats
  }

  if (pick.yearFrom !== null) {
    decls.push('$from: FuzzyDateInt')
    where.push('startDate_greater: $from')
    vars.from = pick.yearFrom * 10000
  }

  if (pick.yearTo !== null) {
    decls.push('$till: FuzzyDateInt')
    where.push('startDate_lesser: $till')
    vars.till = pick.yearTo * 10000 + 1231
  }

  // Анонсы вон из ленты: у невышедшего нет ни серий, ни оценки — лента из одних обещаний нечитаема.
  where.push(`status_not_in: [${FEED_SKIP_STATUS}]`)

  // Порядок по оценке требует самой оценки: запись без счёта сервер держит рядом с сотней, а не в хвосте.
  if (pick.sort === 'score') where.push('averageScore_greater: 0')

  // Порядок вписывается словом из закрытого списка: переменной сюда нельзя,
  // сервер ждёт перечисление, а чужая строка в запросе — чужая строка.
  where.push(`sort: [${FEED_SORT[pick.sort]}, ID_DESC]`)

  const query = `${BRIEF_FRAGMENT}

query (${decls.join(', ')}) {
  Page(page: $page, perPage: $perPage) {
    pageInfo {
      hasNextPage
    }
    media(${where.join(', ')}) {
      ...Brief
    }
  }
}`

  return { query, vars }
}

/** Кладёт страницу ленты в память запуска, придерживая её размер. */
function rememberFeed(key: string, page: BriefPage): void {
  if (page.items.length === 0) return

  // Map помнит порядок вставки, поэтому старейший ключ — первый.
  if (feedMemory.size >= FEED_MEMORY_MAX) {
    const oldest = feedMemory.keys().next()
    if (!oldest.done) feedMemory.delete(oldest.value)
  }

  feedMemory.set(key, { at: Date.now(), page })
}

/** Сетевой поход за страницей ленты. */
async function loadFeed(pick: CatalogPick, page: number, key: string): Promise<BriefPage> {
  const { query, vars } = feedQuery(pick, page)

  const reply = await anilistQuery<ShelfReply>(query, vars)
  const media = reply.data?.Page?.media
  if (!Array.isArray(media)) {
    Logger('WARN', `Лента подбора: пустой ответ на страницу ${page}`, reply.errors)
    return { items: [], hasNext: false }
  }

  const items = toBriefs(media)
  const hasNext = reply.data?.Page?.pageInfo?.hasNextPage === true
  Logger('API', `Лента подбора: страница ${page}, пришло ${items.length}`)

  const result: BriefPage = { items, hasNext }
  rememberFeed(key, result)
  return result
}

/**
 * Страница ленты: отказ наверх не поднимается — одна оборванная страница не повод рисовать ошибку. Страницы
 * помнятся четверть часа в памяти запуска, а не на складе: отборов бесконечно много и склад бы забился.
 */
export async function fetchFeed(pick: CatalogPick, page: number): Promise<BriefPage> {
  const key = `${pickKey(pick)}|${page}`

  const memo = feedMemory.get(key)
  if (memo && isFreshAt(memo.at, LIFE_FEED)) return memo.page

  return await once(`feed-${key}`, () => loadFeed(pick, page, key))
}

/** Сетевой поход за справочником тэгов и запись его на склад. */
async function loadTags(): Promise<CatalogTag[]> {
  const reply = await anilistQuery<TagsReply>(TAGS_QUERY, {})
  const list = reply.data?.MediaTagCollection
  if (!Array.isArray(list)) {
    Logger('WARN', 'Тэги каталога: сервер ответил пустотой', reply.errors)
    return []
  }

  const tags: CatalogTag[] = []
  for (const item of list) {
    const name = textOrNull(item?.name)
    if (name === null || item?.isGeneralSpoiler === true) continue

    tags.push({
      name,
      category: textOrNull(item?.category) ?? 'Другое',
      adult: item?.isAdult === true,
    })
  }

  tags.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name))
  Logger('API', `Тэги каталога: пришло ${tags.length}`)

  if (tags.length > 0) {
    tagsMemory = tags
    void dbSet('mediaCache', { key: TAGS_KEY, data: tags, ts: Date.now() }).catch((e) => {
      Logger('WARN', 'Тэги каталога: на склад не легли', e)
    })
  }

  return tags
}

/**
 * Справочник тэгов для меню отбора: спойлеры выброшены (строка вроде «главный герой умирает» портит аниме заранее),
 * взрослые остаются с меткой — решает политика показа. На складе месяц: полторы тысячи строк неделями не меняются.
 */
export async function fetchTags(): Promise<CatalogTag[]> {
  if (tagsMemory) return tagsMemory

  const stored = await dbGet<MediaCacheRecord<CatalogTag[]>>('mediaCache', TAGS_KEY)
  if (
    stored &&
    Array.isArray(stored.data) &&
    stored.data.length > 0 &&
    isFresh(TAGS_KEY, stored.ts, LIFE_TAGS)
  ) {
    tagsMemory = stored.data
    return stored.data
  }

  return await once('tags', loadTags)
}

/** Сетевой поход за советами и запись их на склад. */
async function loadRecs(mediaId: number, key: string): Promise<ServerRec[]> {
  const reply = await anilistQuery<RecsReply>(RECS_QUERY, { id: mediaId, perPage: SEED_PAGE })
  const edges = reply.data?.Media?.recommendations?.edges
  if (!Array.isArray(edges)) {
    Logger('WARN', `Советы для ${mediaId}: сервер ответил пустотой`, reply.errors)
    return []
  }

  const found: ServerRec[] = []
  for (const edge of edges) {
    const node = edge?.node
    const brief = toBrief(node?.mediaRecommendation)
    if (brief === null) continue
    found.push({ brief, rating: typeof node?.rating === 'number' ? node.rating : 0 })
  }

  Logger('API', `Советы для ${mediaId}: пришло ${found.length}`)

  // Пустой ответ тоже пишется: связей может не быть вовсе, суточная память дешевле повторных спросов.
  void dbSet('mediaCache', { key, data: found, ts: Date.now() }).catch((e) => {
    Logger('WARN', `Советы для ${mediaId}: на склад не легли`, e)
  })

  return found
}

/**
 * Советы сервера для семени «по мотивам»; мангу отсекает разбор ответа. Сутки хранения не мешают: связи набираются
 * голосами месяцами, а перебор семян больше не превращается в очередь запросов.
 */
export async function fetchRecsFor(mediaId: number): Promise<ServerRec[]> {
  const key = `${RECS_PREFIX}${mediaId}`

  const stored = await dbGet<MediaCacheRecord<ServerRec[]>>('mediaCache', key)
  if (stored && Array.isArray(stored.data) && isFresh(key, stored.ts, LIFE_RECS)) {
    return stored.data
  }

  return await once(key, () => loadRecs(mediaId, key))
}

/** Жанры одного тайтла со склада: они заданы при выпуске и не правятся. */
async function readGenres(mediaId: number): Promise<string[] | null> {
  const key = `${GENRE_PREFIX}${mediaId}`
  const stored = await dbGet<MediaCacheRecord<string[]>>('mediaCache', key)
  if (!stored || !Array.isArray(stored.data)) return null
  if (!isFresh(key, stored.ts, LIFE_GENRES)) return null

  return stored.data
}

/**
 * Жанры аниме пачками для профиля вкуса: спрашивается только то, чего нет на складе — у постоянного хозяина любимое
 * меняется медленно, после первого пересчёта пачек в сети обычно не остаётся.
 */
export async function fetchGenreMap(ids: number[]): Promise<Map<number, string[]>> {
  const found = new Map<number, string[]>()
  const unique = Array.from(new Set(ids.filter((id) => Number.isFinite(id) && id > 0)))

  const missing: number[] = []
  const stored = await Promise.all(
    unique.map(async (id) => {
      const known = genreMemory.get(id)
      if (known) return { id, genres: known }
      return { id, genres: await readGenres(id) }
    }),
  )

  for (const item of stored) {
    if (item.genres === null) {
      missing.push(item.id)
      continue
    }
    genreMemory.set(item.id, item.genres)
    found.set(item.id, item.genres)
  }

  if (missing.length > 0) {
    Logger('DB', `Жанры: со склада ${found.size}, спросим ${missing.length}`)
  }

  for (let from = 0; from < missing.length; from += LOOKUP_PAGE_SIZE) {
    const chunk = missing.slice(from, from + LOOKUP_PAGE_SIZE)
    const reply = await anilistQuery<GenreReply>(GENRE_QUERY, {
      ids: chunk,
      perPage: LOOKUP_PAGE_SIZE,
    })

    const media = reply.data?.Page?.media
    if (!Array.isArray(media)) {
      // Пачка потеряна, но соседние могут дойти: обрывать обход незачем.
      Logger('WARN', `Жанры: пустой ответ на пачку из ${chunk.length}`, reply.errors)
      continue
    }

    const ts = Date.now()
    for (const item of media) {
      if (!item || typeof item.id !== 'number' || !Array.isArray(item.genres)) continue
      const genres = item.genres.filter((g): g is string => typeof g === 'string' && g !== '')
      found.set(item.id, genres)
      genreMemory.set(item.id, genres)

      // Бессрочная запись о пустоте закрыла бы вопрос навсегда, а жанры у свежего анонса ещё проставят.
      if (genres.length === 0) continue

      void dbSet('mediaCache', { key: `${GENRE_PREFIX}${item.id}`, data: genres, ts }).catch((e) => {
        Logger('WARN', `Жанры ${item.id}: на склад не легли`, e)
      })
    }
  }

  return found
}

/**
 * Забыть память запуска (тэги, жанры, ленту) при ручной очистке склада — иначе кнопка выглядела бы сломанной.
 */
export function forgetCatalogMemory(): void {
  tagsMemory = null
  genreMemory.clear()
  feedMemory.clear()
}
