// Проверки разбора ответа AnimeThemes. Источник переехал с JSON:API на GraphQL, и разбор переписан
// целиком.

import { beforeEach, describe, expect, it } from 'vitest'

import { installMockBridge, type MockBridgeHandle } from './mocks/bridge-module'

import { fetchMalThemes } from '../src/shared/api/animethemes'

/** Адрес обязан совпадать с тем, что в модуле: заглушка ищет ответ по строке. */
const API_URL = 'https://graphql.animethemes.moe/'

/** Ответ сервиса: три опенинга, эндинг и вставная песня. Форма — как в живом ответе. */
function payload(): unknown {
  return {
    data: {
      findAnimeByExternalSite: [
        {
          animethemes: [
            {
              type: 'OP',
              slug: 'OP2',
              song: {
                title: { romaji: 'VIVID VICE' },
                performances: [{ artist: { name: { main: 'Who-ya Extended' } } }],
                resources: {
                  nodes: [{ site: 'SPOTIFY', link: 'https://open.spotify.com/track/vivid' }],
                },
              },
              animethemeentries: [
                { videos: { nodes: [{ audio: { link: 'https://a.animethemes.moe/OP2.ogg' } }] } },
              ],
            },
            {
              // Группа из четырёх участников: сервис присылает по строке на каждого.
              type: 'OP',
              slug: 'OP1',
              song: {
                title: { romaji: 'Seishun Complex' },
                performances: [
                  { artist: { name: { main: 'Kessoku Band' } } },
                  { artist: { name: { main: 'Kessoku Band' } } },
                  { artist: { name: { main: 'Kessoku Band' } } },
                  { artist: { name: { main: 'Kessoku Band' } } },
                ],
                resources: {
                  nodes: [
                    { site: 'YOUTUBE_MUSIC', link: 'https://music.youtube.com/watch?v=seishun' },
                    { site: 'YOUTUBE', link: 'https://youtube.com/watch?v=seishun' },
                    { site: 'ANIDB', link: 'https://anidb.net/song/1' },
                  ],
                },
              },
              animethemeentries: [
                {
                  videos: {
                    nodes: [
                      { audio: { link: 'https://a.animethemes.moe/OP1-NC.ogg' } },
                      { audio: { link: 'https://a.animethemes.moe/OP1.ogg' } },
                    ],
                  },
                },
              ],
            },
            {
              // Опенинг без номера: в новом API sequence у него пуст, а слаг — OP.
              type: 'OP',
              slug: 'OP',
              song: {
                title: { romaji: 'DREAM SOLISTER' },
                performances: [],
                resources: { nodes: [] },
              },
              animethemeentries: [
                { videos: { nodes: [{ audio: { link: 'https://a.animethemes.moe/OP.ogg' } }] } },
              ],
            },
            {
              type: 'ED',
              slug: 'ED1',
              song: {
                title: { romaji: 'Distortion!!' },
                performances: [{ artist: { name: { main: 'Kessoku Band' } } }],
                resources: { nodes: [] },
              },
              animethemeentries: [
                { videos: { nodes: [{ audio: { link: 'https://a.animethemes.moe/ED1.ogg' } }] } },
              ],
            },
            {
              // Вставная песня: в строке тем ей места нет.
              type: 'IN',
              slug: 'IN1',
              song: { title: { romaji: 'Insert' }, performances: [], resources: { nodes: [] } },
              animethemeentries: [],
            },
          ],
        },
      ],
    },
  }
}

/** Ответ с версиями заставок: дубляж (OP1-EN) и выпуск для другого региона (OP1-EN4Kids). Номер у
 * них тот же, что у самой заставки, песня — та же или другая. Так выглядит ответ по One Piece. */
function dubPayload(): unknown {
  const song = (title: string) => ({
    title: { romaji: title },
    performances: [],
    resources: { nodes: [] },
  })

  return {
    data: {
      findAnimeByExternalSite: [
        {
          animethemes: [
            { type: 'OP', slug: 'OP1', song: song('We Are!'), animethemeentries: [] },
            { type: 'OP', slug: 'OP1-EN', song: song('We Are!'), animethemeentries: [] },
            {
              type: 'OP',
              slug: 'OP1-EN4Kids',
              song: song('One Piece Theme'),
              animethemeentries: [],
            },
            { type: 'OP', slug: 'OP14', song: song('Fight Together'), animethemeentries: [] },
            { type: 'ED', slug: 'ED1', song: song('memories'), animethemeentries: [] },
            { type: 'ED', slug: 'ED1-EN', song: song('memories'), animethemeentries: [] },
          ],
        },
      ],
    },
  }
}

let mock: MockBridgeHandle

