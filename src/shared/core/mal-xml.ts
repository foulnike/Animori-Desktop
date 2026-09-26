// Выгрузка списка в XML экспорта MyAnimeList и разбор такого же файла (его же отдаёт Шикимори):
// ключ формата — номер MAL; без номера запись выразить нечем и она возвращается поимённо.

import type { SnapshotEntry } from './snapshot'

/** Закладки AniList в слова MAL: пересмотра у MAL нет — он идёт как «Watching», число едет полем ниже. */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  CURRENT: 'Watching',
  REPEATING: 'Watching',
  COMPLETED: 'Completed',
  PAUSED: 'On-Hold',
  DROPPED: 'Dropped',
  PLANNING: 'Plan to Watch',
}

/** Пустая дата формата: именно так MAL обозначает «даты нет». */
const NO_DATE = '0000-00-00'

/** Дата снимка всегда ГГГГ-ММ-ДД; всё остальное считается отсутствием. */
const DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/

/** Что выгружаем и от чьего имени. */
export interface MalXmlInput {
  entries: Iterable<SnapshotEntry>
  /** Имя в шапке выгрузки. Импортеры его не читают, но формат его ждёт. */
  userName?: string
}

/** Итог выгрузки: сама строка и честный счёт того, что не уехало. */
export interface MalXmlResult {
  xml: string
  /** Сколько записей легло в выгрузку. */
  exported: number
  /** Названия записей без номера MAL: формат их выразить не может, они возвращаются поимённо. */
  noMalId: string[]
  /** Записей без закладки: в списке их нет, выгружать нечего. */
  noStatus: number
}

/** Заворачивает текст в CDATA; «]]>» внутри разрезается, иначе рвётся весь файл. */
function cdata(value: string): string {
  return `<![CDATA[${value.split(']]>').join(']]]]><![CDATA[>')}]]>`
}

/** Закладка словом MAL; незнакомая — отсутствие, иначе список на чужом сервисе лёг бы тихо не так. */
export function malStatus(status: string | null): string | null {
  if (status === null || status === '') return null
  return STATUS_WORDS[status] ?? null
}

/** Дата в виде формата или его же пустая дата. */
export function malDate(value: string | null): string {
  if (value === null || !DATE_SHAPE.test(value)) return NO_DATE
  return value
}

/** Оценка целым баллом 0..10: у MAL целые, десятые теряются — ограничение формата. */
export function malScore(score10: number): number {
  if (!Number.isFinite(score10) || score10 <= 0) return 0
  return Math.min(10, Math.max(0, Math.round(score10)))
}

/** Название для выгрузки. Сопоставление идёт по номеру, так что это для глаз. */
function titleOf(entry: SnapshotEntry): string {
  return entry.english ?? entry.romaji ?? `Anime #${entry.mediaId}`
}

/**
 * Собирает выгрузку; порядок — по номеру MAL, чтобы две выгрузки совпадали байт в байт; series_episodes не пишем.
 */
export function buildMalXml(input: MalXmlInput): MalXmlResult {
  const rows: SnapshotEntry[] = []
  const noMalId: string[] = []
  let noStatus = 0

  for (const entry of input.entries) {
    if (malStatus(entry.status) === null) {
      noStatus++
      continue
    }

    if (typeof entry.malId !== 'number' || entry.malId <= 0) {
      noMalId.push(titleOf(entry))
      continue
    }

    rows.push(entry)
  }

  rows.sort((a, b) => (a.malId ?? 0) - (b.malId ?? 0))
  noMalId.sort((a, b) => a.localeCompare(b, 'ru'))

  const parts: string[] = []
  parts.push('<?xml version="1.0" encoding="UTF-8" ?>')
  parts.push('<myanimelist>')
  parts.push('  <myinfo>')
  parts.push('    <user_id>0</user_id>')
  parts.push(`    <user_name>${cdata(input.userName ?? 'AniMori')}</user_name>`)
  // Единица значит «аниме». Двойка — манга, но её мы не ведём.
  parts.push('    <user_export_type>1</user_export_type>')
  parts.push(`    <user_total_anime>${rows.length}</user_total_anime>`)
  parts.push('  </myinfo>')

  for (const entry of rows) {
    const status = malStatus(entry.status)
    if (status === null) continue

    parts.push('  <anime>')
    parts.push(`    <series_animedb_id>${entry.malId ?? 0}</series_animedb_id>`)
    parts.push(`    <series_title>${cdata(titleOf(entry))}</series_title>`)
    parts.push(`    <my_watched_episodes>${Math.max(0, Math.round(entry.progress))}</my_watched_episodes>`)
    parts.push(`    <my_start_date>${malDate(entry.startedAt)}</my_start_date>`)
    parts.push(`    <my_finish_date>${malDate(entry.completedAt)}</my_finish_date>`)
    parts.push(`    <my_score>${malScore(entry.score10)}</my_score>`)
    parts.push(`    <my_status>${status}</my_status>`)
    parts.push(`    <my_times_watched>${Math.max(0, Math.round(entry.repeat))}</my_times_watched>`)
    parts.push(`    <my_comments>${cdata(entry.notes ?? '')}</my_comments>`)
    // Метка правки едет тоже: без неё обратный ввоз нашей же выгрузки счёл бы
    // записи старейшими, и слияние не подновило бы ими даже чужое свежее.
    if (entry.updatedAt > 0) {
      parts.push(`    <my_last_updated>${Math.floor(entry.updatedAt / 1000)}</my_last_updated>`)
    }
    // Без этого поля импортёр MAL пропускает уже известные ему записи
    // вместо того, чтобы подновить их нашими числами.
    parts.push('    <update_on_import>1</update_on_import>')
    parts.push('  </anime>')
  }

  parts.push('</myanimelist>')

  return {
    xml: `${parts.join('\n')}\n`,
    exported: rows.length,
    noMalId,
    noStatus,
  }
}

