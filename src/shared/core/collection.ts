// Хозяин коллекции: единственный источник правды о списке. Правки живут здесь, на сервер не уезжают.
// Перенос из трёх источников (AniList, Шикимори, файл MAL) идёт через одни слияние и замещение.

import { fetchUserList, fetchViewer, type RawListEntry } from '../api/anilist-list'
import { importMalList } from '../api/mal-import'
import { importShikiList } from '../api/shikimori-list'
import { Logger } from '../utils/logger'
import {
  emptySnapshot,
  markSnapshotDirty,
  ownSnapshot,
  readSnapshot,
  saveSnapshotNow,
  SNAPSHOT_VERSION,
  type SnapshotEntry,
  type UserSnapshot,
} from './snapshot'

/** Что правится в записи; незнакомый вид должен ломать сборку. Томов нет: ушли с мангой. */
export type EditKind =
  | 'status'
  | 'score'
  | 'progress'
  | 'repeat'
  | 'startedAt'
  | 'completedAt'
  | 'notes'
  | 'remove'

/** Облик тайтла с экрана: имя и метка 18+, которых запись о себе не знает. */
export type EntryLook = {
  romaji: string | null
  english: string | null
  isAdult: boolean
}

/**
 * Как переносить: merge — слияние по времени правки, replace — память вычищается целиком.
 */
export type PullMode = 'merge' | 'replace'

/** Итог переноса; числа раздельные — важен вопрос «не потерялось ли набранное здесь». */
export interface PullResult {
  /** Каким способом перенос в итоге прошёл. Смена счёта его меняет сама. */
  mode: PullMode
  /** Записей в памяти после переноса. */
  total: number
  /** Приехало с сервера впервые. */
  added: number
  /** Ответ сервера оказался свежее нашего и заменил запись. */
  updated: number
  /** Наша правка оказалась свежее ответа и осталась на месте. */
  kept: number
  /** Записей, которых на сервере нет вовсе: добавленные здесь. */
  onlyHere: number
}

/** Итог переноса с Шикимори: read/matched/lost объясняют разницу «было 500 → переехало 480». */
export interface ShikiPullResult extends PullResult {
  /** Ник в том виде, в каком его пишет сам Шикимори. */
  nick: string
  /** Сколько закладок отдал Шикимори. */
  read: number
  /** Сколько из них привязалось к номерам AniList и доехало до памяти. */
  matched: number
  /** Сколько осталось без пары. */
  lost: number
  /** Названия потерянного, несколько штук для разговора с человеком. */
  lostTitles: string[]
  /** Сколько записей получило дату просмотра (из журнала Шикимори). Ноль — не поломка. */
  dated: number
}

/** Записи по номеру тайтла: словарь — обход тысяч записей на приставке виден глазом. */
const entries = new Map<number, SnapshotEntry>()

/** Чей список в памяти. null — местный (переноса не было или счёт отвязан); записи остаются живыми. */
let ownerUserId: number | null = null

/** Поднят ли снимок с диска. Повторный подъём затёр бы свежие правки. */
let loaded = false

/** Общее ожидание первого подъёма: экраны не получают временно пустую карту. */
let initInFlight: Promise<number> | null = null

/** Идущий перенос: второй вызов ждёт первый, а не шлёт свой запрос. */
let refreshInFlight: Promise<PullResult> | null = null

/** Идущий перенос с Шикимори. Страж свой: чужой итог переноса с AniList соврал бы в числах. */
let shikiInFlight: Promise<ShikiPullResult> | null = null

/** Собирает снимок из памяти. Синхронно: хранилище ждёт готовый слепок. */
function collectSnapshot(): UserSnapshot {
  return {
    version: SNAPSHOT_VERSION,
    userId: ownerUserId,
    savedAt: Date.now(),
    entries: Array.from(entries.values()),
  }
}

