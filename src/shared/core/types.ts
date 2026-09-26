// Формы данных AniList и Shikimori: источник правды для api/ и core/db.ts; лишние поля не перечисляются.

/** Вид тайтла AniList: мангу приложение не спрашивает, тип остался в формах ответов и сравнении списков. */
export type MediaType = 'ANIME' | 'MANGA'

/** Статусы в терминах Shikimori — к ним нормализуются и записи AniList. */
export type ShikiStatus =
  'watching' | 'rewatching' | 'planned' | 'completed' | 'on_hold' | 'dropped'

export interface AniListMediaTitle {
  romaji?: string | null
  english?: string | null
}

export interface AniListRelationEdge {
  /** 'SEQUEL' | 'PREQUEL' | 'PARENT' | ... */
  relationType: string
  node: { idMal: number | null }
}

/** Урезанный Media из AniList GraphQL (MediaListCollection.entries[].media). */
export interface AniListMediaLite {
  idMal: number | null
  title?: AniListMediaTitle
  relations?: { edges: AniListRelationEdge[] }
}

/** Полный Media из AniList GraphQL (рендер виджетов страницы тайтла). */
export interface AniListMedia {
  id: number
  type: MediaType
  idMal: number | null
  seasonYear?: number | null
  /** Шкала 0..100. */
  averageScore?: number | null
  title?: AniListMediaTitle
  mediaListEntry?: { status: string | null; progress?: number }
}

/** Общая часть записей сканера дельты (ключ — malId); сравнение идёт вместе с манговыми записями. */
export interface CmpEntryBase {
  malId: number
  title: string
  status: ShikiStatus | null
  /** Оценка 0..10. */
  score10: number
  progress: number
  /** Прочитано томов. У аниме всегда ноль: поле для манговых списков Shikimori. */
  volumes: number
  rewatches: number
  notes: string
}

/** Запись списка AniList после нормализации. */
export interface CmpAniListEntry extends CmpEntryBase {
  /** idMal связанных тайтлов. */
  relations: number[]
}

/** Запись списка Shikimori после нормализации. */
export type CmpShikiEntry = CmpEntryBase

/** Нормализованная запись любого источника. */
export type CmpListEntry = CmpAniListEntry | CmpShikiEntry

/** Урезанный тайтл Shikimori из `${type}_rates`. */
export interface ShikiMediaLite {
  /** Равен MyAnimeList ID. */
  id: number
  russian?: string | null
  name?: string | null
}

/**
 * Трейлер тайтла: форма одна для AniList и Shikimori — готовые адреса, без площадки и номера ролика.
 */
export interface MediaTrailer {
  /** Подпись для подсказки: «Трейлер» или имя ролика из службы. */
  title: string
  /** Кадр ролика: им нарисована плитка. */
  thumb: string | null
  /**
   * Адрес окна, если площадка встраивается; обещать окно, которое не откроется, хуже честного ухода наружу.
   */
  embed: string | null
  /** Обычная ссылка на ролик: запасной путь, когда окно не открылось. */
  url: string
}

/**
 * Кадр тайтла: `preview` — уменьшенный для сетки, `original` — полный для просмотра (у AniList оба совпадают).
 */
export interface MediaShot {
  original: string
  preview: string
}

/** Ролик тайтла Shikimori: заставка, концовка, анонс, кадр серии. */
export interface MediaClip {
  /** Вид ролика словом службы: pv, op, ed, character_trailer, episode_preview. */
  kind: string
  name: string
  /** Адрес наружу: им открывают ролик, если окно не открылось. */
  url: string
  /** Адрес для окна или null, если площадка не встраивается. */
  embed: string | null
  /** Кадр ролика. */
  thumb: string | null
}

/** Кадры и ролики тайтла; ролики лежат целиком — приехали тем же ответом, что и кадры. */
export interface MediaShots {
  shots: MediaShot[]
  clips: MediaClip[]
}

