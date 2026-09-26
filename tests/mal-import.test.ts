// Проверки ввоза списка из файла выгрузки MyAnimeList (`api/mal-import`). Сеть подменена:
// сопоставление номеров MAL с AniList иначе пошло бы в интернет.

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/api/anilist-lookup', () => ({
  fetchBriefsByMal: vi.fn(),
}))

import { importMalList } from '@/api/mal-import'
import { fetchBriefsByMal } from '@/api/anilist-lookup'
import type { MediaBrief } from '@/api/anilist-media'

const mockedBriefs = vi.mocked(fetchBriefsByMal)

/** Выписка AniList: важны номер и пара полей, остальное не читается. */
function brief(malId: number, mediaId: number): MediaBrief {
  return {
    mediaId,
    malId,
    isAdult: false,
    romaji: `Romaji ${mediaId}`,
    english: null,
  } as unknown as MediaBrief
}

/** Файл выгрузки с заданными записями внутри. */
function file(...rows: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<myanimelist>
  <myinfo>
    <user_id>1</user_id>
    <user_name>t</user_name>
    <user_export_type>1</user_export_type>
    <user_total_anime>${rows.length}</user_total_anime>
  </myinfo>
${rows.join('\n')}
</myanimelist>`
}

/** Запись файла: меняем только то, что проверяет тест. */
function animeRow(malId: number, title: string, extra = ''): string {
  return `  <anime>
    <series_animedb_id>${malId}</series_animedb_id>
    <series_title>${title}</series_title>
    <my_watched_episodes>12</my_watched_episodes>
    <my_start_date>2025-03-04</my_start_date>
    <my_finish_date>0000-00-00</my_finish_date>
    <my_score>9</my_score>
    <my_status>Completed</my_status>
    <my_comments>текст</my_comments>
    <my_times_watched>1</my_times_watched>
    <update_on_import>1</update_on_import>
${extra}
  </anime>`
}

beforeEach(() => {
  mockedBriefs.mockReset()
})

describe('importMalList', () => {
  it('сводит записи с AniList по номеру MAL', async () => {
    mockedBriefs.mockResolvedValue([brief(21, 501)])

    const got = await importMalList(
      file(animeRow(21, 'One Piece', '    <my_last_updated>1700000000</my_last_updated>')),
    )

    expect(got.read).toBe(1)
    expect(got.matched).toBe(1)
    expect(got.lost).toBe(0)
    expect(got.entries).toEqual([
      {
        mediaId: 501,
        malId: 21,
        status: 'COMPLETED',
        score: 9,
        progress: 12,
        repeat: 1,
        startedAt: '2025-03-04',
        completedAt: null,
        notes: 'текст',
        updatedAt: 1700000000000,
        isAdult: false,
        romaji: 'Romaji 501',
        english: null,
      },
    ])
    expect(mockedBriefs).toHaveBeenCalledWith([21])
  })

  it('называет поимённо то, чему пары на AniList не нашлось', async () => {
    mockedBriefs.mockResolvedValue([brief(21, 501)])

    const got = await importMalList(
      file(animeRow(21, 'One Piece'), animeRow(999999, 'Странное'), animeRow(888888, '')),
    )

    expect(got.read).toBe(3)
    expect(got.matched).toBe(1)
    expect(got.lost).toBe(2)
    // Безымянная потеря не называется: пустая строка ничего не скажет.
    expect(got.lostTitles).toEqual(['Странное'])
    expect(got.entries).toHaveLength(1)
  })

  it('потерянных называет не больше восьми, но считает всех', async () => {
    mockedBriefs.mockResolvedValue([])

    const rows = Array.from({ length: 10 }, (_, i) => animeRow(100 + i, `Потеря ${i}`))
    const got = await importMalList(file(...rows))

    expect(got.lost).toBe(10)
    expect(got.lostTitles).toHaveLength(8)
  })

  it('повтор номера в файле сводит к последней строке', async () => {
    mockedBriefs.mockResolvedValue([brief(21, 501)])

    const got = await importMalList(
      file(
        animeRow(21, 'Старая строка').replace('<my_watched_episodes>12<', '<my_watched_episodes>3<'),
        animeRow(21, 'Свежая строка'),
      ),
    )

    expect(got.read).toBe(2)
    expect(got.entries).toHaveLength(1)
    expect(got.entries[0]?.progress).toBe(12)
    // Номер спрашивается однажды: пачка номеров без повторов.
    expect(mockedBriefs).toHaveBeenCalledWith([21])
  })

  it('пустой список не ходит в сеть вовсе', async () => {
    const got = await importMalList(file())

    expect(got.read).toBe(0)
    expect(got.entries).toEqual([])
    expect(mockedBriefs).not.toHaveBeenCalled()
  })

  it('битый файл не доходит до сети: разбор отказывает первым', async () => {
    await expect(importMalList('это не xml')).rejects.toThrow()
    expect(mockedBriefs).not.toHaveBeenCalled()
  })
})
