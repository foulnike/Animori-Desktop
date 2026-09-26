// Проверки хронологии франшизы (core/franchise): главное — полнота, ни одна запись AniList не пропадает.
// Каждый случай берёт модуль заново (vi.resetModules): память франшизы живёт между вызовами.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SHIKI_DOMAINS } from '@/core/constants'
import type { FranchiseWork } from '@/core/franchise'

const GRAPHQL_URL = 'https://graphql.anilist.co'

/** Адрес ответа берётся из списка зеркал: жёсткий домен в подмене ломался бы при каждой смене порядка. */
const SHIKI_HOST = SHIKI_DOMAINS[0] ?? 'shikimori.io'

/** ДжоДжо «Стальной шар»: у Шикимори часть одна (MAL 61469), AniList дробит её на этапы с общим номером MAL. */
const JOJO_NODES = [
  {
    id: 61469,
    name: 'Невероятное приключение ДжоДжо: Гонка «Стальной шар»',
    url: '/animes/61469-steel-ball-run-jojo-no-kimyou-na-bouken',
    year: 2026,
    kind: 'ONA',
    date: 1773867600,
  },
  {
    id: 48661,
    name: 'Невероятное приключение ДжоДжо: Каменный океан',
    url: '/animes/48661-jojo-no-kimyou-na-bouken-stone-ocean',
    year: 2021,
    kind: 'ONA',
    date: 1638316800,
  },
]

/** Первый этап: вышел, одна серия. */
const STAGE_1 = {
  id: 190327,
  idMal: 61469,
  type: 'ANIME',
  isAdult: false,
  status: 'FINISHED',
  startDate: { year: 2026, month: 3, day: 19 },
  title: { romaji: 'JoJo no Kimyou na Bouken: Steel Ball Run - 1st STAGE' },
  coverImage: { medium: null },
}

/** Второй с третьим: 11 серий, ещё не вышли. */
const STAGE_2 = {
  id: 210482,
  idMal: 61469,
  type: 'ANIME',
  isAdult: false,
  status: 'NOT_YET_RELEASED',
  startDate: { year: 2026, month: 9, day: 25 },
  title: { romaji: 'JoJo no Kimyou na Bouken: Steel Ball Run - 2nd - 3rd STAGE' },
  coverImage: { medium: null },
}

/** Соседняя часть: одна запись, раздробления нет. */
const STONE_OCEAN = {
  id: 131942,
  idMal: 48661,
  type: 'ANIME',
  isAdult: false,
  status: 'FINISHED',
  startDate: { year: 2021, month: 12, day: 1 },
  title: { romaji: 'JoJo no Kimyou na Bouken: Stone Ocean' },
  coverImage: { medium: null },
}

/**
 * «Карманы лета. Фильм» — случай хуже нашего: у Шикимори один узел, а у AniList
 * четыре записи. Это четыре отдельных фильма, выходивших по пятницам.
 */
const POCKETS_NODES = [
  {
    id: 61926,
    name: 'Карманы лета. Фильм',
    url: '/animes/61926-summer-pockets-movie',
    year: 2025,
    kind: 'Фильм',
    date: 1755205200,
  },
  {
    id: 50694,
    name: 'Карманы лета',
    url: '/animes/50694-summer-pockets',
    year: 2025,
    kind: 'TV Сериал',
    date: 1744232400,
  },
]

const POCKETS_TV = {
  id: 179871,
  idMal: 50694,
  type: 'ANIME',
  isAdult: false,
  status: 'FINISHED',
  startDate: { year: 2025, month: 4, day: 10 },
  title: { romaji: 'Summer Pockets' },
  coverImage: { medium: null },
}

function pocketFilm(id: number, month: number, day: number, romaji: string) {
  return {
    id,
    idMal: 61926,
    type: 'ANIME',
    isAdult: false,
    status: 'FINISHED',
    startDate: { year: 2025, month, day },
    title: { romaji },
    coverImage: { medium: null },
  }
}

/** Четыре фильма выходили по пятницам, по одному в неделю. */
const POCKETS_FILMS = [
  pocketFilm(195230, 8, 15, 'Summer Pockets: Kushima Kamome-hen'),
  pocketFilm(206609, 8, 22, 'Summer Pockets: Tsumugi Wenders-hen'),
  pocketFilm(206610, 8, 29, 'Summer Pockets: Sorakado Ao-hen'),
  pocketFilm(206611, 9, 5, 'Summer Pockets: Naruse Shiroha-hen'),
]