/** Карточка тайтла Shikimori (GET /api/animes|mangas/:id), только нужные поля. */
export interface ShikiMedia {
  id: number
  russian?: string | null
  name?: string | null
  url?: string | null
  /** Зеркало Shikimori, с которого пришёл ответ. */
  domain?: string | null
  description?: string | null
  /** Шкала 0..10. */
  score?: number | null
  /** Гистограмма оценок. */
  rates_scores_stats?: Array<{ name: string; value: number }>
}

/**
 * Имена сторов кэша; `shikiCache` — устаревший псевдоним `mediaCache` ради ветки script, db.ts переводит сам.
 */
export type CacheStoreName = 'mediaCache' | 'shikiCache' | 'malCache' | 'franchiseCache'

/**
 * Запись `mediaCache` (keyPath 'key'): карточки тайтлов и людей, темы; различаются префикс и `data`.
 */
export interface MediaCacheRecord<T = unknown> {
  /** Составной ключ вида "ПРЕФИКС_id", например "RU4_123". */
  key: string
  data: T
  /** Unix-таймстамп записи (протухание по CACHE_TIME). */
  ts: number
}

/**
 * Устаревшее имя того же типа: держится ради ветки `script` с импортами старого вида, пока файлы совпадают.
 */
export type ShikiCacheRecord<T = unknown> = MediaCacheRecord<T>

/** Запись в `malCache` (keyPath 'id'): AniList ID -> AniListMedia. */
export interface MalCacheRecord {
  id: number
  data: AniListMedia
}

/** Запись в `franchiseCache` (keyPath 'id'). */
export interface FranchiseCacheRecord {
  id: number
  data: unknown
  ts?: number
  /**
   * Форма записи; склад франшизы бессрочный, без метки или с чужой дерево собирается заново (нынешняя — 2).
   */
  shape?: number
}

export type CacheRecord = MediaCacheRecord | MalCacheRecord | FranchiseCacheRecord

/**
 * Снимок БД для инспектора: поле на каждый вид записи — показанный ноль иначе не отличить от забытого счётчика.
 */
export interface DbStats {
  /**
   * Карточки тайтлов AniList: префикс MED3_; срок — неделя у завершённого, сутки у идущего (core/cache-life.ts).
   */
  media: number
  /** Персонажи карточки: префикс CHR3_ (core/person-title.ts). */
  characters: number
  /** Персонал карточки: префикс STF4_ (core/person-title.ts). */
  staff: number
  /** Темы открытия и закрытия: префикс THEMES2_ (api/animethemes.ts). */
  themes: number
  /** Русские названия и описания: префиксы RU4_ и NAME1_ (core/media-title.ts). */
  russianTitles: number
  /**
   * Отказы «русского имени нет»: префикс NONAME1_; поле отдельное, иначе сводка врала бы о добытых именах.
   */
  noRussianNames: number
  /** Обложки, цвета и счёт частей: префикс LOOK3_ (core/media-looks.ts). */
  looks: number
  /** Оценки площадок: префикс RATE1_ (core/ratings.ts). */
  ratings: number
  /**
   * Метки «есть что смотреть»: префикс PLAY1_; самая многочисленная запись склада — одна на виденную плитку.
   */
  playable: number
  /** Соответствия релизам Aniliberty: префикс ALIB1_ (api/aniliberty.ts). */
  anilibertyLinks: number
  /** Кадры и ролики тайтла: префикс SHOT1_ (api/media-shots.ts). */
  screenshots: number
  /**
   * Записи стора malCache: ноль здесь тоже правда — стор создан миграцией, но в него никто не пишет.
   */
  malMappings: number
  /** Записи склада франшиз: у него свой ключ-число, а не префикс. */
  franchises: number
  /**
   * Записи с незнакомым префиксом: крупный остаток читается как задача — кто-то пишет мимо таблицы.
   */
  other: number
  totalCacheRecords: number
  estimatedSize: string
}

export interface DbStatsError {
  error: string
}
