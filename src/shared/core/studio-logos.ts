// Литографии студий с Шикимори раз в сеанс: список ложится на склад бессрочно, сверка по имени.
// Отказ помнится четверть часа, иначе каждая карточка бьётся в лежащее зеркало заново.

import { isFresh, LIFE_FOREVER, MINUTE_MS } from './cache-life'
import { dbGet, dbSet } from './db'
import { fetchShiki } from '../api/shikimori'
import { Logger } from '../utils/logger'
import type { MediaCacheRecord } from './types'

/** Ключ единственной записи на складе. Цифра — версия формы записи. */
const CACHE_KEY = 'STUDIOS1'

/** Сколько молчать после отказа источника: картинка у чипа — украшение, не повод биться. */
const MISS_QUIET_MS = 15 * MINUTE_MS

/** Имена студий в нижнем регистре → абсолютный адрес литографии. */
let memory: Map<string, string> | null = null

/** До этого времени в сеть за списком не ходим: прошлый поход ничего не принёс. */
let quietUntil = 0

/** Незавершённая добыча: две карточки могут спросить в один миг. */
let pending: Promise<Map<string, string> | null> | null = null

interface ShikiStudio {
  id?: number
  name?: string | null
  filtered_name?: string | null
  image?: string | null
}

async function load(): Promise<Map<string, string> | null> {
  const cached = await dbGet<MediaCacheRecord<Record<string, string>>>('mediaCache', CACHE_KEY)
  if (cached?.data && typeof cached.data === 'object' && isFresh(CACHE_KEY, cached.ts, LIFE_FOREVER)) {
    const map = new Map(Object.entries(cached.data))
    if (map.size > 0) return map
  }

  // Прошлый поход закончился ничем и с тех пор прошло мало времени.
  if (Date.now() < quietUntil) return null

  const reply = await fetchShiki<ShikiStudio[]>('/api/studios')
  if (!Array.isArray(reply.data)) {
    quietUntil = Date.now() + MISS_QUIET_MS
    return null
  }

  // Конкатенация, а не шаблон: адрес из двух строк не теряет части по дороге.
  const base = 'https://' + (reply.domain ?? 'shikimori.io')
  const map = new Map<string, string>()
  for (const s of reply.data) {
    if (!s || typeof s.image !== 'string' || s.image === '') continue
    const url = s.image.startsWith('http') ? s.image : base + s.image
    if (typeof s.name === 'string' && s.name !== '') map.set(s.name.trim().toLowerCase(), url)
    if (typeof s.filtered_name === 'string' && s.filtered_name !== '' && s.filtered_name !== s.name)
      map.set(s.filtered_name.trim().toLowerCase(), url)
  }

  if (map.size === 0) {
    quietUntil = Date.now() + MISS_QUIET_MS
    return null
  }

  await dbSet('mediaCache', { key: CACHE_KEY, data: Object.fromEntries(map), ts: Date.now() })
  Logger('DB', `Литографии студий: на складе ${map.size}`)
  return map
}

/** Карта «имя студии → литография»: память, склад, затем сеть. Промах — null. */
export async function studioLogos(): Promise<Map<string, string> | null> {
  if (memory) return memory
  if (pending) return await pending

  const task = load().catch((e) => {
    Logger('WARN', 'Литографии студий: добыть не вышло', e)
    quietUntil = Date.now() + MISS_QUIET_MS
    return null
  })
  pending = task

  try {
    memory = await task
    return memory
  } finally {
    pending = null
  }
}
