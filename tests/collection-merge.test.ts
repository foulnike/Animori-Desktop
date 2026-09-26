// Проверки слияния чужого списка со своим (`core/collection`, mergeFromServer).

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/shikimori-list', () => ({
  importShikiList: vi.fn(),
}))

/** Запись снимка со всеми полями: пропущенное поле ломает сборку. */
function entry(mediaId: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    mediaId,
    malId: mediaId,
    status: 'COMPLETED',
    score10: 0,
    progress: 0,
    repeat: 0,
    startedAt: null as string | null,
    completedAt: null as string | null,
    notes: null,
    updatedAt: 0,
    isAdult: false,
    romaji: null,
    english: null,
    ...over,
  }
}

/** Ответ источника: одна запись с обеими датами из журнала. */
function answer(mediaId: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    user: { id: 331301, nick: 'foulnike' },
    entries: [
      {
        mediaId,
        malId: mediaId,
        status: 'COMPLETED',
        score: 0,
        progress: 12,
        repeat: 0,
        startedAt: '2021-03-24',
        completedAt: '2021-03-25',
        notes: null,
        updatedAt: 1000,
        isAdult: false,
        romaji: null,
        english: null,
        ...over,
      },
    ],
    read: 1,
    matched: 1,
    lost: 0,
    lostTitles: [],
    dated: 1,
  }
}

async function setup() {
  // Порядок важен: `vi.resetModules()` пересобирает и сам мок моста, поэтому ставить его надо ПОСЛЕ
  // сброса и брать из той же свежей сборки.
  vi.resetModules()

  const bridge = await import('./mocks/bridge-module')
  bridge.resetMockBridge()
  bridge.installMockBridge()

  const collection = await import('@/core/collection')
  const list = await import('@/api/shikimori-list')

  return { collection, list: vi.mocked(list) }
}

beforeEach(() => {
  vi.resetModules()
})

describe('слияние списка с Шикимори', () => {
  it('добирает даты в запись, поправленную здесь', async () => {
    const { collection, list } = await setup()
    list.importShikiList.mockResolvedValue(answer(21) as never)

    await collection.initCollection()
    // Своя правка новее серверной: спор о полях за нами, дат у нас нет.
    collection.putEntry(entry(21, { progress: 11, updatedAt: 5000 }) as never)

    const done = await collection.pullFromShikimori('foulnike', 'merge')

    expect(done.kept).toBe(1)
    expect(done.updated).toBe(0)
    const mine = collection.getEntry(21)
    expect(mine?.progress).toBe(11)
    expect(mine?.startedAt).toBe('2021-03-24')
    expect(mine?.completedAt).toBe('2021-03-25')
  })

  it('не затирает дату, поставленную руками', async () => {
    const { collection, list } = await setup()
    list.importShikiList.mockResolvedValue(answer(22) as never)

    await collection.initCollection()
    collection.putEntry(
      entry(22, { startedAt: '2019-01-01', updatedAt: 5000 }) as never,
    )

    await collection.pullFromShikimori('foulnike', 'merge')

    const mine = collection.getEntry(22)
    expect(mine?.startedAt).toBe('2019-01-01')
    // Пустое место рядом всё равно добирается: одно другому не мешает.
    expect(mine?.completedAt).toBe('2021-03-25')
  })

  it('уступает серверу, когда его метка не старее нашей', async () => {
    const { collection, list } = await setup()
    list.importShikiList.mockResolvedValue(answer(23, { progress: 12 }) as never)

    await collection.initCollection()
    collection.putEntry(entry(23, { progress: 3, updatedAt: 1000 }) as never)

    const done = await collection.pullFromShikimori('foulnike', 'merge')

    expect(done.updated).toBe(1)
    const mine = collection.getEntry(23)
    expect(mine?.progress).toBe(12)
    expect(mine?.startedAt).toBe('2021-03-24')
  })

  it('пустая дата у источника остаётся пустой и не стирает ничего', async () => {
    const { collection, list } = await setup()
    list.importShikiList.mockResolvedValue(
      answer(24, { startedAt: null, completedAt: null }) as never,
    )

    await collection.initCollection()
    collection.putEntry(
      entry(24, { startedAt: '2018-06-19', updatedAt: 5000 }) as never,
    )

    await collection.pullFromShikimori('foulnike', 'merge')

    const mine = collection.getEntry(24)
    expect(mine?.startedAt).toBe('2018-06-19')
    expect(mine?.completedAt).toBeNull()
  })
})
