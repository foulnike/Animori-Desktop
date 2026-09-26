// Проверки витрины рекомендаций (`core/recs`): полка обязана оставаться заполненной после отметок
// «не интересно», а очистка памяти обязана эти отметки снимать.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MediaBrief } from '@/api/anilist-media'

import { type MockBridgeHandle } from './mocks/bridge-module'

/** Страницы каталога, которые отдаст подменённый слой api: вид → страницы. */
const pages: Record<string, MediaBrief[][]> = {}

/** Сколько страниц отдано: по нему видно, что полка полезла вглубь. */
const asked: string[] = []

function brief(mediaId: number): MediaBrief {
  return {
    mediaId,
    malId: null,
    type: 'ANIME',
    format: null,
    status: null,
    episodes: null,
    chapters: null,
    seasonYear: null,
    averageScore: null,
    isAdult: false,
    romaji: null,
    english: null,
    native: null,
    cover: null,
    color: null,
    airingEpisode: null,
    airingAt: null,
    ownEntry: null,
  }
}

/** Страница плиток с номерами подряд. */
function row(from: number, count: number): MediaBrief[] {
  return Array.from({ length: count }, (_, at) => brief(from + at))
}

/** Отдаёт страницу вида по номеру. Нет такой — пусто. */
function pageOf(kind: string, page: number): { items: MediaBrief[]; hasNext: boolean } {
  const shelf = pages[kind] ?? []
  const items = shelf[page - 1] ?? []
  asked.push(`${kind}:${page}`)
  return { items, hasNext: page < shelf.length }
}

vi.mock('@/api/anilist-catalog', () => ({
  fetchGenreMap: async () => new Map(),
  fetchRecsFor: async () => [],
  fetchTags: async () => [],
  fetchFeed: async () => ({ items: [], hasNext: false }),
  fetchShelf: async (kind: string, _genres?: string[], page = 1) => pageOf(kind, page),
  fetchShelfPack: async () => ({
    airing: pageOf('airing', 1),
    trending: pageOf('trending', 1),
    top: pageOf('top', 1),
  }),
}))

type Recs = typeof import('../src/shared/core/recs')
type Mocks = typeof import('./mocks/bridge-module')

let recs: Recs
let bridge: MockBridgeHandle

beforeEach(async () => {
  vi.resetModules()

  // Мост поднимается первым: ядро берёт тот же экземпляр модуля, и ручка
  // достаётся из него же. Иначе проверка смотрела бы в другую копию.
  const mocks: Mocks = await import('./mocks/bridge-module')
  mocks.resetMockBridge()
  bridge = mocks.installMockBridge()

  for (const key of Object.keys(pages)) delete pages[key]
  asked.length = 0

  recs = await import('../src/shared/core/recs')
})

describe('полка витрины', () => {
  it('добирает плитки из запаса страницы, не ходят в сеть', async () => {
    pages.top = [row(1, 30)]

    const first = await recs.shelfFill('top', 14)
    expect(first.map((item) => item.mediaId)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14,
    ])

    // Отмечено четырнадцать из тридцати: запас закрывает добор сам.
    for (const item of first) await recs.hideRec(item.mediaId)

    const second = await recs.shelfFill('top', 14)
    expect(second.map((item) => item.mediaId)).toEqual([
      15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28,
    ])
    // Вторая страница не спросилась: тридцати хватило на две дюжины отметок.
    expect(asked.filter((key) => !key.endsWith(':1'))).toEqual([])
  })

  it('берёт следующую страницу, когда запас кончился', async () => {
    pages.trending = [row(1, 4), row(5, 4)]

    const first = await recs.shelfFill('trending', 3)
    expect(first.map((item) => item.mediaId)).toEqual([1, 2, 3])

    // Из четырёх отмечены все: без второй страницы полка опустела бы.
    for (const id of [1, 2, 3, 4]) await recs.hideRec(id)

    const second = await recs.shelfFill('trending', 3)
    expect(second.map((item) => item.mediaId)).toEqual([5, 6, 7])
    expect(asked).toContain('trending:2')
  })

  it('отдаёт что осталось, когда выборка исчерпана', async () => {
    pages.airing = [row(1, 2)]

    const got = await recs.shelfFill('airing', 3)
    expect(got.map((item) => item.mediaId)).toEqual([1, 2])
  })
})

describe('метка «не интересно»', () => {
  it('очистка памяти возвращает отмеченное на полку', async () => {
    pages.top = [row(1, 3)]

    const before = await recs.shelfFill('top', 3)
    expect(before.map((item) => item.mediaId)).toEqual([1, 2, 3])

    await recs.hideRec(1)
    await recs.hideRec(2)

    const hidden = await recs.shelfFill('top', 3)
    expect(hidden.map((item) => item.mediaId)).toEqual([3])

    await recs.clearHidden()

    const cleared = await recs.shelfFill('top', 3)
    expect(cleared.map((item) => item.mediaId)).toEqual([1, 2, 3])
  })

  it('очистка памяти пишет пустой список в хранилище', async () => {
    await recs.hideRec(11)
    await recs.clearHidden()

    // Пустой список, а не отсутствие записи: иначе после перезапуска
    // прежние отметки поднялись бы снова.
    const written = bridge.calls.storageSet.filter((call) => call.key === 'am_recs_hidden')
    expect(written[written.length - 1]?.value).toEqual([])

    await expect(bridge.bridge.storage.get<number[]>('am_recs_hidden', [])).resolves.toEqual([])
  })
})
