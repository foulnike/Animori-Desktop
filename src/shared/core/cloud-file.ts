// Формат облачной копии списка (этап 6): сборка текста копии и разбор пришедшего, без сети и диска.
// Лишние поля пришедшего файла отбрасываются — тем же приёмом, что у core/snapshot.ts.

import type { SnapshotEntry } from './snapshot'

/** Папка копии в облаке. Полный путь до неё строит сам провайдер. */
export const CLOUD_DIR = 'AniMori'

/** Имя файла копии. Одно и то же у всех провайдеров и на всех устройствах. */
export const CLOUD_FILE = 'animori-list.json'

/** Версия обёртки копии; за форму записей отвечает listVersion внутри файла. */
export const CLOUD_FORMAT = 1

/** Потолок размера копии — тот же, что у оболочки на запись файла (src-tauri/src/files.rs, export.rs). */
const MAX_TEXT_BYTES = 8 * 1024 * 1024

/** Длина метки устройства. Метка нужна человеку, а не программе. */
const MAX_DEVICE = 60

/** Копия целиком, одним файлом: половина копии хуже её отсутствия. */
export interface CloudFile {
  /** Версия обёртки: CLOUD_FORMAT на момент записи. */
  format: number
  /** SNAPSHOT_VERSION писавшей сборки; чужую версию не читаем — миграций схемы у снимка нет. */
  listVersion: number
  /** Когда копия собрана, в миллисекундах. */
  savedAt: number
  /** Чем собрана: «Windows», «ТВ». Свободный текст, читает его человек. */
  device: string
  /** Чей это список или null, если список местный. */
  userId: number | null
  /** Сколько записей в копии. Дубль длины entries: виден в файле без счёта. */
  count: number
  entries: SnapshotEntry[]
}

export interface CloudBuildInput {
  entries: SnapshotEntry[]
  /** SNAPSHOT_VERSION вызывающего: сюда его передают, а не импортируют. */
  listVersion: number
  userId?: number | null
  device?: string
  /** Метка времени. Задаётся только в тестах, обычно берётся Date.now(). */
  savedAt?: number
}

export interface CloudBuildResult {
  /** Готовый текст файла. Провайдеру уходит ровно эта строка. */
  text: string
  /** Размер текста в байтах: его показывают человеку и пишут в журнал. */
  bytes: number
  file: CloudFile
}

/** Исход разбора: отказ — не исключение, вызывающему нужен внятный текст для экрана. */
export type CloudParseResult =
  | { ok: true; file: CloudFile; dropped: number }
  | { ok: false; problem: string }

/** Строка или «нет значения». Пустая строка равносильна отсутствию. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Дата вида ГГГГ-ММ-ДД или null: копию могли править руками. */
function dateText(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/** Метка устройства: одна строка без краёв и без простыни. */
function device(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_DEVICE)
}

/** Годна ли запись: битую отбрасываем поштучно, а не всей копией. */
function isCloudEntry(value: unknown): value is SnapshotEntry {
  if (typeof value !== 'object' || value === null) return false

  const entry = value as Partial<SnapshotEntry>
  return typeof entry.mediaId === 'number' && Number.isFinite(entry.mediaId)
}

/**
 * Приводит запись к нынешней форме; список полей повторяет normalizeEntry из core/snapshot.ts.
 */
function cloudEntry(entry: SnapshotEntry): SnapshotEntry {
  return {
    mediaId: entry.mediaId,
    malId:
      typeof entry.malId === 'number' && Number.isFinite(entry.malId) && entry.malId > 0
        ? entry.malId
        : null,
    status: typeof entry.status === 'string' ? entry.status : null,
    score10: typeof entry.score10 === 'number' ? entry.score10 : 0,
    progress: typeof entry.progress === 'number' ? entry.progress : 0,
    repeat: typeof entry.repeat === 'number' ? entry.repeat : 0,
    startedAt: dateText(entry.startedAt),
    completedAt: dateText(entry.completedAt),
    notes: text(entry.notes),
    updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : 0,
    isAdult: entry.isAdult === true,
    romaji: text(entry.romaji),
    english: text(entry.english),
  }
}

/** По номеру тайтла: две копии одного списка обязаны совпадать до байта. */
function byMediaId(one: SnapshotEntry, two: SnapshotEntry): number {
  return one.mediaId - two.mediaId
}

/** Собирает текст копии: порядок закреплён, отступов нет. Отказ только на непомерном размере. */
export function buildCloudFile(input: CloudBuildInput): CloudBuildResult {
  const rows = input.entries.filter(isCloudEntry).map(cloudEntry)
  rows.sort(byMediaId)

  const file: CloudFile = {
    format: CLOUD_FORMAT,
    listVersion: input.listVersion,
    savedAt: typeof input.savedAt === 'number' ? input.savedAt : Date.now(),
    device: device(input.device),
    userId: typeof input.userId === 'number' ? input.userId : null,
    count: rows.length,
    entries: rows,
  }

  const body = JSON.stringify(file)
  const bytes = new TextEncoder().encode(body).length
  if (bytes > MAX_TEXT_BYTES) {
    throw new Error(`Копия списка слишком большая: ${bytes} байт`)
  }

  return { text: body, bytes, file }
}

/**
 * Разбирает пришедший файл; пустая копия — законный исход, право решает вызывающий.
 * `listVersion` — SNAPSHOT_VERSION нынешней сборки.
 */
export function parseCloudFile(source: string, listVersion: number): CloudParseResult {
  if (typeof source !== 'string' || source.trim() === '') {
    return { ok: false, problem: 'Файл копии пуст' }
  }

  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch {
    return { ok: false, problem: 'Файл копии не разобран: это не JSON' }
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, problem: 'Файл копии не похож на копию списка' }
  }

  const candidate = raw as Partial<CloudFile>

  if (candidate.format !== CLOUD_FORMAT) {
    const seen = typeof candidate.format === 'number' ? candidate.format : 'неизвестного'
    return {
      ok: false,
      problem: `Копия ${seen} формата: эта сборка знает формат ${CLOUD_FORMAT}`,
    }
  }

  if (candidate.listVersion !== listVersion) {
    const seen = typeof candidate.listVersion === 'number' ? candidate.listVersion : 'неизвестной'
    return {
      ok: false,
      problem: `Копия от версии списка ${seen}, а здесь версия ${listVersion}: приложить её нельзя`,
    }
  }

  if (!Array.isArray(candidate.entries)) {
    return { ok: false, problem: 'В копии нет списка записей' }
  }

  const rows = candidate.entries.filter(isCloudEntry).map(cloudEntry)
  rows.sort(byMediaId)

  return {
    ok: true,
    dropped: candidate.entries.length - rows.length,
    file: {
      format: CLOUD_FORMAT,
      listVersion,
      savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : 0,
      device: device(candidate.device),
      userId: typeof candidate.userId === 'number' ? candidate.userId : null,
      count: rows.length,
      entries: rows,
    },
  }
}
