// Проверки выгрузки списка в XML экспорта MyAnimeList и обратного разбора (разборщик — настоящий DOMParser из happy-dom).
// Путь к модулю относительный: тест не должен зависеть от псевдонимов сборщика.

import { describe, expect, it } from 'vitest'

import {
  buildMalXml,
  malDate,
  malScore,
  malStatus,
  parseMalXml,
} from '../src/shared/core/mal-xml'

import type { SnapshotEntry } from '../src/shared/core/snapshot'

/** Запись со всеми полями на месте: тест меняет только то, что проверяет. */
function entry(over: Partial<SnapshotEntry> = {}): SnapshotEntry {
  return {
    mediaId: 1,
    malId: 100,
    status: 'CURRENT',
    score10: 0,
    progress: 0,
    repeat: 0,
    startedAt: null,
    completedAt: null,
    notes: null,
    updatedAt: 0,
    isAdult: false,
    romaji: 'Romaji Name',
    english: 'English Name',
    ...over,
  }
}

describe('malStatus', () => {
  it('переводит закладки в слова MAL', () => {
    expect(malStatus('CURRENT')).toBe('Watching')
    expect(malStatus('COMPLETED')).toBe('Completed')
    expect(malStatus('PAUSED')).toBe('On-Hold')
    expect(malStatus('DROPPED')).toBe('Dropped')
    expect(malStatus('PLANNING')).toBe('Plan to Watch')
  })

  it('сводит пересмотр к «Watching»: у MAL такой закладки нет', () => {
    expect(malStatus('REPEATING')).toBe('Watching')
  })

  it('незнакомую и пустую закладку считает отсутствием', () => {
    expect(malStatus('SOMETHING')).toBeNull()
    expect(malStatus('')).toBeNull()
    expect(malStatus(null)).toBeNull()
  })
})

describe('malScore', () => {
  it('округляет десятые до целого балла', () => {
    expect(malScore(7.5)).toBe(8)
    expect(malScore(7.4)).toBe(7)
    expect(malScore(10)).toBe(10)
  })

  it('держится в границах шкалы', () => {
    expect(malScore(0)).toBe(0)
    expect(malScore(-3)).toBe(0)
    expect(malScore(42)).toBe(10)
    expect(malScore(Number.NaN)).toBe(0)
  })
})

describe('malDate', () => {
  it('пропускает дату формы ГГГГ-ММ-ДД', () => {
    expect(malDate('2026-01-31')).toBe('2026-01-31')
  })

  it('отсутствие и обломки даты отдаёт пустой датой формата', () => {
    expect(malDate(null)).toBe('0000-00-00')
    expect(malDate('2026-01')).toBe('0000-00-00')
    expect(malDate('')).toBe('0000-00-00')
  })
})