function franchiseReply(nodes: unknown[]) {
  return { text: JSON.stringify({ nodes }) }
}

function page(media: unknown[]) {
  return {
    status: 200,
    statusText: 'OK',
    ok: true,
    headers: {},
    text: JSON.stringify({ data: { Page: { media } } }),
    url: GRAPHQL_URL,
  }
}

/** Ставит обе подмены и отдаёт собранное дерево. */
async function tree(
  mediaId: number,
  media: unknown[],
  malId: number,
  nodes: unknown[],
): Promise<FranchiseWork[] | null> {
  vi.resetModules()

  const mocks = await import('./mocks/bridge-module')
  const mock = mocks.installMockBridge()
  mock.setHttpResponse(
    `https://${SHIKI_HOST}/api/animes/${malId}/franchise`,
    franchiseReply(nodes),
  )
  mock.bridge.anilist.query = async () => page(media)

  const { fetchFranchise } = await import('@/core/franchise')
  return await fetchFranchise(mediaId, malId)
}

/** Строки хронологии, пришедшиеся на один номер MAL. */
function stagesOf(works: FranchiseWork[] | null, malId: number): FranchiseWork[] {
  return (works ?? []).filter((work) => work.malId === malId)
}

/** Номера записей этих строк: по ним видно и состав, и порядок. */
function idsOf(works: FranchiseWork[] | null, malId: number): number[] {
  return stagesOf(works, malId).map((work) => work.mediaId)
}

describe('хронология франшизы: одному номеру MAL отвечают несколько записей', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('обе записи раздробленной части на месте', async () => {
    const works = await tree(190327, [STAGE_1, STAGE_2, STONE_OCEAN], 61469, JOJO_NODES)

    expect(idsOf(works, 61469)).toEqual([190327, 210482])
  })

  it('этапы идут по началу выпуска, а не по порядку ответа службы', async () => {
    const works = await tree(190327, [STAGE_2, STONE_OCEAN, STAGE_1], 61469, JOJO_NODES)

    expect(idsOf(works, 61469)).toEqual([190327, 210482])
  })

  it('строки различает хвост названия: общее начало срезано', async () => {
    const works = await tree(190327, [STAGE_1, STAGE_2, STONE_OCEAN], 61469, JOJO_NODES)

    expect(stagesOf(works, 61469).map((work) => work.stage)).toEqual([
      '1st STAGE',
      '2nd - 3rd STAGE',
    ])
  })

  it('у нераздробленной части хвоста нет', async () => {
    const works = await tree(190327, [STAGE_1, STONE_OCEAN], 61469, JOJO_NODES)

    expect(idsOf(works, 48661)).toEqual([131942])
    expect(stagesOf(works, 48661)[0]?.stage).toBeNull()
  })

  it('обе записи видны и с чужой карточки франшизы', async () => {
    // Текущий тайтл — «Каменный океан»: к части «Стального шара» он отношения
    // не имеет, и раньше в её строку попадала одна запись из двух.
    const works = await tree(131942, [STAGE_1, STAGE_2, STONE_OCEAN], 61469, JOJO_NODES)

    expect(idsOf(works, 61469)).toEqual([190327, 210482])
  })

  it('часть из четырёх записей показывается целиком', async () => {
    // Прежде здесь была одна строка из четырёх фильмов, и три из них нельзя
    // было открыть из карточки вовсе.
    const media = [...POCKETS_FILMS, POCKETS_TV]
    const works = await tree(195230, media, 61926, POCKETS_NODES)

    expect(idsOf(works, 61926)).toEqual([195230, 206609, 206610, 206611])
    expect(stagesOf(works, 61926).map((work) => work.stage)).toEqual([
      'Kushima Kamome-hen',
      'Tsumugi Wenders-hen',
      'Sorakado Ao-hen',
      'Naruse Shiroha-hen',
    ])
  })

  it('год строки берётся у записи, а не у узла Шикимори', async () => {
    const works = await tree(190327, [STAGE_1, STAGE_2, STONE_OCEAN], 61469, JOJO_NODES)

    expect(stagesOf(works, 61469).map((work) => work.year)).toEqual([2026, 2026])
  })
})