/** Запись из ответа сервера в форму снимка (вид тайтла и тома снимок 6-й версии не хранит). */
function fromServer(raw: RawListEntry): SnapshotEntry {
  return {
    mediaId: raw.mediaId,
    malId: raw.malId,
    status: raw.status,
    score10: raw.score,
    progress: raw.progress,
    repeat: raw.repeat,
    startedAt: raw.startedAt,
    completedAt: raw.completedAt,
    notes: raw.notes,
    updatedAt: raw.updatedAt,
    isAdult: raw.isAdult,
    romaji: raw.romaji,
    english: raw.english,
  }
}

/** Пустая запись для правки неизвестного тайтла; поля явно: новое поле снимка ломает сборку здесь. */
export function blankEntry(mediaId: number, when: number, look?: EntryLook): SnapshotEntry {
  return {
    mediaId,
    malId: null,
    status: null,
    score10: 0,
    progress: 0,
    repeat: 0,
    startedAt: null,
    completedAt: null,
    notes: null,
    updatedAt: when,
    isAdult: look?.isAdult ?? false,
    romaji: look?.romaji ?? null,
    english: look?.english ?? null,
  }
}

/** Поднимает снимок с диска и берёт его под себя, один раз на старте. Идемпотентна. */
export async function initCollection(): Promise<number> {
  if (loaded) return entries.size
  if (initInFlight) return initInFlight

  initInFlight = (async () => {
    const snapshot = await readSnapshot()
    entries.clear()
    ownerUserId = snapshot.userId
    for (const entry of snapshot.entries) entries.set(entry.mediaId, entry)

    ownSnapshot(collectSnapshot)
    loaded = true
    Logger('DB', `Коллекция поднята из снимка: записей ${entries.size}`)

    return entries.size
  })()

  try {
    return await initInFlight
  } finally {
    initInFlight = null
  }
}

/**
 * Сливает ответ сервера с памятью; спор решает время правки, при равных метках побеждает сервер.
 * Записи вне ответа остаются: «добавлена здесь» от «удалена на сайте» не отличить.
 */
function mergeFromServer(raw: RawListEntry[]): PullResult {
  let added = 0
  let updated = 0
  let kept = 0
  const seen = new Set<number>()

  for (const item of raw) {
    seen.add(item.mediaId)
    const fresh = fromServer(item)
    const mine = entries.get(item.mediaId)

    if (!mine) {
      entries.set(item.mediaId, fresh)
      added++
      continue
    }

    if (mine.updatedAt > fresh.updatedAt) {
      // Спор выиграла наша правка, но пустоты дополняем: номер MAL нужен для выгрузки в XML,
      // даты приезжают только с Шикимори. Свою дату, поставленную руками, не затираем.
      if (mine.malId === null) mine.malId = fresh.malId
      if (mine.romaji === null) mine.romaji = fresh.romaji
      if (mine.english === null) mine.english = fresh.english
      if (mine.startedAt === null) mine.startedAt = fresh.startedAt
      if (mine.completedAt === null) mine.completedAt = fresh.completedAt
      kept++
      continue
    }

    entries.set(item.mediaId, fresh)
    updated++
  }

  let onlyHere = 0
  for (const mediaId of entries.keys()) if (!seen.has(mediaId)) onlyHere++

  return { mode: 'merge', total: entries.size, added, updated, kept, onlyHere }
}

/** Замещает память ответом сервера целиком; заодно уходят записи манги из старых снимков. */
function replaceFromServer(raw: RawListEntry[]): PullResult {
  entries.clear()
  for (const item of raw) entries.set(item.mediaId, fromServer(item))

  return {
    mode: 'replace',
    total: entries.size,
    added: entries.size,
    updated: 0,
    kept: 0,
    onlyHere: 0,
  }
}

/**
 * Перенос с сервера в память; по прямому действию человека. Без входа — отказ; идущий перенос переиспользуется.
 */