describe('buildMalXml', () => {
  it('ставит шапку аниме и считает выгруженные записи', () => {
    const done = buildMalXml({
      entries: [entry({ mediaId: 1, malId: 5 }), entry({ mediaId: 2, malId: 7 })],
      userName: 'Роман',
    })

    expect(done.xml.startsWith('<?xml version="1.0" encoding="UTF-8" ?>\n')).toBe(true)
    expect(done.xml).toContain('<user_export_type>1</user_export_type>')
    expect(done.xml).toContain('<user_total_anime>2</user_total_anime>')
    expect(done.xml).toContain('<user_name><![CDATA[Роман]]></user_name>')
    expect(done.xml.trimEnd().endsWith('</myanimelist>')).toBe(true)
    expect(done.exported).toBe(2)
  })

  it('выгружает поля записи целиком', () => {
    const done = buildMalXml({
      entries: [
        entry({
          malId: 21,
          status: 'COMPLETED',
          score10: 8.5,
          progress: 12,
          repeat: 3,
          startedAt: '2025-03-04',
          completedAt: '2025-04-01',
          notes: 'отлично',
          english: 'One Piece',
        }),
      ],
    })

    expect(done.xml).toContain('<series_animedb_id>21</series_animedb_id>')
    expect(done.xml).toContain('<series_title><![CDATA[One Piece]]></series_title>')
    expect(done.xml).toContain('<my_watched_episodes>12</my_watched_episodes>')
    expect(done.xml).toContain('<my_start_date>2025-03-04</my_start_date>')
    expect(done.xml).toContain('<my_finish_date>2025-04-01</my_finish_date>')
    expect(done.xml).toContain('<my_score>9</my_score>')
    expect(done.xml).toContain('<my_status>Completed</my_status>')
    expect(done.xml).toContain('<my_times_watched>3</my_times_watched>')
    expect(done.xml).toContain('<my_comments><![CDATA[отлично]]></my_comments>')
    expect(done.xml).toContain('<update_on_import>1</update_on_import>')
  })

  it('числа серий тайтла не выдумывает: в снимке их нет', () => {
    const done = buildMalXml({ entries: [entry()] })
    expect(done.xml).not.toContain('<series_episodes>')
  })

  it('берёт ромадзи, когда английского имени нет', () => {
    const done = buildMalXml({ entries: [entry({ english: null })] })
    expect(done.xml).toContain('<series_title><![CDATA[Romaji Name]]></series_title>')
  })

  it('безымянную запись помечает номером, а не пустотой', () => {
    const done = buildMalXml({
      entries: [entry({ mediaId: 777, english: null, romaji: null })],
    })
    expect(done.xml).toContain('<series_title><![CDATA[Anime #777]]></series_title>')
  })

  it('записи без номера MAL отдаёт поимённо, а не пропускает молча', () => {
    const done = buildMalXml({
      entries: [
        entry({ mediaId: 1, malId: 11, english: 'Есть номер' }),
        entry({ mediaId: 2, malId: null, english: 'Без номера' }),
        entry({ mediaId: 3, malId: 0, english: 'Ноль тоже не номер' }),
      ],
    })

    expect(done.exported).toBe(1)
    expect(done.noMalId).toHaveLength(2)
    expect(done.noMalId).toContain('Без номера')
    expect(done.noMalId).toContain('Ноль тоже не номер')
    expect(done.xml).not.toContain('Без номера')
    expect(done.xml).toContain('<user_total_anime>1</user_total_anime>')
  })

  it('записи без закладки считает отдельно', () => {
    const done = buildMalXml({
      entries: [entry({ malId: 1 }), entry({ malId: 2, status: null })],
    })

    expect(done.exported).toBe(1)
    expect(done.noStatus).toBe(1)
    expect(done.noMalId).toHaveLength(0)
  })

  it('закрывающую скобку внутри заметки разрезает на два блока', () => {
    const done = buildMalXml({ entries: [entry({ notes: 'до]]>после' })] })

    expect(done.xml).toContain(
      '<my_comments><![CDATA[до]]]]><![CDATA[>после]]></my_comments>',
    )
  })

  it('пустая заметка остаётся пустым блоком', () => {
    const done = buildMalXml({ entries: [entry({ notes: null })] })
    expect(done.xml).toContain('<my_comments><![CDATA[]]></my_comments>')
  })

  it('кладёт записи по номеру MAL: две выгрузки одного списка совпадают', () => {
    const rows = [entry({ mediaId: 1, malId: 30 }), entry({ mediaId: 2, malId: 4 })]
    const straight = buildMalXml({ entries: rows })
    const flipped = buildMalXml({ entries: [...rows].reverse() })

    expect(straight.xml).toBe(flipped.xml)
    expect(straight.xml.indexOf('<series_animedb_id>4<')).toBeLessThan(
      straight.xml.indexOf('<series_animedb_id>30<'),
    )
  })

  it('на пустом списке даёт целый файл, а не обрывок', () => {
    const done = buildMalXml({ entries: [] })

    expect(done.exported).toBe(0)
    expect(done.xml).toContain('<user_total_anime>0</user_total_anime>')
    expect(done.xml).toContain('</myanimelist>')
    expect(done.xml).not.toContain('<anime>')
  })
})

