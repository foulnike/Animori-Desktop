// Оценки Шикимори и MAL: память, склад, затем сеть — устройство зеркалит studio-logos.ts.
// Карточка берётся через api/shikimori-media.ts; свой ключ склада `RATE1_`, у названий — `RU4_`.

import { dbGet, dbSet } from './db'
import { fetchShikiAnime } from '../api/shikimori-media'
import { Logger } from '../utils/logger'
import type { MediaCacheRecord } from './types'

/** Префикс ключа на складе. Цифра — версия формы записи. */
const KEY_PREFIX = 'RATE1_'

/** Пара оценок площадок для героя, шкала 0..10. */
export interface TitleRatings {
  /** Собственная средняя Шикимори из распределения голосов. */
  shikimori: number | null
  /** Оценка MAL из зеркала Шикимори. */
  mal: number | null
}

const memory = new Map<number, TitleRatings | null>()

/** Чьи ключи уже искали на складе: отсутствие там — повод спросить сеть. */
const asked = new Set<number>()

/** Незавершённые добычи по номеру тайтла. */
const pending = new Map<number, Promise<TitleRatings | null>>()

/** Средняя по распределению голосов Шикимори; мусорные ключи отбрасываются. */
function shikiAverage(stats: Array<{ name: string; value: number }>): number | null {
  let sum = 0
  let votes = 0
  for (const stat of stats) {
    const mark = Number.parseInt(String(stat.name), 10)
    const count = Number(stat.value)
    if (!Number.isFinite(mark) || mark < 1 || mark > 10) continue
    if (!Number.isFinite(count) || count <= 0) continue
    sum += mark * count
    votes += count
  }
  return votes > 0 ? sum / votes : null
}

async function readCache(mediaId: number): Promise<TitleRatings | null> {
  asked.add(mediaId)
  const record = await dbGet<MediaCacheRecord<TitleRatings>>('mediaCache', KEY_PREFIX + mediaId)
  const data = record?.data
  return data && typeof data === 'object' ? data : null
}

/** Адрес всегда анимешный: раздела манги у нас больше нет. */
async function load(mediaId: number, malId: number): Promise<TitleRatings | null> {
  if (!asked.has(mediaId)) {
    const cached = await readCache(mediaId)
    if (cached) {
      memory.set(mediaId, cached)
      return cached
    }
  }

  const reply = await fetchShikiAnime(malId)

  if (!reply.data) {
    memory.set(mediaId, null)
    return null
  }

  const mal = Number(reply.data.score)
  const ratings: TitleRatings = {
    shikimori: Array.isArray(reply.data.rates_scores_stats)
      ? shikiAverage(reply.data.rates_scores_stats)
      : null,
    mal: Number.isFinite(mal) && mal > 0 ? mal : null,
  }

  memory.set(mediaId, ratings)
  await dbSet('mediaCache', { key: KEY_PREFIX + mediaId, data: ratings, ts: Date.now() })
  return ratings
}

/** Оценки площадок одного тайтла или `null`. Ошибки глушатся: нет рейтинга — не поломка. */
export async function getTitleRatings(
  mediaId: number,
  malId: number | null,
): Promise<TitleRatings | null> {
  if (malId === null) return null
  if (memory.has(mediaId)) return memory.get(mediaId) ?? null

  const inFlight = pending.get(mediaId)
  if (inFlight) return await inFlight

  const task = load(mediaId, malId).catch((e) => {
    Logger('WARN', `Оценки площадок: тайтл ${mediaId} мимо`, e)
    return null
  })

  pending.set(mediaId, task)

  try {
    return await task
  } finally {
    pending.delete(mediaId)
  }
}
