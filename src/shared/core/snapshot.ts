// Снимок данных пользователя: то, что потерять нельзя; склад ответов сети расходен и живёт в db.ts.

import { Bridge } from '@/bridge'
import { Logger } from '../utils/logger'
import { serialWrite } from './store-chain'

/** Ключ хранилища моста. Приставка AM_ занята только нашими записями. */
const SNAPSHOT_KEY = 'AM_SNAPSHOT'

/** Имя файла дубля снимка; список разрешённых имён — в src-tauri/src/files.rs. */
const SNAPSHOT_FILE = 'animori-snapshot.json'

// Версия снимка: поднимать при любом изменении формы SnapshotEntry; миграций нет — старый снимок выбрасывается.
// 6 — убраны тип и тома (манги нет); malId добавлен без поднятия версии — поле необязательное.
export const SNAPSHOT_VERSION = 6

/** Задержка записи: прокрутка меняет снимок десятками правок в секунду, писать на каждую — дороже отрисовки. */
const SNAPSHOT_DELAY_MS = 2000

/** Запись списка в снимке. Картинки сюда не кладём: их даёт склад. */
export interface SnapshotEntry {
  mediaId: number
  /** Номер MAL или null; необязательное поле — старые снимки его не имеют, номер добудет датасет или сеть. */
  malId?: number | null
  status: string | null
  /** Оценка 0..10, как в остальном ядре. */
  score10: number
  /** Просмотренных серий. */
  progress: number
  /** Сколько раз пересматривали: счётчик завершённых кругов, отдельно от закладки. */
  repeat: number
  /** Даты ГГГГ-ММ-ДД строкой: календарный день без часов и пояса, миллисекунды сдвинули бы его на сутки. */
  startedAt: string | null
  completedAt: string | null
  /** Личный комментарий к записи. Хранится как есть, без обрезки и разметки. */
  notes: string | null
  /** Когда запись меняли у нас или на сервере. */
  updatedAt: number
  /** Взрослый тайтл: метка рядом с записью — отбор идёт по всему списку сразу и без сети. */
  isAdult: boolean
  /**
   * Названия латиницей и английское: склад расходен, а читаемость списка терять нельзя; русское — на складе.
   */
  romaji: string | null
  english: string | null
}

/**
 * Снимок целиком — одна запись, атомарность вместо транзакций; `userId` null значит «список местный».
 */
export interface UserSnapshot {
  version: number
  userId: number | null
  savedAt: number
  entries: SnapshotEntry[]
}

/** Поставщик снимка: собирает его из памяти в момент записи, а не заранее. */
type SnapshotSource = () => UserSnapshot

/** Единственный хозяин снимка. Второй пишущий гарантированно затрёт чужие правки. */
let source: SnapshotSource | null = null

/** Таймер отложенной записи снимка. */
let saveTimer: number | undefined

/** Повешены ли точки сохранения. Повторные подписки дали бы двойную запись. */
let hooksInstalled = false

/** Пустой снимок. Отдаётся вместо null: вызывающий код не проверяет каждый раз. */
export function emptySnapshot(): UserSnapshot {
  return { version: SNAPSHOT_VERSION, userId: null, savedAt: 0, entries: [] }
}

/** Годна ли запись списка: битые записи отбрасываются поштучно, а не всем снимком. */
function isEntry(value: unknown): value is SnapshotEntry {
  if (typeof value !== 'object' || value === null) return false

  const entry = value as Partial<SnapshotEntry>
  return typeof entry.mediaId === 'number' && Number.isFinite(entry.mediaId)
}

/** Строка или «нет значения». Пустая строка равносильна отсутствию названия. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Дата ГГГГ-ММ-ДД или null: форма проверяется строго — файл дубля мог быть правлен руками. */
function dateText(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null
}

/**
 * Приводит прочитанную запись к нынешней форме; поля перечислены явно: что не переписано здесь, на диск не попадёт.
 */
