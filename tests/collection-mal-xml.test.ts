// Проверки переноса списка из файла выгрузки MAL (`pullFromMalFile`). ЗАЧЕМ ОТДЕЛЬНО ОТ
// collection-merge.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/mal-import', () => ({
  importMalList: vi.fn(),
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

/** Запись файла: серверная форма, как её отдаёт importMalList. */
function rawEntry(mediaId: number, over: Partial<Record<string, unknown>> = {}) {
  return {
    mediaId,
    malId: mediaId,
    status: 'COMPLETED',
    score: 0,
    progress: 12,
    repeat: 0,
    startedAt: '2025-03-04',
    completedAt: null as string | null,
    notes: null,
    updatedAt: 0,
    isAdult: false,
    romaji: 'Romaji',
    english: null,
    ...over,
  }
}

/** Ответ источника: записи и честный счёт прочитанного и потерянного. */
function answer(entries: unknown[], over: Partial<Record<string, unknown>> = {}) {
  return {
    entries,
    read: entries.length,
    matched: entries.length,
    lost: 0,
    lostTitles: [] as string[],
    ...over,
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
  const importer = await import('@/api/mal-import')

  return { collection, importer: vi.mocked(importer) }
}

beforeEach(() => {
  vi.resetModules()
})

describe('перенос списка из файла MAL', () => {
  it('запись без метки правки проигрывает своей правке, но добирает пустое', async () => {
    const { collection, importer } = await setup()
    importer.importMalList.mockResolvedValue(answer([rawEntry(21)]) as never)

    await collection.initCollection()
    // Своя правка новее любой записи без метки: спор о полях за нами.
    collection.putEntry(
      entry(21, { progress: 11, updatedAt: 5000, malId: null }) as never,
    )

    const done = await collection.pullFromMalFile('<xml/>', 'merge')

    expect(done.kept).toBe(1)
    expect(done.updated).toBe(0)
    const mine = collection.getEntry(21)
    expect(mine?.progress).toBe(11)
    // Пустые места добираются из файла: номер MAL и дата старта.
    expect(mine?.malId).toBe(21)
    expect(mine?.startedAt).toBe('2025-03-04')
  })

  it('запись с меткой свежее своей выигрывает спор о полях', async () => {
    const { collection, importer } = await setup()
    importer.importMalList.mockResolvedValue(
      answer([rawEntry(22, { progress: 12, updatedAt: 6000 })]) as never,
    )

    await collection.initCollection()
    collection.putEntry(entry(22, { progress: 3, updatedAt: 1000 }) as never)

    const done = await collection.pullFromMalFile('<xml/>', 'merge')

    expect(done.updated).toBe(1)
    expect(collection.getEntry(22)?.progress).toBe(12)
  })

  it('замещение вычищает всё, чего в файле нет', async () => {
    const { collection, importer } = await setup()
    importer.importMalList.mockResolvedValue(answer([rawEntry(31)]) as never)

    await collection.initCollection()
    collection.putEntry(entry(31, { progress: 3, updatedAt: 9000 }) as never)
    collection.putEntry(entry(99, { progress: 1, updatedAt: 9000 }) as never)

    const done = await collection.pullFromMalFile('<xml/>', 'replace')

    expect(done.mode).toBe('replace')
    expect(done.total).toBe(1)
    expect(collection.getEntry(99)).toBeUndefined()
    expect(collection.getEntry(31)?.progress).toBe(12)
  })

  it('счёт прочитанного и потерянного долетает до человека', async () => {
    const { collection, importer } = await setup()
    importer.importMalList.mockResolvedValue(
      answer([rawEntry(41), rawEntry(42)], {
        read: 3,
        matched: 2,
        lost: 1,
        lostTitles: ['Без пары'],
      }) as never,
    )

    await collection.initCollection()
    const done = await collection.pullFromMalFile('<xml/>', 'merge')

    expect(done.read).toBe(3)
    expect(done.matched).toBe(2)
    expect(done.lost).toBe(1)
    expect(done.lostTitles).toEqual(['Без пары'])
  })

  it('строка файла едет в источник как есть: разбор не дело коллекции', async () => {
    const { collection, importer } = await setup()
    importer.importMalList.mockResolvedValue(answer([]) as never)

    await collection.initCollection()
    await collection.pullFromMalFile('<myanimelist/>', 'merge')

    expect(importer.importMalList).toHaveBeenCalledWith('<myanimelist/>')
  })
})
