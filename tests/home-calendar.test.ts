// Проверки календаря выхода на Главной (app/screens/home-calendar): считать дни — работа, которая ломается тихо.
// Чистые помощники зовутся прямо (время местное: неделя по местным суткам); состояние модульное — каждый случай берёт модуль заново.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MediaBrief } from '@/api/anilist-media'
import type { PlayAsk } from '@/core/playable'

import { type MockBridgeHandle } from './mocks/bridge'

type Mocks = typeof import('./mocks/bridge-module')
type Calendar = typeof import('../src/app/screens/home-calendar')
type Titles = typeof import('@/core/media-title')
type Looks = typeof import('@/core/media-looks')

const GRAPHQL_URL = 'https://graphql.anilist.co'

/** Понедельник недели, вокруг которой идут проверки: 14 сентября 2026. */
const MONDAY = new Date(2026, 8, 14)

/** Среда той же недели — «сегодня» для большинства случаев. */
const WEDNESDAY = new Date(2026, 8, 16, 15, 4)

let cal: Calendar
let bridge: MockBridgeHandle
/** Модуль моста текущего поколения: из него берётся и класс ошибки. */
let mocks: Mocks
/** Знание о русских именах берётся оттуда же, откуда его берёт календарь. */
let titles: Titles
/** Облики — тоже: полка под полосой берёт обложку оттуда же, откуда экран. */
let looks: Looks

/** Местное время в миллисекундах. */
function at(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return new Date(year, month, day, hour, minute).getTime()
}

/** Срок выхода так, как его отдаёт сервер: в секундах. */
function secs(stamp: number): number {
  return Math.floor(stamp / 1000)
}

/** Выход так, как его держит разбор: срок в секундах, название с сервера. */
function airing(mediaId: number, episode: number, airingAt: number, romaji: string | null = null) {
  return { mediaId, episode, airingAt, romaji, english: null }
}

/**
 * Выписка тайтла так, как её держит облик. Поля, которых полке не нужно,
 * стоят пустыми: проверяется обложка, а не полнота выписки.
 */
function brief(mediaId: number, cover: string | null, color: string | null): MediaBrief {
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
    cover,
    color,
    airingEpisode: null,
    airingAt: null,
    ownEntry: null,
  }
}

/** Ответ сервера на запрос расписания. */
function schedule(rows: Array<ReturnType<typeof airing>>) {
  return {
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: {},
    text: JSON.stringify({
      data: {
        Page: {
          pageInfo: { hasNextPage: false },
          airingSchedules: rows.map((row) => ({
            mediaId: row.mediaId,
            episode: row.episode,
            airingAt: row.airingAt,
            media: row.romaji === null ? null : { title: { romaji: row.romaji, english: null } },
          })),
        },
      },
    }),
    url: GRAPHQL_URL,
  }
}

/** Ответ сервера на запрос верхушки идущих. */
function ongoing(ids: number[]) {
  return {
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: {},
    text: JSON.stringify({
      data: { Page: { pageInfo: { hasNextPage: false }, media: ids.map((id) => ({ id })) } },
    }),
    url: GRAPHQL_URL,
  }
}

/**
 * Ответ на запрос выписок (`fetchBriefsByIds`). Отличается от прочих тем,
 * что несёт обложку: по ней запрос и узнаётся в заглушке.
 */
function lookup(items: MediaBrief[]) {
  return {
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: {},
    text: JSON.stringify({
      data: {
        Page: {
          media: items.map((item) => ({
            id: item.mediaId,
            idMal: item.malId,
            format: item.format,
            status: item.status,
            episodes: item.episodes,
            seasonYear: item.seasonYear,
            averageScore: item.averageScore,
            isAdult: item.isAdult,
            title: { romaji: item.romaji, english: item.english, native: item.native },
            coverImage: { large: item.cover, medium: null, color: item.color },
          })),
        },
      },
    }),
    url: GRAPHQL_URL,
  }
}

/**
 * Ответ на запрос соответствий MAL (`fetchMalIds`). Отличается от прочих тем,
 * что несёт один `idMal` и ни одной обложки.
 */
function mal(rows: Array<{ id: number; idMal: number }>) {
  return {
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: {},
    text: JSON.stringify({ data: { Page: { media: rows } } }),
    url: GRAPHQL_URL,
  }
}

/** Пустой ответ на всё остальное: через тот же мост ходит добор имён,
 *  и без этой заглушки его запросы попадали бы в счёт «расписание». */