describe('parseMalXml', () => {
  it('читает обратно свою же выгрузку, включая метку правки', () => {
    const built = buildMalXml({
      entries: [
        entry({
          malId: 21,
          status: 'COMPLETED',
          score10: 8,
          progress: 12,
          repeat: 3,
          startedAt: '2025-03-04',
          completedAt: '2025-04-01',
          notes: 'отлично',
          updatedAt: 1700000000000,
        }),
      ],
    })

    const got = parseMalXml(built.xml)

    expect(got.noId).toBe(0)
    expect(got.oddStatus).toEqual([])
    expect(got.rows).toEqual([
      {
        malId: 21,
        title: 'English Name',
        status: 'COMPLETED',
        score10: 8,
        progress: 12,
        repeat: 3,
        startedAt: '2025-03-04',
        completedAt: '2025-04-01',
        notes: 'отлично',
        updatedAt: 1700000000000,
      },
    ])
  })

  it('ест выгрузку Шикимори: без CDATA, без метки правки, со своим тегом', () => {
    // Обломок настоящего файла Шикимори: поля те же, что у MAL, но CDATA
    // нет, my_last_updated нет вовсе, а статус дублируется в shiki_status.
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<myanimelist>
  <myinfo>
    <user_id>331301</user_id>
    <user_name>foulnike</user_name>
    <user_export_type>1</user_export_type>
    <user_total_anime>1</user_total_anime>
  </myinfo>
  <anime>
    <series_animedb_id>21</series_animedb_id>
    <series_title>One Piece</series_title>
    <series_type></series_type>
    <series_episodes></series_episodes>
    <my_id>0</my_id>
    <my_watched_episodes>1100</my_watched_episodes>
    <my_start_date>0000-00-00</my_start_date>
    <my_finish_date>0000-00-00</my_finish_date>
    <my_rated></my_rated>
    <my_score>9</my_score>
    <my_storage></my_storage>
    <my_status>Watching</my_status>
    <shiki_status>watching</shiki_status>
    <my_comments/>
    <my_times_watched>0</my_times_watched>
    <my_rewatch_value></my_rewatch_value>
    <my_priority></my_priority>
    <my_tags></my_tags>
    <my_discuss>1</my_discuss>
    <update_on_import>1</update_on_import>
  </anime>
</myanimelist>`

    const got = parseMalXml(xml)

    expect(got.rows).toEqual([
      {
        malId: 21,
        title: 'One Piece',
        status: 'CURRENT',
        score10: 9,
        progress: 1100,
        repeat: 0,
        startedAt: null,
        completedAt: null,
        notes: null,
        updatedAt: 0,
      },
    ])
  })

  it('слова статуса читает без оглядки на регистр', () => {
    const xml = `<?xml version="1.0"?>
<myanimelist>
  <anime>
    <series_animedb_id>1</series_animedb_id>
    <series_title>A</series_title>
    <my_status>plan to watch</my_status>
  </anime>
  <anime>
    <series_animedb_id>2</series_animedb_id>
    <series_title>B</series_title>
    <my_status>On-Hold</my_status>
  </anime>
</myanimelist>`

    const got = parseMalXml(xml)

    expect(got.rows.map((row) => row.status)).toEqual(['PLANNING', 'PAUSED'])
  })

  it('незнакомое слово статуса не роняет запись, а называет вслух', () => {
    const xml = `<?xml version="1.0"?>
<myanimelist>
  <anime>
    <series_animedb_id>1</series_animedb_id>
    <series_title>A</series_title>
    <my_status>Rewatching</my_status>
  </anime>
  <anime>
    <series_animedb_id>2</series_animedb_id>
    <series_title>B</series_title>
    <my_status>rewatching</my_status>
  </anime>
</myanimelist>`

    const got = parseMalXml(xml)

    expect(got.rows.map((row) => row.status)).toEqual([null, null])
    // Одно слово — одна запись в счёте, но регистр не поправляем:
    // чужое слово человеку показывается как есть.
    expect(got.oddStatus).toEqual(['Rewatching', 'rewatching'])
  })

  it('записи без номера MAL пропускает и считает: ключ формата', () => {
    const xml = `<?xml version="1.0"?>
<myanimelist>
  <anime>
    <series_animedb_id>0</series_animedb_id>
    <series_title>Без номера</series_title>
    <my_status>Completed</my_status>
  </anime>
  <anime>
    <series_title>И вовсе без тега</series_title>
    <my_status>Completed</my_status>
  </anime>
</myanimelist>`

    const got = parseMalXml(xml)

    expect(got.rows).toEqual([])
    expect(got.noId).toBe(2)
  })

  it('битый файл и чужой корень отклоняет ошибкой, а не пустым списком', () => {
    expect(() => parseMalXml('это вовсе не xml')).toThrow()
    expect(() => parseMalXml('<html><body>привет</body></html>')).toThrow(/MyAnimeList/)
  })
})
