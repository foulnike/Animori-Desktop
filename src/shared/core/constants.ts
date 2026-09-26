// Глобальные константы: только неизменяемые значения.
// Состояние сессии — паузы и инстанс БД — живёт в своих модулях, не здесь.

/** Зеркала Shikimori: `.io` первым, `.rip` — откат; рабочее зеркало помнит api/shikimori.ts. */
export const SHIKI_DOMAINS: readonly string[] = ['shikimori.io', 'shikimori.rip']

/** anime365 (smotret-anime) — фоллбэк для тайтлов/описаний. */
export const ANIME365_DOMAINS: readonly string[] = ['smotret-anime.online', 'anime365.ru']
// Своего интервала у anime365 нет: темп един для всех и задан в api/rate-limit.ts.
/** подряд-сбоев -> отключение источника на сессию */
export const ANIME365_FAIL_LIMIT = 5

/** Срок хранения кэша: бессрочно; чистится только руками через clearCache(). */
export const CACHE_TIME = Number.POSITIVE_INFINITY

// IndexedDB
export const DB_NAME = 'AniMoriSuperDB'
/** Версия схемы: 6-я переносит склад карточек shikiCache → mediaCache (миграция в core/db.ts). */
export const DB_VERSION = 6