beforeEach(() => {
  mock = installMockBridge()
})

describe('темы AnimeThemes', () => {
  it('разбирает ответ GraphQL в опенинги и эндинги', async () => {
    mock.setHttpResponse(API_URL, payload())

    const themes = await fetchMalThemes(40748)

    expect(themes).not.toBeNull()
    // Вставная песня отсеяна, номера идут по возрастанию.
    expect(themes?.openings.map((t) => t.seq)).toEqual(['1', '1', '2'])
    expect(themes?.endings).toHaveLength(1)
  })

  it('свёртывает исполнителей группы в одно имя', async () => {
    mock.setHttpResponse(API_URL, payload())

    const themes = await fetchMalThemes(40749)
    const band = themes?.openings.find((t) => t.title === 'Seishun Complex')

    // Четыре строки performances — это одна группа с четырьмя участниками,
    // а не четыре исполнителя.
    expect(band?.artist).toBe('Kessoku Band')
  })

  it('берёт площадки по перечислению и пропускает каталоги', async () => {
    mock.setHttpResponse(API_URL, payload())

    const themes = await fetchMalThemes(40750)
    const band = themes?.openings.find((t) => t.title === 'Seishun Complex')
    const vivid = themes?.openings.find((t) => t.title === 'VIVID VICE')

    // YouTube Music занял ключ youtube, обычный YouTube в строку не попал,
    // ANIDB отсеян как каталог.
    expect(band?.links).toEqual([
      { site: 'youtube', label: 'YouTube Music', url: 'https://music.youtube.com/watch?v=seishun' },
    ])
    expect(vivid?.links).toEqual([
      { site: 'spotify', label: 'Spotify', url: 'https://open.spotify.com/track/vivid' },
    ])
  })

  it('берёт звук первой записи и номер из слага', async () => {
    mock.setHttpResponse(API_URL, payload())

    const themes = await fetchMalThemes(40751)
    const band = themes?.openings.find((t) => t.title === 'Seishun Complex')
    const dream = themes?.openings.find((t) => t.title === 'DREAM SOLISTER')

    // Первая дорожка записи, а не самая «полная» из них.
    expect(band?.audio).toBe('https://a.animethemes.moe/OP1-NC.ogg')
    // Слага OP хватает, чтобы номер стал единицей: sequence у такой темы пуст.
    expect(dream?.seq).toBe('1')
  })

  it('шлёт POST с телом на адрес GraphQL', async () => {
    mock.setHttpResponse(API_URL, payload())

    await fetchMalThemes(40752)

    expect(mock.calls.http).toHaveLength(1)
    expect(mock.calls.http[0]).toEqual({ url: API_URL, method: 'POST' })
  })

  it('отказ GraphQL при коде 200 не считается отсутствием тем', async () => {
    mock.setHttpResponse(API_URL, {
      errors: [{ message: 'Cannot query field "sequence" on type "AnimeTheme".' }],
    })

    // null, а не пустые списки: пустой ответ осел бы в кэше как «тем нет».
    await expect(fetchMalThemes(40753)).resolves.toBeNull()
  })

  it('пустой ответ сервиса — это отсутствие тем, а не отказ', async () => {
    mock.setHttpResponse(API_URL, { data: { findAnimeByExternalSite: [] } })

    await expect(fetchMalThemes(40754)).resolves.toEqual({ openings: [], endings: [] })
  })

  it('номер берётся из первой группы цифр слага', async () => {
    mock.setHttpResponse(API_URL, dubPayload())

    const themes = await fetchMalThemes(40755)
    const kids = themes?.openings.find((t) => t.title === 'One Piece Theme')
    const fourteen = themes?.openings.find((t) => t.title === 'Fight Together')

    // OP1-EN4Kids — первая заставка, а не четырнадцатая: цифры из суффикса
    // в номер не входят, иначе тема вставала бы на место настоящей OP14.
    expect(kids?.seq).toBe('1')
    expect(fourteen?.seq).toBe('14')
  })

  it('версия заставки не двоит песню в списке', async () => {
    mock.setHttpResponse(API_URL, dubPayload())

    const themes = await fetchMalThemes(40756)

    // Дубляж — та же песня под тем же номером, вторая строка лишняя.
    // «One Piece Theme» остаётся: номер у неё первый, но песня другая.
    expect(themes?.openings.map((t) => t.title)).toEqual([
      'We Are!',
      'One Piece Theme',
      'Fight Together',
    ])
    expect(themes?.endings.map((t) => t.title)).toEqual(['memories'])
  })

  it('без MAL ID запрос не отправляется', async () => {
    await expect(fetchMalThemes(null)).resolves.toBeNull()
    expect(mock.calls.http).toHaveLength(0)
  })
})