export async function refreshFromServer(mode: PullMode = 'merge'): Promise<PullResult> {
  if (refreshInFlight) return refreshInFlight

  refreshInFlight = (async () => {
    // Снимок под собой обязателен до переноса: без хозяина запись снимка молча ничего не делает.
    await initCollection()

    const viewer = await fetchViewer()
    if (!viewer) {
      throw new Error('Вход в AniList не выполнен: переносить список неоткуда')
    }

    // Сначала ответ, и только потом память: отказ сети иначе оставит пустоту вместо целого списка.
    const raw = await fetchUserList(viewer.id)

    // Чужой список сливать с нашим нельзя: смена счёта всегда замещает.
    let use = mode
    if (ownerUserId !== null && ownerUserId !== viewer.id) {
      use = 'replace'
      Logger('WARN', `Коллекция: вход сменился (${ownerUserId} → ${viewer.id}), память замещена`)
    }

    ownerUserId = viewer.id

    const done = use === 'replace' ? replaceFromServer(raw) : mergeFromServer(raw)

    // Перенос бывает редко и двигает список целиком — дубль в файл здесь уместен.
    await saveSnapshotNow({ backup: true })
    Logger(
      'DB',
      `Коллекция перенесена с сервера (${done.mode}): всего ${done.total}, ` +
        `новых ${done.added}, обновлено ${done.updated}, ` +
        `оставлено своих ${done.kept}, только здесь ${done.onlyHere}`,
    )

    return done
  })()

  try {
    return await refreshInFlight
  } finally {
    refreshInFlight = null
  }
}

/**
 * Перенос с Шикимори по нику; правила те же, что у AniList. Хозяин списка НЕ меняется: хозяин — счёт AniList.
 */
export async function pullFromShikimori(
  nick: string,
  mode: PullMode = 'merge',
): Promise<ShikiPullResult> {
  if (shikiInFlight) return shikiInFlight

  shikiInFlight = (async () => {
    await initCollection()

    // Сначала весь ответ целиком, потом память: обрыв на полпути не должен оставить половину чужого списка.
    const got = await importShikiList(nick)

    const done =
      mode === 'replace' ? replaceFromServer(got.entries) : mergeFromServer(got.entries)

    await saveSnapshotNow({ backup: true })
    Logger(
      'DB',
      `Коллекция перенесена с Шикимори (${done.mode}, ${got.user.nick}): ` +
        `всего ${done.total}, новых ${done.added}, обновлено ${done.updated}, ` +
        `оставлено своих ${done.kept}, без пары ${got.lost}, с датами ${got.dated}`,
    )

    return {
      ...done,
      nick: got.user.nick,
      read: got.read,
      matched: got.matched,
      lost: got.lost,
      lostTitles: got.lostTitles,
      dated: got.dated,
    }
  })()

  try {
    return await shikiInFlight
  } finally {
    shikiInFlight = null
  }
}

/** Итог переноса из файла MAL; dated нет: формат знает только две даты на запись. */
export interface MalPullResult extends PullResult {
  /** Сколько записей прочитано из файла. */
  read: number
  /** Сколько из них нашли пару на AniList. */
  matched: number
  /** Сколько записей не нашли пары на AniList. */
  lost: number
  /** Их названия из файла, первые восемь. */
  lostTitles: string[]
}

/** Защита от повторного переноса из файла, пока первый не кончился. */
let malInFlight: Promise<MalPullResult> | null = null

/**
 * Перенос из файла выгрузки MAL/Шикимори; хозяин не меняется. Без метки правки запись старше любой своей.
 */