function blank() {
  return {
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: {},
    text: JSON.stringify({ data: {} }),
    url: GRAPHQL_URL,
  }
}

beforeEach(async () => {
  vi.resetModules()

  // Мост ставится в том же поколении реестра, что и проверяемый модуль:
  // иначе `@/bridge` внутри него окажется другим экземпляром.
  mocks = await import('./mocks/bridge-module')
  bridge = mocks.installMockBridge()
  cal = await import('../src/app/screens/home-calendar')
  titles = await import('@/core/media-title')
  looks = await import('@/core/media-looks')
})

afterEach(() => {
  vi.useRealTimers()

  // Подмена склада доступности снимается: подписка `vi.doMock` переживает
  // сброс реестра и досталась бы соседним случаям.
  vi.doUnmock('@/core/playable')
})

describe('счёт дней', () => {
  it('отрезает время суток, оставляя местную полночь', () => {
    expect(cal.dayStart(at(2026, 8, 16, 15, 4))).toBe(at(2026, 8, 16))
    expect(cal.dayStart(at(2026, 8, 16, 23, 59))).toBe(at(2026, 8, 16))
    expect(cal.dayStart(at(2026, 8, 16))).toBe(at(2026, 8, 16))
  })

  it('переходит через границу месяца и года по календарю', () => {
    expect(cal.addDays(at(2026, 8, 30), 1)).toBe(at(2026, 9, 1))
    expect(cal.addDays(at(2026, 11, 31), 1)).toBe(at(2027, 0, 1))
    expect(cal.addDays(at(2027, 0, 1), -1)).toBe(at(2026, 11, 31))
  })

  it('начинает неделю с понедельника для любого её дня', () => {
    const monday = at(2026, 8, 14)

    expect(cal.weekStart(monday)).toBe(monday)
    expect(cal.weekStart(at(2026, 8, 16, 15, 4))).toBe(monday)
    // Воскресенье — конец той же недели, а не начало следующей.
    expect(cal.weekStart(at(2026, 8, 20, 23, 59))).toBe(monday)
    // И понедельник следующей недели уже своя неделя.
    expect(cal.weekStart(at(2026, 8, 21))).toBe(at(2026, 8, 21))
  })
})

describe('подписи', () => {
  it('пишет час двумя цифрами и без двенадцатичасового вида', () => {
    expect(cal.hourText(at(2026, 8, 16, 9, 5))).toBe('09:05')
    expect(cal.hourText(at(2026, 8, 16, 19, 30))).toBe('19:30')
    expect(cal.hourText(at(2026, 8, 16, 0, 0))).toBe('00:00')
  })

  it('называет месяц один раз, пока неделя лежит в нём', () => {
    expect(cal.weekText(at(2026, 8, 14))).toBe('14 — 20 сентября')
  })

  it('называет оба месяца, если неделя их пересекает', () => {
    expect(cal.weekText(at(2026, 7, 31))).toBe('31 августа — 6 сентября')
  })

  it('добавляет годы, если неделя пересекает и их', () => {
    expect(cal.weekText(at(2026, 11, 28))).toBe('28 декабря 2026 — 3 января 2027')
  })
})

