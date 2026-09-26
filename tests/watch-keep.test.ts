// Проверки памяти просмотра: метки остановки и история. История заведена отдельным списком, и у неё
// есть свойства, которые легко сломать молча — в этом и смысл проверок.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { MockBridgeHandle } from './mocks/bridge-module'

type Keep = typeof import('../src/app/screens/player-keep')

/** Ключ хранилища: тот же, что в модуле. */
const STORE_KEY = 'am_watch_marks'

const MEDIA = 21
const VOICE = 'aniliberty:9000'
const OTHER = 'kodik:735'

const COVER = 'https://img.example/cover.jpg'

let keep: Keep
let bridge: MockBridgeHandle

/** Снимок, который плеер отдаёт вместе с меткой. */
function what(title = 'Клеймор', cover: string | null = COVER) {
  return { title, cover, voiceLabel: 'AniLiberty' }
}

/** Откладывает управление на макрозадачу: дождаться отложенной записи. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(async () => {
  vi.resetModules()

  const mocks = await import('./mocks/bridge-module')
  bridge = mocks.installMockBridge()
  keep = await import('../src/app/screens/player-keep')
})

describe('разбор ключа места остановки', () => {
  it('возвращает те же части, из которых ключ собран', () => {
    const key = keep.spotKey(MEDIA, OTHER, 5)

    expect(keep.splitSpot(key)).toEqual({ mediaId: MEDIA, voiceKey: OTHER, episode: 5 })
  })

  it('не спотыкается о разделитель внутри ключа озвучки', () => {
    const key = keep.spotKey(7, 'kodik:735|extra', 12)

    expect(keep.splitSpot(key)).toEqual({ mediaId: 7, voiceKey: 'kodik:735|extra', episode: 12 })
  })

  it('отказывает там, где ключ собран не нами', () => {
    expect(keep.splitSpot('')).toBeNull()
    expect(keep.splitSpot('21')).toBeNull()
    expect(keep.splitSpot('21|voice')).toBeNull()
    expect(keep.splitSpot('21|voice|пять')).toBeNull()
  })
})

describe('история просмотра', () => {
  it('пишет просмотр с номером серии, заголовком и обложкой', async () => {
    await keep.whenWatchReady()
    keep.rememberSpot(keep.spotKey(MEDIA, VOICE, 5), 760, 1440, what())

    const rows = keep.peekHistory()

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      mediaId: MEDIA,
      voiceKey: VOICE,
      episode: 5,
      at: 760,
      full: 1440,
      title: 'Клеймор',
      cover: COVER,
      voiceLabel: 'AniLiberty',
    })

    // Первое касание и последнее совпадают у записи, сделанной в один заход.
    expect(rows[0]?.first).toBe(rows[0]?.when)
  })

  it('не считает просмотром заставку', async () => {
    await keep.whenWatchReady()
    keep.rememberSpot(keep.spotKey(MEDIA, VOICE, 5), 9, 1440, what())

    expect(keep.peekHistory()).toHaveLength(0)
    expect(keep.peekSpot(keep.spotKey(MEDIA, VOICE, 5))).toBe(0)
  })

  it('сводит озвучки одной серии в одну строку, оставляя свежую', async () => {
    await keep.whenWatchReady()

    keep.rememberSpot(keep.spotKey(MEDIA, VOICE, 5), 760, 1440, what())
    const first = keep.peekHistory()[0]?.first ?? 0

    // Другая озвучка той же серии и снимок без обложки.
    keep.rememberSpot(keep.spotKey(MEDIA, OTHER, 5), 300, 1440, what('Клеймор', null))

    const rows = keep.peekHistory()

    expect(rows).toHaveLength(1)
    expect(rows[0]?.voiceKey).toBe(OTHER)
    expect(rows[0]?.at).toBe(300)

    // Первое касание помнится, а обложка пустотой не затирается.
    expect(rows[0]?.first).toBe(first)
    expect(rows[0]?.cover).toBe(COVER)
  })

  it('ставит свежее вперёд', async () => {
    vi.useFakeTimers()

    try {
      await keep.whenWatchReady()

      vi.setSystemTime(new Date('2026-09-14T10:00:00'))
      keep.rememberSpot(keep.spotKey(MEDIA, VOICE, 5), 760, 1440, what())

      vi.setSystemTime(new Date('2026-09-16T20:00:00'))
      keep.rememberSpot(keep.spotKey(MEDIA, VOICE, 6), 100, 1440, what())

      expect(keep.peekHistory().map((row) => row.episode)).toEqual([6, 5])
    } finally {
      vi.useRealTimers()
    }
  })

  it('убирает одну серию, не трогая соседнюю', async () => {
    await keep.whenWatchReady()

    keep.rememberSpot(keep.spotKey(MEDIA, VOICE, 5), 760, 1440, what())
    keep.rememberSpot(keep.spotKey(MEDIA, VOICE, 6), 100, 1440, what())

    keep.forgetWatch(MEDIA, 5)

    expect(keep.peekHistory().map((row) => row.episode)).toEqual([6])
  })

  it('уносит и историю, и метки, но не выбор озвучки', async () => {
    await keep.whenWatchReady()

    const key = keep.spotKey(MEDIA, VOICE, 5)
    keep.rememberSpot(key, 760, 1440, what())
    keep.rememberPick(MEDIA, VOICE, 5, 1080)

    keep.wipeWatch()

    expect(keep.peekHistory()).toHaveLength(0)
    expect(keep.peekSpot(key)).toBe(0)
    expect(keep.peekPick(MEDIA)).toMatchObject({ voiceKey: VOICE, episode: 5, height: 1080 })
  })
})

describe('досмотренная серия', () => {
  it('встаёт в историю целой, а метка уходит', async () => {
    await keep.whenWatchReady()

    const key = keep.spotKey(MEDIA, VOICE, 5)
    keep.rememberSpot(key, 760, 1440, what())
    keep.finishSpot(key, 1440, what())

    expect(keep.peekSpot(key)).toBe(0)
    expect(keep.peekHistory()[0]).toMatchObject({ at: 1440, full: 1440 })
  })

  it('без известной длины остаётся без числа, а не с нулём вместо него', async () => {
    await keep.whenWatchReady()

    const key = keep.spotKey(MEDIA, VOICE, 5)
    keep.rememberSpot(key, 760, 1440, what())
    keep.finishSpot(key, 0, what())

    expect(keep.peekHistory()[0]).toMatchObject({ at: 0, full: 0 })
  })
})

describe('продолжение из истории', () => {
  it('делает запись нынешним выбором тайтла', async () => {
    await keep.whenWatchReady()

    keep.rememberSpot(keep.spotKey(MEDIA, VOICE, 7), 600, 1440, what())
    keep.rememberPick(MEDIA, OTHER, 3, 480)

    const row = keep.peekHistory()[0]
    expect(row).toBeDefined()
    if (row === undefined) return

    keep.resumeWatch(row)

    expect(keep.peekPick(MEDIA)).toMatchObject({ voiceKey: VOICE, episode: 7 })
  })

  it('переносит качество на ту же озвучку и не переносит на чужую', async () => {
    await keep.whenWatchReady()

    keep.rememberSpot(keep.spotKey(MEDIA, VOICE, 7), 600, 1440, what())
    keep.rememberPick(MEDIA, VOICE, 3, 1080)

    const mine = keep.peekHistory().find((row) => row.episode === 7)
    expect(mine).toBeDefined()
    if (mine === undefined) return

    keep.resumeWatch(mine)
    expect(keep.peekPick(MEDIA)?.height).toBe(1080)

    // Другая озвучка: у её дорожек свои высоты, и чужой выбор ей не подходит.
    keep.rememberSpot(keep.spotKey(MEDIA, OTHER, 8), 600, 1440, what())

    const alien = keep.peekHistory().find((row) => row.episode === 8)
    expect(alien).toBeDefined()
    if (alien === undefined) return

    keep.resumeWatch(alien)
    expect(keep.peekPick(MEDIA)?.voiceKey).toBe(OTHER)
    expect(keep.peekPick(MEDIA)?.height).toBe(0)
  })
})

describe('склад', () => {
  it('переживает запись, сделанную до появления истории', async () => {
    await bridge.bridge.storage.set(STORE_KEY, {
      marks: { '21|aniliberty:9000|5': { at: 300, full: 1440, when: 1 } },
      picks: {},
    })

    await keep.whenWatchReady()

    expect(keep.peekHistory()).toHaveLength(0)
    expect(keep.peekSpot('21|aniliberty:9000|5')).toBe(300)
  })

  it('выбрасывает запись истории без номера серии', async () => {
    await bridge.bridge.storage.set(STORE_KEY, {
      history: {
        '21|5': {
          mediaId: MEDIA,
          voiceKey: VOICE,
          episode: 5,
          at: 300,
          full: 1440,
          title: 'Клеймор',
          cover: null,
          voiceLabel: '',
          first: 5,
          when: 5,
        },
        '21|0': { mediaId: MEDIA, voiceKey: VOICE, episode: 0, at: 300, full: 1440, when: 6 },
      },
    })

    await keep.whenWatchReady()

    expect(keep.peekHistory().map((row) => row.episode)).toEqual([5])
  })

  it('уезжает на диск вместе с метками', async () => {
    await keep.whenWatchReady()

    keep.rememberSpot(keep.spotKey(MEDIA, VOICE, 5), 760, 1440, what())
    keep.flushWatchKeep()
    await settle()

    const last = bridge.calls.storageSet.at(-1)

    expect(last?.key).toBe(STORE_KEY)
    expect(Object.keys((last?.value as { history?: object }).history ?? {})).toEqual(['21|5'])
  })
})