function normalizeEntry(entry: SnapshotEntry): SnapshotEntry {
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

/** Разбирает прочитанное в снимок; стороннее и битое отбрасывается: коллекция восстановима одним запросом. */
type ParsedSnapshot = { valid: boolean; snapshot: UserSnapshot }

function parseSnapshot(raw: unknown): ParsedSnapshot {
  if (typeof raw !== 'object' || raw === null) {
    return { valid: false, snapshot: emptySnapshot() }
  }

  const candidate = raw as Partial<UserSnapshot>
  if (candidate.version !== SNAPSHOT_VERSION) {
    if (typeof candidate.version === 'number') {
      Logger(
        'WARN',
        `Снимок версии ${candidate.version} не подходит к ${SNAPSHOT_VERSION} — читаем с нуля`,
      )
    }
    return { valid: false, snapshot: emptySnapshot() }
  }

  if (!Array.isArray(candidate.entries)) {
    return { valid: false, snapshot: emptySnapshot() }
  }

  const entries = candidate.entries.filter(isEntry).map(normalizeEntry)
  if (entries.length !== candidate.entries.length) {
    Logger('WARN', `Снимок: отброшено ${candidate.entries.length - entries.length} битых записей`)
  }

  return {
    valid: true,
    snapshot: {
      version: SNAPSHOT_VERSION,
      userId: typeof candidate.userId === 'number' ? candidate.userId : null,
      savedAt: typeof candidate.savedAt === 'number' ? candidate.savedAt : 0,
      entries,
    },
  }
}

/** Поднимает снимок из файла-дубля; отсутствие файла — штатный исход, а не сбой. */
async function readSnapshotFile(): Promise<UserSnapshot | null> {
  if (!Bridge.files.available) return null

  const raw = await Bridge.files.read(SNAPSHOT_FILE)
  if (!raw) return null

  try {
    const parsed = parseSnapshot(JSON.parse(raw))
    return parsed.valid ? parsed.snapshot : null
  } catch (e) {
    Logger('WARN', 'Снимок: дубль в файле не разобран', e)
    return null
  }
}

/** Кладёт второй экземпляр снимка в файл; ошибки — только в журнал: без дубля программа работает. */
async function writeSnapshotFile(payload: UserSnapshot): Promise<void> {
  if (!Bridge.files.available) return

  const ok = await Bridge.files.write(SNAPSHOT_FILE, JSON.stringify(payload))
  if (!ok) Logger('WARN', 'Снимок: дубль в файл не записан')
}

/** Читает снимок; никогда не отклоняется — пустой список лучше мёртвого запуска; записи старой версии забываются. */
export async function readSnapshot(): Promise<UserSnapshot> {
  try {
    const raw = await Bridge.storage.get<unknown>(SNAPSHOT_KEY)
    const parsed = parseSnapshot(raw)

    // Резерв используется только для отсутствующей или повреждённой записи.
    // Валидный пустой снимок означает осознанное удаление списка.
    if (!parsed.valid) {
      const backup = await readSnapshotFile()
      if (backup) {
        Logger('DB', `Снимок поднят из файла: записей ${backup.entries.length}`)
        // Сразу возвращаем в хранилище: иначе подъём повторится каждый запуск.
        try {
          await Bridge.storage.set(SNAPSHOT_KEY, backup)
        } catch (e) {
          Logger('WARN', 'Снимок: поднятый дубль не вернулся в хранилище', e)
        }
        return backup
      }
    }

    Logger('DB', `Снимок прочитан: записей ${parsed.snapshot.entries.length}`)
    return parsed.snapshot
  } catch (e) {
    Logger('ERROR', 'Снимок: ошибка чтения', e)
    const backup = await readSnapshotFile()
    if (backup) {
      Logger('DB', `Снимок поднят из файла после ошибки чтения: записей ${backup.entries.length}`)
      return backup
    }
    return emptySnapshot()
  }
}

/** Назначает хозяина снимка и вешает точки сохранения; повторный вызов игнорируется. */
export function ownSnapshot(next: SnapshotSource): void {
  if (source) {
    Logger('ERROR', 'Снимок: хозяин уже назначен, второй пишущий отклонён')
    return
  }

  source = next
  installSaveHooks()
}

/**
 * Планирует запись снимка: серия вызовов даёт одну запись; дубль в файл отложенная запись не делает.
 */
export function markSnapshotDirty(): void {
  if (!source) {
    Logger('WARN', 'Снимок: изменение без хозяина — записывать нечего')
    return
  }

  if (saveTimer !== undefined) return

  saveTimer = window.setTimeout(() => {
    saveTimer = undefined
    void saveSnapshotNow()
  }, SNAPSHOT_DELAY_MS)
}

/**
 * Пишет снимок немедленно и ждёт диск; отложенная отменяется. `backup` — писать ли дубль в файл.
 */
export async function saveSnapshotNow(options?: { backup?: boolean }): Promise<void> {
  if (saveTimer !== undefined) {
    window.clearTimeout(saveTimer)
    saveTimer = undefined
  }

  const collect = source
  if (!collect) return

  const withBackup = options?.backup === true

  // Сборка снимка синхронная: иначе между сбором и записью влезет правка.
  let payload: UserSnapshot
  try {
    payload = collect()
    payload.version = SNAPSHOT_VERSION
    payload.savedAt = Date.now()
  } catch (e) {
    Logger('ERROR', 'Снимок: хозяин не смог собрать данные', e)
    return
  }

  return serialWrite(async () => {
    try {
      await Bridge.storage.set(SNAPSHOT_KEY, payload)
      Logger('DB', `Снимок записан: записей ${payload.entries.length}`)
    } catch (e) {
      Logger('ERROR', 'Снимок: ошибка записи', e)
    }

    // Дубль после основной записи и внутри того же звена: порядок версий важен.
    if (withBackup) await writeSnapshotFile(payload)
  })
}

/** Две точки сохранения — уход в фон и закрытие окна; на Android уход в фон единственный шанс. */
function installSaveHooks(): void {
  if (hooksInstalled) return
  hooksInstalled = true

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void saveSnapshotNow({ backup: true })
  })

  // pagehide, а не beforeunload: в WebView и на мобилках второй часто не приходит вовсе.
  window.addEventListener('pagehide', () => {
    void saveSnapshotNow({ backup: true })
  })
}