describe('раскладка недели', () => {
  it('строит семь дней, начиная с понедельника, даже пустых', () => {
    const days = cal.buildDays([], at(2026, 8, 14), at(2026, 8, 16))

    expect(days.map((day) => day.word)).toEqual(['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'])
    expect(days.map((day) => day.num)).toEqual(['14', '15', '16', '17', '18', '19', '20'])
    expect(days.every((day) => day.rows.length === 0)).toBe(true)
    expect(days[2]?.title).toBe('среда, 16 сентября')
  })

  it('раскладывает выходы по местным суткам и ставит их по времени', () => {
    const days = cal.buildDays(
      [
        airing(21, 1180, secs(at(2026, 8, 16, 19, 30))),
        airing(22, 5, secs(at(2026, 8, 16, 9, 5))),
        airing(23, 1, secs(at(2026, 8, 14, 12, 0))),
        airing(24, 2, secs(at(2026, 8, 20, 23, 0))),
      ],
      at(2026, 8, 14),
      at(2026, 8, 16),
    )

    expect(days[0]?.rows.map((row) => row.mediaId)).toEqual([23])
    // Внутри дня порядок по сроку, а не по порядку прихода с сервера.
    expect(days[2]?.rows.map((row) => row.time)).toEqual(['09:05', '19:30'])
    expect(days[2]?.rows.map((row) => row.episode)).toEqual([5, 1180])
    expect(days[6]?.rows.map((row) => row.time)).toEqual(['23:00'])
    expect(days[1]?.rows).toEqual([])
  })

  it('выбрасывает выходы за пределами показанной недели', () => {
    const days = cal.buildDays(
      [
        // Воскресенье той же недели и сразу следующий за ним понедельник.
        airing(21, 3, secs(at(2026, 8, 20, 23, 59))),
        airing(22, 4, secs(at(2026, 8, 21, 0, 1))),
      ],
      at(2026, 8, 14),
      at(2026, 8, 16),
    )

    expect(days.flatMap((day) => day.rows).map((row) => row.mediaId)).toEqual([21])
  })

  it('отмечает сегодняшний день и прошедшие', () => {
    const days = cal.buildDays([], at(2026, 8, 14), at(2026, 8, 16))

    expect(days.map((day) => day.today)).toEqual([false, false, true, false, false, false, false])
    expect(days.map((day) => day.past)).toEqual([true, true, false, false, false, false, false])
  })

  it('отделяет вышедшее от предстоящего по текущему мгновению', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 16, 15, 4))

    const days = cal.buildDays(
      [airing(21, 1180, secs(at(2026, 8, 16, 19, 30))), airing(22, 5, secs(at(2026, 8, 16, 9, 5)))],
      at(2026, 8, 14),
      at(2026, 8, 16),
    )

    expect(days[2]?.rows.map((row) => row.aired)).toEqual([true, false])
  })

  it('подписывает выход часом и серией, а вышедший — словом вместо часа', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 8, 16, 15, 4))

    const days = cal.buildDays(
      [airing(21, 1180, secs(at(2026, 8, 16, 19, 30))), airing(22, 5, secs(at(2026, 8, 16, 9, 5)))],
      at(2026, 8, 14),
      at(2026, 8, 16),
    )

    // Час у вышедшего не показывается нарочно: он уже ничего не решает,
    // а «вышла» отвечает на вопрос, ради которого в календарь и заходят.
    expect(days[2]?.rows.map((row) => row.facts)).toEqual(['вышла · серия 5', '19:30 · серия 1180'])
  })

  it('берёт обложку и цвет из облика, а без облика оставляет плитку буквой', () => {
    looks.rememberBrief(brief(21, 'https://cdn/21.jpg', '#112233'))

    const days = cal.buildDays(
      [airing(21, 5, secs(at(2026, 8, 16, 19, 30))), airing(22, 6, secs(at(2026, 8, 16, 20, 0)))],
      at(2026, 8, 14),
      at(2026, 8, 16),
    )

    const rows = days[2]?.rows ?? []

    expect(rows.map((row) => row.cover)).toEqual(['https://cdn/21.jpg', null])
    expect(rows.map((row) => row.color)).toEqual(['#112233', null])
  })

  it('подписывает выход номером тайтла, пока имени нет', () => {
    const days = cal.buildDays(
      [airing(21, 1179, secs(at(2026, 8, 16, 19, 30)))],
      at(2026, 8, 14),
      at(2026, 8, 16),
    )

    expect(days[2]?.rows[0]?.title).toBe('Аниме #21')
  })
})

