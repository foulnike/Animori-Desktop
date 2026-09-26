// разбор в core/mal-xml.ts, здесь номера MAL сводятся с AniList через fetchBriefsByMal. У записей
// Шикимори updatedAt нулевой: при слиянии они старше любой своей правки.

import { Logger } from '../utils/logger'
import { parseMalXml } from '../core/mal-xml'
import type { RawListEntry } from './anilist-list'
import { fetchBriefsByMal } from './anilist-lookup'

/** Сколько названий потерянных тайтлов показать человеку: список на сто имён никто не читает. */
const LOST_NAMES = 8

/** Итог чтения файла: записи и честный счёт того, что не свёлось. */
export interface MalImport {
  /** Записи, готовые к слиянию или замещению. Порядок — как в файле. */
  entries: RawListEntry[]
  /** Сколько записей прочитано из файла (с номером MAL). */
  read: number
  /** Сколько из них нашлись у AniList. */
  matched: number
  /** Сколько записей не нашлись у AniList. */
  lost: number
  /** Их названия из файла, первые LOST_NAMES. */
  lostTitles: string[]
}

/**
 * Читает файл выгрузки MAL в записи списка. Отказ сети не маскируется: свести номера без AniList нельзя, а молча
 * вернуть пустой список значило бы обещать «потерь нет», когда потерян весь файл.
 */
export async function importMalList(xml: string): Promise<MalImport> {
  const parsed = parseMalXml(xml)

  // Повтор номера MAL в файле: свежая строка выигрывает, как свежая запись в слиянии.
  const rows = new Map<number, (typeof parsed.rows)[number]>()
  for (const row of parsed.rows) rows.set(row.malId, row)

  const wanted = [...rows.keys()]
  const briefs = wanted.length === 0 ? [] : await fetchBriefsByMal(wanted)

  const found = new Map<number, (typeof briefs)[number]>()
  for (const brief of briefs) if (brief.malId !== null) found.set(brief.malId, brief)

  const entries: RawListEntry[] = []
  const lostTitles: string[] = []
  let lost = 0

  for (const row of rows.values()) {
    const brief = found.get(row.malId)

    if (!brief) {
      // Тайтла нет у AniList либо связь с MAL не записана; молчать нельзя — считаем потерю.
      lost += 1
      if (row.title !== '' && lostTitles.length < LOST_NAMES) lostTitles.push(row.title)
      continue
    }

    entries.push({
      mediaId: brief.mediaId,
      malId: row.malId,
      status: row.status,
      score: row.score10,
      progress: row.progress,
      repeat: row.repeat,
      startedAt: row.startedAt,
      completedAt: row.completedAt,
      notes: row.notes,
      updatedAt: row.updatedAt,
      isAdult: brief.isAdult,
      romaji: brief.romaji,
      english: brief.english,
    })
  }

  if (parsed.noId > 0) {
    Logger('WARN', `Выгрузка MAL: записей без номера пропущено: ${parsed.noId}`)
  }
  if (parsed.oddStatus.length > 0) {
    Logger('WARN', `Выгрузка MAL: незнакомые статусы: ${parsed.oddStatus.join(', ')}`)
  }
  if (lost > 0) {
    Logger('LIST', `Выгрузка MAL: без пары на AniList ${lost} из ${parsed.rows.length}`)
  }

  return { entries, read: parsed.rows.length, matched: entries.length, lost, lostTitles }
}
