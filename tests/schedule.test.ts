// Проверки запроса расписания выхода (`api/anilist-schedule`).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { type MockBridgeHandle } from './mocks/bridge'

/** Мост берётся заново на каждый случай: см. `beforeEach`. */
type Mocks = typeof import('./mocks/bridge-module')

const GRAPHQL_URL = 'https://graphql.anilist.co'

/** Окно и номера тайтлов: сами значения здесь не важны, важна их передача. */
const FROM = 1_800_000_000
const TO = 1_800_600_000
const IDS = [21, 22]

/** Ответ сервера: страница расписания. */
function page(rows: unknown[], hasNext = false) {
  return {
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: {},
    text: JSON.stringify({
      data: { Page: { pageInfo: { hasNextPage: hasNext }, airingSchedules: rows } },
    }),
    url: GRAPHQL_URL,
  }
}

/** Выход: серия одного тайтла в назначенный срок. `media` появляется и на одном лишь признаке 18+:
 * он живёт внутри того же объекта, что и название, и запись без названия. */
function airing(
  mediaId: number,
  episode: number,
  airingAt: number,
  romaji: string | null = null,
  english: string | null = null,
  isAdult = false,
) {
  const named = romaji !== null || english !== null
  return {
    mediaId,
    episode,
    airingAt,
    media: named || isAdult ? { isAdult, title: { romaji, english } } : null,
  }
}

/** Страница идущих тайтлов: для запроса верхушки популярности. */
function ongoing(ids: number[], hasNext = false) {
  return {
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: {},
    text: JSON.stringify({
      data: { Page: { pageInfo: { hasNextPage: hasNext }, media: ids.map((id) => ({ id })) } },
    }),
    url: GRAPHQL_URL,
  }
}

let bridge: MockBridgeHandle

// Мост ставится после `resetModules` и берётся из того же поколения реестра, что и проверяемый
// модуль.
beforeEach(async () => {
  vi.resetModules()

  const mocks: Mocks = await import('./mocks/bridge-module')
  bridge = mocks.installMockBridge()
})