describe('состояние недели', () => {
  it('до первой загрузки ничего не показывает', () => {
    const view = cal.useHomeCalendar()

    expect(view.days.value).toEqual([])
    expect(view.shown.value).toBeNull()
    expect(view.span.value).toBe('')
  })

  it('на пустом списке тайтлов рисует полосу, но в сеть не ходит', async () => {
    const query = vi.fn()
    bridge.bridge.anilist.query = query

    const view = cal.useHomeCalendar()
    await view.load([])

    expect(query).not.toHaveBeenCalled()
    expect(view.days.value).toHaveLength(7)
    expect(view.busy.value).toBe(false)
    expect(view.failed.value).toBe(false)
  })

  it('просит неделю с расширенным внутрь окном и раскладывает ответ', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(WEDNESDAY)

    let sent: { variables?: Record<string, unknown> } = {}
    bridge.bridge.anilist.query = async (body: string) => {
      const parsed = JSON.parse(body) as { query: string; variables: Record<string, unknown> }
      // Добор имён и обложек идёт тем же мостом и в те же миллисекунды, поэтому запоминается только
      // расписание: иначе `sent` достался бы от чужого запроса.
      if (!parsed.query.includes('airingSchedules')) return blank()

      sent = parsed
      return schedule([airing(21, 1179, secs(at(2026, 8, 16, 19, 30)))])
    }

    const view = cal.useHomeCalendar()
    await view.load([21, 22])

    const start = cal.weekStart(WEDNESDAY.getTime())

    // Границы у `airingAt_greater`/`airingAt_lesser` строгие, поэтому окно
    // расширено на секунду внутрь: серия ровно в полночь иначе не попадёт.
    expect(sent.variables?.from).toBe(Math.floor(start / 1000) - 1)
    expect(sent.variables?.to).toBe(Math.floor(cal.addDays(start, 7) / 1000) + 1)
    expect(sent.variables?.ids).toEqual([21, 22])

    expect(view.failed.value).toBe(false)
    expect(view.busy.value).toBe(false)
    expect(view.span.value).toBe('14 — 20 сентября')
    expect(view.shown.value?.word).toBe('Ср')
    expect(view.shown.value?.rows.map((row) => row.time)).toEqual(['19:30'])
  })

  it('показывает отказ транспорта, а не пустую неделю', async () => {
    bridge.bridge.anilist.query = async () => {
      throw new mocks.BridgeHttpError('network', GRAPHQL_URL)
    }

    const view = cal.useHomeCalendar()
    await view.load([21])

    expect(view.failed.value).toBe(true)
    expect(view.busy.value).toBe(false)
    // Полоса остаётся: дни — это календарь, а не данные с сервера.
    expect(view.days.value).toHaveLength(7)
  })

  it('отказ самого моста тоже попадает в отметку, а не в пустоту', async () => {
    // Не транспорт, а отказ моста: пропуск стёрли между проверкой и отправкой.
    bridge.bridge.anilist.query = async () => {
      throw new Error('мост отклонил запрос')
    }

    const view = cal.useHomeCalendar()
    await view.load([21])

    expect(view.failed.value).toBe(true)
    expect(view.busy.value).toBe(false)
    expect(view.days.value).toHaveLength(7)
  })

  it('выбор дня переживает перерисовку, а чужой ключ уводит на сегодня', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(WEDNESDAY)

    bridge.bridge.anilist.query = async () => schedule([])

    const view = cal.useHomeCalendar()
    await view.load([21])

    const friday = view.days.value[4]
    expect(friday).toBeDefined()

    view.pick(friday?.key ?? 0)
    expect(view.shown.value?.word).toBe('Пт')

    // Ключ из прошлой недели: пустой полосы быть не должно.
    view.pick(at(2026, 7, 10))
    expect(view.shown.value?.word).toBe('Ср')
  })
})

// Срок выхода от текущего мгновения, а не числом: выход с записанной датой попадал бы в показанный день один день в году.
// Часы настоящие: на замороженных ограничитель AniList ждёт свой промежуток бесконечно, а добор имён ходит тем же мостом.
describe('имя выхода', () => {
  it('берёт название сервера, когда русского имени нет', async () => {
    bridge.bridge.anilist.query = async () => schedule([airing(21, 1179, secs(Date.now()), 'One Piece')])

    const view = cal.useHomeCalendar()
    await view.load([21])

    expect(view.shown.value?.rows[0]?.title).toBe('One Piece')
  })

  it('ставит русское имя выше серверного', async () => {
    // Русское знание главнее: сервер отдаёт ромадзи, а человек читает русское.
    titles.rememberRussianName(21, 'Ван-Пис')

    bridge.bridge.anilist.query = async () => schedule([airing(21, 1179, secs(Date.now()), 'One Piece')])

    const view = cal.useHomeCalendar()
    await view.load([21])

    expect(view.shown.value?.rows[0]?.title).toBe('Ван-Пис')
  })

  it('падает на номер тайтла, когда имени нет нигде', async () => {
    bridge.bridge.anilist.query = async () =>
      schedule([airing(21, 1179, secs(Date.now()))])

    const view = cal.useHomeCalendar()
    await view.load([21])

    expect(view.shown.value?.rows[0]?.title).toBe('Аниме #21')
  })
})