/** Имя файла с днём внутри: иначе папка загрузок копит пять файлов с одним именем. */
export function malXmlFileName(now: Date = new Date()): string {
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value))
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  return `animori-anime-${day}.xml`
}

/**
 * Слова MAL обратно в закладки; регистр в чужих выгрузках не договорён — сравнение строчными.
 * Незнакомое слово не теряет запись: статус уходит в null, само слово — в oddStatus.
 */
const STATUS_FROM_MAL: Readonly<Record<string, string>> = {
  watching: 'CURRENT',
  completed: 'COMPLETED',
  'on-hold': 'PAUSED',
  dropped: 'DROPPED',
  'plan to watch': 'PLANNING',
}

/** Одна запись чужого списка в наших словах. Номера AniList здесь ещё нет. */
export interface MalXmlRow {
  /** Номер MAL — ключ формата и мост к AniList. */
  malId: number
  /** Название из выгрузки: для весточки о потерях, не для показа. */
  title: string
  /** Закладка AniList или null при незнакомом слове статуса. */
  status: string | null
  /** Оценка по шкале 0..10. Ноль — «не оценено». */
  score10: number
  progress: number
  repeat: number
  startedAt: string | null
  completedAt: string | null
  notes: string | null
  /** Метка правки в миллисекундах; у выгрузки Шикимори её нет — тогда ноль, запись считается старейшей. */
  updatedAt: number
}

/** Итог разбора: записи и честный счёт того, что прочитать не удалось. */
export interface MalXmlList {
  rows: MalXmlRow[]
  /** Записей без номера MAL: ключ формата, без него запись не свести. */
  noId: number
  /** Незнакомые слова статуса, по одному разу каждое. */
  oddStatus: string[]
}

/** Текст тега записи; именно getElementsByTagName — подчёркивания в именах не всякий селектор терпит. */
function tagOf(el: Element, name: string): string {
  return el.getElementsByTagName(name)[0]?.textContent?.trim() ?? ''
}

/** Целое из текста тега: пусто и мусор читаются как ноль. */
function intOf(el: Element, name: string): number {
  const n = Number(tagOf(el, name))
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Дата ГГГГ-ММ-ДД или null. «0000-00-00» — тоже «даты нет», как при сборке. */
function dateOf(el: Element, name: string): string | null {
  const raw = tagOf(el, name)
  return DATE_SHAPE.test(raw) && raw !== NO_DATE ? raw : null
}

/**
 * Разворачивает CDATA в экранированный текст до разбора: разбор перестаёт зависеть от того, умеет ли разборщик.
 */
function uncdata(xml: string): string {
  return xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_all, text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  )
}

/**
 * Разбирает выгрузку MAL/Шикимори; битый файл и чужой корень — ошибка, а не пустой список.
 */
export function parseMalXml(xml: string): MalXmlList {
  const doc = new DOMParser().parseFromString(uncdata(xml), 'text/xml')

  if (doc.querySelector('parsererror') !== null) {
    throw new Error('Файл не читается как XML. Возможно, он испорчен или это не выгрузка списка.')
  }

  const root = doc.documentElement
  if (!root || root.tagName !== 'myanimelist') {
    throw new Error('Это не выгрузка MyAnimeList: в файле нет списка аниме.')
  }

  const rows: MalXmlRow[] = []
  const oddStatus: string[] = []
  let noId = 0

  for (const el of Array.from(root.getElementsByTagName('anime'))) {
    const malId = intOf(el, 'series_animedb_id')
    if (malId <= 0) {
      noId += 1
      continue
    }

    const statusWord = tagOf(el, 'my_status')
    const status = STATUS_FROM_MAL[statusWord.toLowerCase()] ?? null
    if (status === null && statusWord !== '' && !oddStatus.includes(statusWord)) {
      oddStatus.push(statusWord)
    }

    const notes = tagOf(el, 'my_comments')
    const stamp = Number(tagOf(el, 'my_last_updated'))

    rows.push({
      malId,
      title: tagOf(el, 'series_title'),
      status,
      score10: intOf(el, 'my_score'),
      progress: intOf(el, 'my_watched_episodes'),
      repeat: intOf(el, 'my_times_watched'),
      startedAt: dateOf(el, 'my_start_date'),
      completedAt: dateOf(el, 'my_finish_date'),
      notes: notes === '' ? null : notes,
      updatedAt: Number.isFinite(stamp) && stamp > 0 ? Math.floor(stamp) * 1000 : 0,
    })
  }

  return { rows, noId, oddStatus }
}