describe('запрос расписания', () => {
  it('не ходит в сеть на пустом списке тайтлов', async () => {
    const query = vi.fn()
    bridge.bridge.anilist.query = query

    const { fetchAiringSchedules } = await import('@/api/anilist-schedule')
    expect(await fetchAiringSchedules([], FROM, TO)).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  it('не ходит в сеть, когда окно вывернуто наизнанку', async () => {
    const query = vi.fn()
    bridge.bridge.anilist.query = query

    const { fetchAiringSchedules } = await import('@/api/anilist-schedule')
    expect(await fetchAiringSchedules(IDS, TO, FROM)).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  it('спрашивает обычным списком и передаёт окно с номерами', async () => {
    let sent: { query?: string; variables?: Record<string, unknown> } = {}
    bridge.bridge.anilist.query = async (body: string) => {
      sent = JSON.parse(body) as typeof sent
      return page([])
    }

    const { fetchAiringSchedules } = await import('@/api/anilist-schedule')
    await fetchAiringSchedules(IDS, FROM, TO)

    // Ловушка первая: `nodes` внутри `airingSchedules` сервер не принимает.
    expect(sent.query).not.toContain('nodes')
    expect(sent.query).toContain('airingSchedules')
    expect(sent.query).toContain('airingAt_greater')
    expect(sent.query).toContain('airingAt_lesser')

    // Название запрашивается всегда: у чужого тайтла своих имён нет вовсе.
    expect(sent.query).toContain('romaji')
    expect(sent.query).toContain('english')

    // И метка 18+: календарь отбирает показ по ней, а облика у чужого нет.
    expect(sent.query).toContain('isAdult')

    expect(sent.variables).toMatchObject({ from: FROM, to: TO, ids: IDS, page: 1 })
  })

  it('собирает выходы, берёт название и отбрасывает записи без срока и без тайтла', async () => {
    bridge.bridge.anilist.query = async () =>
      page([
        airing(21, 1179, FROM + 100, 'Ван-Пис', 'One Piece'),
        // Служебная запись: срок нулевой, ставить её некуда.
        airing(21, 1180, 0),
        // Тайтл не назван — тоже мимо.
        airing(0, 3, FROM + 200),
        // Поля пришли не числами: чужой ответ, а не наша ошибка.
        { mediaId: '21', episode: '4', airingAt: String(FROM) },
        // Номер серии сервер не назвал — срок есть, строка годится.
        { mediaId: 22, episode: null, airingAt: FROM + 300 },
        // Название пришло пустым: пустая строка названием не считается.
        airing(23, 1, FROM + 400, '', null),
      ])

    const { fetchAiringSchedules } = await import('@/api/anilist-schedule')
    const out = await fetchAiringSchedules(IDS, FROM, TO)

    expect(out).toEqual([
      {
        mediaId: 21,
        episode: 1179,
        airingAt: FROM + 100,
        romaji: 'Ван-Пис',
        english: 'One Piece',
        isAdult: false,
      },
      { mediaId: 22, episode: 0, airingAt: FROM + 300, romaji: null, english: null, isAdult: false },
      { mediaId: 23, episode: 1, airingAt: FROM + 400, romaji: null, english: null, isAdult: false },
    ])
  })

  it('переносит метку 18+ и считает неизвестный признак безопасным', async () => {
    bridge.bridge.anilist.query = async () =>
      page([
        // Взрослая метка без названия: у чужого тайтла имён может и не быть.
        airing(31, 1, FROM + 100, null, null, true),
        // Признак не пришёл вовсе — считаем запись безобидной.
        { mediaId: 32, episode: 1, airingAt: FROM + 200, media: { title: { romaji: 'Тихий' } } },
        // Признак пришёл не булевым: чужой ответ, а не наша ошибка.
        { mediaId: 33, episode: 1, airingAt: FROM + 300, media: { isAdult: 'yes' } },
      ])

    const { fetchAiringSchedules } = await import('@/api/anilist-schedule')
    const out = await fetchAiringSchedules(IDS, FROM, TO)

    expect(out.map((entry) => [entry.mediaId, entry.isAdult])).toEqual([
      [31, true],
      [32, false],
      [33, false],
    ])
  })

  it('сводит повтор одной серии в одну строку, а две серии оставляет', async () => {
    bridge.bridge.anilist.query = async () =>
      page([
        airing(21, 1179, FROM + 100),
        // Тот же выход второй раз: ключ по тайтлу и сроку.
        airing(21, 1179, FROM + 100),
        // Другой срок — это уже другой выход, даже если номер серии тот же.
        airing(21, 1179, FROM + 900),
      ])

    const { fetchAiringSchedules } = await import('@/api/anilist-schedule')
    const out = await fetchAiringSchedules(IDS, FROM, TO)

    expect(out.map((entry) => entry.airingAt)).toEqual([FROM + 100, FROM + 900])
  })

  it('пустой ответ сервера не считается поломкой', async () => {
    bridge.bridge.anilist.query = async () => page([])

    const { fetchAiringSchedules } = await import('@/api/anilist-schedule')
    expect(await fetchAiringSchedules(IDS, FROM, TO)).toEqual([])
  })

  it('добирает вторую страницу и останавливается по слову сервера', async () => {
    const pages: number[] = []
    bridge.bridge.anilist.query = async (body: string) => {
      const { variables } = JSON.parse(body) as { variables: { page: number } }
      pages.push(variables.page)

      return variables.page === 1
        ? page([airing(21, 1179, FROM + 100)], true)
        : page([airing(22, 5, FROM + 200)], false)
    }

    const { fetchAiringSchedules } = await import('@/api/anilist-schedule')
    const out = await fetchAiringSchedules(IDS, FROM, TO)

    expect(pages).toEqual([1, 2])
    expect(out.map((entry) => entry.mediaId)).toEqual([21, 22])
  })
})

// Задержка внутри случаев ниже — не медленный тест, а честный темп AniList: ограничитель держит две
// секунды между запросами (окно 60 с на 30 запросов).
describe('верхушка идущих', () => {
  it('спрашивает идущие по популярности и отдаёт номера', async () => {
    let sent: { query?: string; variables?: Record<string, unknown> } = {}
    bridge.bridge.anilist.query = async (body: string) => {
      sent = JSON.parse(body) as typeof sent
      return ongoing([21, 22, 23])
    }

    const { fetchPopularOngoing } = await import('@/api/anilist-schedule')
    const out = await fetchPopularOngoing(3)

    expect(sent.query).toContain('RELEASING')
    expect(sent.query).toContain('POPULARITY_DESC')
    // Порядок ответа не пересобирается: популярность убывает, и первый — первый.
    expect(out).toEqual([21, 22, 23])
    expect(sent.variables).toEqual({ page: 1 })
  })

  it('не ходит в сеть, когда ничего не заказано', async () => {
    const query = vi.fn()
    bridge.bridge.anilist.query = query

    const { fetchPopularOngoing } = await import('@/api/anilist-schedule')
    expect(await fetchPopularOngoing(0)).toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  it('останавливается на заказанном числе, не вычитывая страницу целиком', async () => {
    bridge.bridge.anilist.query = async () => ongoing([1, 2, 3, 4, 5])

    const { fetchPopularOngoing } = await import('@/api/anilist-schedule')
    expect(await fetchPopularOngoing(2)).toEqual([1, 2])
  })

  it('отбрасывает номера-повторы', async () => {
    bridge.bridge.anilist.query = async () => ongoing([7, 7, 8])

    const { fetchPopularOngoing } = await import('@/api/anilist-schedule')
    expect(await fetchPopularOngoing(5)).toEqual([7, 8])
  })

  it('добирает страницы, пока не наберёт заказанное', async () => {
    const pages: number[] = []
    bridge.bridge.anilist.query = async (body: string) => {
      const { variables } = JSON.parse(body) as { variables: { page: number } }
      pages.push(variables.page)

      // Заказано больше страницы: второй заход обязан случиться.
      return variables.page === 1 ? ongoing([1, 2], true) : ongoing([3, 4], false)
    }

    const { fetchPopularOngoing } = await import('@/api/anilist-schedule')
    expect(await fetchPopularOngoing(51)).toEqual([1, 2, 3, 4])
    expect(pages).toEqual([1, 2])
  }, 15000)
})