describe('обложка выхода', () => {
  it('добирает обложку показанного дня и перерисовывает полку', async () => {
    // Часы настоящие нарочно: ограничитель AniList считает по Date.now(), и на замороженных второй запрос не ушёл бы.
    // Срок выхода — от текущего мгновения: так выход всегда попадает в показанный день.
    bridge.bridge.anilist.query = async (body: string) => {
      const { query } = JSON.parse(body) as { query: string }

      if (query.includes('airingSchedules')) {
        return schedule([airing(21, 5, secs(Date.now()))])
      }

      // Выписки — единственный запрос с обложкой в теле.
      if (query.includes('coverImage')) return lookup([brief(21, 'https://cdn/21.jpg', '#112233')])

      return blank()
    }

    const view = cal.useHomeCalendar()
    await view.load([21])

    // Расписание обложек не ждёт: полка встаёт сразу, а картинка приезжает
    // и перерисовывает её. Отсюда ожидание вместо мгновенной проверки.
    await vi.waitFor(() => expect(looks.peekLook(21)?.cover).toBe('https://cdn/21.jpg'), {
      timeout: 15000,
    })

    expect(view.shown.value?.rows[0]?.cover).toBe('https://cdn/21.jpg')
    expect(view.shown.value?.rows[0]?.color).toBe('#112233')
  }, 20000)
})

describe('метки доступности', () => {
  /** Поднимает модуль заново с перехваченной постановкой вопроса; подменяется только она:
   *  остальной склад настоящий и честно отвечает «не знаю» — склада в проверках нет. */
  async function withPlaySpy(): Promise<{ cal: Calendar; asked: PlayAsk[] }> {
    const asked: PlayAsk[] = []

    vi.doMock('@/core/playable', async (importOriginal) => {
      const real = await importOriginal<typeof import('@/core/playable')>()

      return {
        ...real,
        requestPlayable: (asks: readonly PlayAsk[]) => {
          asked.push(...asks)
          return asks.length
        },
      }
    })

    vi.resetModules()
    mocks = await import('./mocks/bridge-module')
    bridge = mocks.installMockBridge()

    return { cal: await import('../src/app/screens/home-calendar'), asked }
  }

  it('спрашивает источники о выходах дня и добывает для них номера MAL', async () => {
    const { cal: fresh, asked } = await withPlaySpy()

    bridge.bridge.anilist.query = async (body: string) => {
      const { query } = JSON.parse(body) as { query: string }

      if (query.includes('airingSchedules')) {
        return schedule([airing(21, 5, secs(Date.now()), 'One Piece')])
      }

      if (query.includes('idMal')) return mal([{ id: 21, idMal: 314 }])

      return blank()
    }

    const view = fresh.useHomeCalendar()
    await view.load([21])

    // Срок выхода берётся от текущего мгновения, поэтому выход всегда попадает
    // в показанный день. Часы настоящие: замороженные вешают ограничитель.
    await vi.waitFor(() => expect(asked).toHaveLength(1), { timeout: 15000 })

    // Номер MAL — не украшение: Kodik входит только по нему, и без номера
    // вопроса не будет вовсе, а метки не будет ни у кого.
    expect(asked[0]?.mediaId).toBe(21)
    expect(asked[0]?.malId).toBe(314)
    // Тайтл стоит в расписании, значит показ идёт: отказ по нему не вечен.
    expect(asked[0]?.airing).toBe(true)
    expect(asked[0]?.titles).toEqual(['One Piece'])
  }, 20000)

  it('на пустом дне за номерами MAL не ходит', async () => {
    const { cal: fresh } = await withPlaySpy()

    let schedules = 0
    let mals = 0

    bridge.bridge.anilist.query = async (body: string) => {
      const { query } = JSON.parse(body) as { query: string }

      if (query.includes('airingSchedules')) {
        schedules += 1
        return schedule([])
      }

      if (query.includes('idMal')) {
        mals += 1
        return mal([])
      }

      return blank()
    }

    const view = fresh.useHomeCalendar()
    await view.load([21])

    // Расписание спрошено, а за номерами дело не пошло: спрашивать не о ком.
    // Считаются запросы, а не вопросы: пустой день обязан не стоить ничего.
    expect(schedules).toBe(1)
    expect(mals).toBe(0)
  })
})