export async function pullFromMalFile(xml: string, mode: PullMode = 'merge'): Promise<MalPullResult> {
  if (malInFlight) return malInFlight

  malInFlight = (async () => {
    await initCollection()

    // Сначала файл разобран и сведён с AniList, потом память: обрыв не должен оставить половину чужого списка.
    const got = await importMalList(xml)

    const done =
      mode === 'replace' ? replaceFromServer(got.entries) : mergeFromServer(got.entries)

    await saveSnapshotNow({ backup: true })
    Logger(
      'DB',
      `Коллекция перенесена из файла MAL (${done.mode}): ` +
        `всего ${done.total}, новых ${done.added}, обновлено ${done.updated}, ` +
        `оставлено своих ${done.kept}, без пары ${got.lost}`,
    )

    return { ...done, read: got.read, matched: got.matched, lost: got.lost, lostTitles: got.lostTitles }
  })()

  try {
    return await malInFlight
  } finally {
    malInFlight = null
  }
}

/** Запись по номеру тайтла или undefined. Копия не делается сознательно. */
export function getEntry(mediaId: number): SnapshotEntry | undefined {
  return entries.get(mediaId)
}

/** Сколько записей в памяти. Нужно экранам и инспектору настроек. */
export function entryCount(): number {
  return entries.size
}

/** Чей список сейчас в памяти. null значит «местный». */
export function currentUserId(): number | null {
  return ownerUserId
}

/** Перебор записей без копии массива. */
export function eachEntry(): IterableIterator<SnapshotEntry> {
  return entries.values()
}

/** Меняет запись в памяти и планирует запись снимка; на сервер правки не уезжают. */
export function putEntry(entry: SnapshotEntry): void {
  entries.set(entry.mediaId, entry)
  markSnapshotDirty()
}

/** Убирает запись из памяти. Отсутствие записи ошибкой не считается. */
export function dropEntry(mediaId: number): void {
  if (!entries.delete(mediaId)) return
  markSnapshotDirty()
}

/**
 * Единственная точка правки записи для экранов: синхронно, без входа и сети; пустая строка — «стереть».
 */
export function editEntry(
  mediaId: number,
  kind: EditKind,
  value: string | number | null,
  look?: EntryLook,
): void {
  if (!Number.isFinite(mediaId) || mediaId <= 0) return

  if (kind === 'remove') {
    dropEntry(mediaId)
    return
  }

  const known = entries.get(mediaId)
  const entry: SnapshotEntry = known ? { ...known } : blankEntry(mediaId, Date.now(), look)

  if (known && look) {
    if (entry.romaji === null) entry.romaji = look.romaji
    if (entry.english === null) entry.english = look.english
  }

  if (kind === 'status' && typeof value === 'string') entry.status = value
  if (kind === 'score' && typeof value === 'number') entry.score10 = value
  if (kind === 'progress' && typeof value === 'number') entry.progress = value
  if (kind === 'repeat' && typeof value === 'number') entry.repeat = value
  if (kind === 'startedAt' && typeof value === 'string') {
    entry.startedAt = value === '' ? null : value
  }
  if (kind === 'completedAt' && typeof value === 'string') {
    entry.completedAt = value === '' ? null : value
  }
  if (kind === 'notes' && typeof value === 'string') {
    entry.notes = value === '' ? null : value
  }

  // Метка правки — наши часы: по ней слияние решает спор с сервером, ставить обязательно.
  entry.updatedAt = Date.now()
  putEntry(entry)
}

/**
 * Отвязывает список от счёта AniList, записи остаются; снимок поднимается первым, иначе на диске остался бы прежний хозяин.
 */
export async function unlinkCollection(): Promise<number> {
  await initCollection()

  ownerUserId = null
  await saveSnapshotNow({ backup: true })

  Logger('DB', `Коллекция отвязана от счёта: записей ${entries.size}`)

  return entries.size
}

/**
 * Забывает список целиком по прямой просьбе хозяина (для выхода из счёта есть unlinkCollection); подъём первым делом.
 */
export async function forgetCollection(): Promise<void> {
  await initCollection()

  entries.clear()
  ownerUserId = null
  await saveSnapshotNow({ backup: true })
  Logger('DB', 'Коллекция забыта: снимок очищен')
}

/** Пустой снимок для проверок и первого запуска без входа. */
export function blankSnapshot(): UserSnapshot {
  return emptySnapshot()
}