// Запас по времени здесь не от медлительности: ограничитель AniList держит
// две секунды между запросами, а первый в каждом случае уходит сразу.
describe('область показа', () => {
  it('начинает со своего', () => {
    expect(cal.useHomeCalendar().scope.value).toBe('mine')
  })

  it('в своём показе спрашивает расписание по переданным номерам', async () => {
    let sent: Record<string, unknown> = {}
    bridge.bridge.anilist.query = async (body: string) => {
      sent = (JSON.parse(body) as { variables: Record<string, unknown> }).variables
      return schedule([])
    }

    const view = cal.useHomeCalendar()
    await view.load([21, 22])

    expect(sent.ids).toEqual([21, 22])
    expect(view.scope.value).toBe('mine')
  })

  it('в глобальном сначала берёт верхушку идущих, потом расписание по ней', async () => {
    const asked: string[] = []
    let sent: Record<string, unknown> = {}

    bridge.bridge.anilist.query = async (body: string) => {
      const { query, variables } = JSON.parse(body) as {
        query: string
        variables: Record<string, unknown>
      }

      if (query.includes('RELEASING')) {
        asked.push('верхушка')
        return ongoing([21, 22])
      }

      if (!query.includes('airingSchedules')) return blank()

      asked.push('расписание')
      sent = variables
      return schedule([airing(21, 5, secs(Date.now()), 'One Piece')])
    }

    const view = cal.useHomeCalendar()
    await view.load([99])
    await view.setScope('popular', [99])

    expect(asked).toEqual(['расписание', 'верхушка', 'расписание'])
    // Свои номера в глобальном не участвуют: идут номера верхушки.
    expect(sent.ids).toEqual([21, 22])
    expect(view.scope.value).toBe('popular')
    expect(view.shown.value?.rows[0]?.title).toBe('One Piece')
  }, 20000)

  it('берёт верхушку один раз на сеанс', async () => {
    let tops = 0
    bridge.bridge.anilist.query = async (body: string) => {
      const { query } = JSON.parse(body) as { query: string }
      if (query.includes('RELEASING')) {
        tops += 1
        return ongoing([21])
      }
      return schedule([])
    }

    const view = cal.useHomeCalendar()
    await view.setScope('popular', [99])
    await view.setScope('mine', [99])
    await view.setScope('popular', [99])

    expect(tops).toBe(1)
  }, 30000)

  it('смена области не сдвигает выбранный день', async () => {
    // Часы здесь настоящие нарочно: ограничитель AniList считает время по `Date.now()`, и на
    // замороженных часах он ждёт свой промежуток бесконечно — проверка не падала бы, а висела.
    bridge.bridge.anilist.query = async (body: string) => {
      const { query } = JSON.parse(body) as { query: string }
      if (query.includes('RELEASING')) return ongoing([21])
      if (!query.includes('airingSchedules')) return blank()

      return schedule([airing(21, 5, secs(Date.now()), 'One Piece')])
    }

    const view = cal.useHomeCalendar()
    await view.load([21])

    const sunday = view.days.value[6]
    view.pick(sunday?.key ?? 0)
    expect(view.shown.value?.word).toBe('Вс')

    await view.setScope('popular', [21])

    // Человек смотрит на воскресенье и хочет увидеть то же воскресенье.
    expect(view.picked.value).toBe(sunday?.key)
    expect(view.shown.value?.word).toBe('Вс')
    // А наполнение при этом сменилось: новая неделя приехала.
    expect(view.days.value.flatMap((day) => day.rows)).toHaveLength(1)
  }, 20000)

  it('смена области убирает прежние строки сразу, не дожидаясь ответа', async () => {
    bridge.bridge.anilist.query = async (body: string) => {
      const { query } = JSON.parse(body) as { query: string }
      if (query.includes('RELEASING')) return ongoing([21])
      return schedule([airing(21, 5, secs(Date.now()), 'One Piece')])
    }

    const view = cal.useHomeCalendar()
    await view.load([21])
    expect(view.shown.value?.rows).toHaveLength(1)

    // Не ждём: строки прошлой области под новой подписью читались бы
    // как «переключатель не сработал».
    const pending = view.setScope('popular', [21])
    expect(view.days.value.flatMap((day) => day.rows)).toEqual([])
    expect(view.busy.value).toBe(true)

    await pending
    expect(view.shown.value?.rows).toHaveLength(1)
  }, 20000)

  it('повторный выбор той же области ничего не переспрашивает', async () => {
    let asked = 0
    bridge.bridge.anilist.query = async (body: string) => {
      const { query } = JSON.parse(body) as { query: string }
      if (!query.includes('airingSchedules')) return blank()

      asked += 1
      return schedule([airing(21, 5, secs(Date.now()), 'One Piece')])
    }

    const view = cal.useHomeCalendar()
    await view.load([21])

    const before = asked
    await view.setScope('mine', [21])

    expect(asked).toBe(before)
  })
})
