// Слой IndexedDB: склад карточек, MAL-соответствий и франшиз; сырой IDBDatabase наружу не отдаётся.

import { CACHE_TIME, DB_NAME, DB_VERSION } from './constants'
import { Logger } from '../utils/logger'
import type { CacheRecord, CacheStoreName, DbStats, DbStatsError } from './types'

/** Мигратор схемы; транзакция обновления нужна, чтобы переливать данные между сторами. */
type Migration = (db: IDBDatabase, tx: IDBTransaction | null) => void

/** Потолок ожидания открытия: всё, что дольше семи секунд, — зависание. */
const DB_OPEN_TIMEOUT_MS = 7000

let globalDbInstance: IDBDatabase | null = null

/** Промис незавершённого открытия: параллельные open() на холодном старте дают blocked самому на себя. */
let openInFlight: Promise<IDBDatabase | null> | null = null

/**
 * Миграции: ключ — версия, прогон идемпотентен; новая — поднять DB_VERSION и добавить `[N+1]`.
 */
const DB_MIGRATIONS: Record<number, Migration> = {
  5: (db) => {
    if (!db.objectStoreNames.contains('shikiCache'))
      db.createObjectStore('shikiCache', { keyPath: 'key' })
    if (!db.objectStoreNames.contains('malCache'))
      db.createObjectStore('malCache', { keyPath: 'id' })
    if (!db.objectStoreNames.contains('franchiseCache'))
      db.createObjectStore('franchiseCache', { keyPath: 'id' })
  },

  /**
   * Переименование склада: shikiCache -> mediaCache; сначала копия, потом удаление — потеря склада дорога.
   */
  6: (db, tx) => {
    if (!db.objectStoreNames.contains('mediaCache'))
      db.createObjectStore('mediaCache', { keyPath: 'key' })

    // Старого стора нет — переносить нечего.
    if (!db.objectStoreNames.contains('shikiCache')) return

    // Без транзакции обновления копировать нечем: старый стор остаётся, псевдоним смотрит в новый.
    if (!tx) {
      Logger('WARN', 'Миграция БД: нет транзакции обновления, перенос кэша пропущен')
      return
    }

    const from = tx.objectStore('shikiCache')
    const to = tx.objectStore('mediaCache')
    const cursorReq = from.openCursor()
    let moved = 0

    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (cursor) {
        to.put(cursor.value)
        moved++
        cursor.continue()
        return
      }

      // Копия готова целиком — теперь старый стор можно убирать.
      try {
        db.deleteObjectStore('shikiCache')
      } catch (e) {
        Logger('WARN', 'Миграция БД: старый стор не удалился, но копия уже на месте', e)
      }

      Logger('DB', `Миграция БД: в mediaCache перенесено записей — ${moved}`)
    }

    cursorReq.onerror = () => {
      // Старый стор намеренно остаётся: лишний стор в базе дешевле потерянного кэша.
      Logger('ERROR', 'Миграция БД: перенос кэша не удался', cursorReq.error)
    }
  },
}

/** Сторы, которые реально лежат в базе после шестой версии схемы. */
type PhysicalStore = 'mediaCache' | 'malCache' | 'franchiseCache'

/** Старое имя shikiCache — псевдоним mediaCache: вызовов dbGet/dbSet по приложению десятки. */
function physicalStore(store: CacheStoreName): PhysicalStore {
  return store === 'shikiCache' ? 'mediaCache' : store
}

/**
 * Смерть соединения: onversionchange отпускает старую версию, onclose убирает битый экземпляр из globalDbInstance.
 */
function attachConnectionHandlers(db: IDBDatabase): void {
  db.onversionchange = () => {
    Logger('WARN', 'IndexedDB: другое окно обновляет схему — закрываем соединение')
    try {
      db.close()
    } catch (e) {
      Logger('WARN', 'IndexedDB: сбой при закрытии соединения', e)
    }
    // Сравнение обязательно: там может лежать уже ДРУГОЕ, свежее соединение.
    if (globalDbInstance === db) globalDbInstance = null
  }

  db.onclose = () => {
    Logger('WARN', 'IndexedDB: соединение закрыто извне — следующее обращение переоткроет базу')
    if (globalDbInstance === db) globalDbInstance = null
  }
}

/**
 * Открывает базу с миграциями; null при сбое. Промис разрешается всегда: работа без кэша — медленно, но работа.
 */
export async function openDB(): Promise<IDBDatabase | null> {
  if (globalDbInstance) return globalDbInstance

  // Уже открываем — присоединяемся к тому же ожиданию вместо второго open().
  if (openInFlight) return openInFlight

  openInFlight = new Promise<IDBDatabase | null>((resolve) => {
    // Страж однократного завершения: сработать могут два исхода подряд (таймаут, следом onsuccess).
    let settled = false
    let timer: number | undefined

    const finish = (db: IDBDatabase | null): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) window.clearTimeout(timer)
      globalDbInstance = db
      resolve(db)
    }

    Logger('DB', 'Открытие подключения к IndexedDB...')

    let req: IDBOpenDBRequest
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION)
    } catch (e) {
      // Сам вызов бросает синхронно, например в приватном режиме.
      Logger('ERROR', 'IndexedDB недоступен: indexedDB.open бросил исключение', e)
      finish(null)
      return
    }

    // Страховка от любого непредусмотренного исхода: старт обязан продолжиться.
    timer = window.setTimeout(() => {
      Logger('ERROR', `IndexedDB не открылась за ${DB_OPEN_TIMEOUT_MS} мс — продолжаем без кэша`)
      finish(null)
    }, DB_OPEN_TIMEOUT_MS)

    req.onupgradeneeded = (e) => {
      const db = req.result
      const fromVersion = e.oldVersion || 0
      Logger('DB', `Миграция БД: ${fromVersion} → ${DB_VERSION}`)

      for (let v = fromVersion + 1; v <= DB_VERSION; v++) {
        const migrate = DB_MIGRATIONS[v]
        if (!migrate) continue
        try {
          // Транзакция обновления живёт только здесь: без неё шагу данные не перелить.
          migrate(db, req.transaction)
          Logger('DB', `Миграция БД: шаг ${v} выполнен успешно`)
        } catch (err) {
          Logger('ERROR', `Миграция БД: сбой на шаге ${v}`, err)
        }
      }
    }

    // finish() здесь НЕ вызывается: blocked приостанавливает запрос; соседняя вкладка отпустит соединение, придёт onsuccess.
    req.onblocked = () => {
      Logger(
        'WARN',
        'IndexedDB: открытие заблокировано другой вкладкой со старой версией схемы. ' +
          'Ждём освобождения; если не дождёмся — продолжим без кэша',
      )
    }

    req.onsuccess = () => {
      const db = req.result
      attachConnectionHandlers(db)

      if (settled) {
        // Промис уже разрешён в null по таймауту, но соединение годное: не бросаем его.
        globalDbInstance = db
        Logger('DB', 'IndexedDB открылась после таймаута — кэш снова доступен')
        return
      }

      finish(db)
    }

    req.onerror = () => {
      Logger('ERROR', 'Ошибка открытия IndexedDB', req.error)
      finish(null)
    }
  })

  const db = await openInFlight

  // Маркер снимается в любом случае: соседняя вкладка закроется, и база станет доступной.
  openInFlight = null

  return db
}

/**
 * Читает запись по ключу; старое `shikiCache` равносильно `mediaCache` (keyPath: `key` или `id`).
 */
export async function dbGet<T = unknown>(
  store: CacheStoreName,
  key: IDBValidKey,
): Promise<T | null> {
  const name = physicalStore(store)
  try {
    const db = await openDB()
    if (!db) return null

    return await new Promise<T | null>((resolve) => {
      const req = db.transaction(name, 'readonly').objectStore(name).get(key)
      req.onsuccess = () => resolve((req.result as T | undefined) ?? null)
      req.onerror = () => {
        Logger('ERROR', `Ошибка чтения DB (${name})`, key)
        resolve(null)
      }
    })
  } catch (e) {
    Logger('ERROR', `Сбой dbGet (${name})`, e)
    return null
  }
}

/** Пишет (put — вставка или перезапись) запись в object store. */
export async function dbSet(store: CacheStoreName, data: CacheRecord): Promise<void> {
  const name = physicalStore(store)
  try {
    const db = await openDB()
    if (!db) return

    return await new Promise<void>((resolve) => {
      const tx = db.transaction(name, 'readwrite')
      tx.objectStore(name).put(data)
      tx.oncomplete = () => {
        Logger('DB', `Запись в кэш ${name} успешна`)
        resolve()
      }
      tx.onerror = (e) => {
        Logger('ERROR', `Ошибка записи DB (${name})`, e)
        resolve()
      }
      tx.onabort = () => {
        Logger('ERROR', `Транзакция записи DB прервана (${name})`, tx.error)
        resolve()
      }
    })
  } catch (e) {
    Logger('ERROR', `Сбой dbSet (${name})`, e)
  }
}

/** Потолок ожидания удаления базы: зависшее соседнее соединение не должно держать кнопку настроек вечно. */
const DB_DROP_TIMEOUT_MS = 7000

/** Сброс кэша удалением базы целиком; исключение не бросается. */
export async function clearCache(): Promise<void> {
  Logger('INFO', 'Запущен ручной сброс кэша IndexedDB')
  const db = await openDB()
  if (!db) {
    Logger('ERROR', 'Сброс кэша не выполнен: база недоступна')
    return
  }

  // clear() по сторам не отдаёт место — LevelDB ждёт фоновой компакции, и счётчик после
  // чистки показывал больше, чем до. Удаляем базу целиком: пустая поднимется сама при openDB().
  // Обработчики сняты, чтобы своё закрытие не писало WARN «закрыто извне».
  db.onversionchange = null
  db.onclose = null
  db.close()
  globalDbInstance = null

  return new Promise<void>((resolve) => {
    // Страж однократного завершения: таймаут и onsuccess могут прийти подряд.
    let settled = false
    let timer: number | undefined

    const finish = (): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) window.clearTimeout(timer)
      resolve()
    }

    // Страховка, как у открытия: сброс обязан завершиться, даже если запрос завис.
    timer = window.setTimeout(() => {
      Logger('ERROR', `Сброс кэша: удаление базы не завершилось за ${DB_DROP_TIMEOUT_MS} мс`)
      finish()
    }, DB_DROP_TIMEOUT_MS)

    let req: IDBOpenDBRequest
    try {
      req = indexedDB.deleteDatabase(DB_NAME)
    } catch (e) {
      // Сам вызов бросает синхронно, например в приватном режиме.
      Logger('ERROR', 'Сброс кэша: indexedDB.deleteDatabase бросил исключение', e)
      finish()
      return
    }

    req.onsuccess = () => {
      Logger('DB', 'Сброс кэша: база IndexedDB удалена целиком')
      finish()
    }

    req.onerror = () => {
      Logger('ERROR', 'Сброс кэша: удаление базы завершилось ошибкой', req.error)
      finish()
    }

    // Удаление ждёт чужого открытого соединения; оно закроется по onversionchange
    // из attachConnectionHandlers, и запрос пойдёт дальше сам.
    req.onblocked = () => {
      Logger('WARN', 'Сброс кэша: удаление ждёт закрытия другого соединения с базой')
    }
  })
}

/** Фоновый GC: курсором по mediaCache удаляет записи старше CACHE_TIME; при бессрочном сроке выходит сразу. */
export async function runGarbageCollector(): Promise<void> {
  // Срока жизни у записей нет: чистит только clearCache() из настроек.
  if (!Number.isFinite(CACHE_TIME)) return

  try {
    const db = await openDB()
    if (!db) return

    const store = db.transaction(['mediaCache'], 'readwrite').objectStore('mediaCache')
    const req = store.openCursor()
    let deletedCount = 0

    req.onsuccess = () => {
      const cursor = req.result
      if (cursor) {
        const record = cursor.value as { ts?: number }
        if (typeof record.ts === 'number' && Date.now() - record.ts > CACHE_TIME) {
          cursor.delete()
          deletedCount++
        }
        cursor.continue()
      } else if (deletedCount > 0) {
        Logger('DB', `Garbage Collector очистил ${deletedCount} устаревших записей из кэша`)
      }
    }
  } catch (e) {
    Logger('ERROR', 'Ошибка Garbage Collector', e)
  }
}

/** Снимок БД: размер и счёт по типам ключей; зовётся по кнопке, не по таймеру. */
export async function getDbStats(): Promise<DbStats | DbStatsError> {
  try {
    const db = await openDB()
    if (!db) return { error: 'БД недоступна' }

    // Размер памяти — до открытия транзакции, иначе она успеет закрыться на await.
    let estimatedSize = 'Неизвестно'
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const est = await navigator.storage.estimate()
        estimatedSize = ((est.usage ?? 0) / 1024 / 1024).toFixed(2) + ' MB'
      }
    } catch (e) {
      Logger('WARN', 'getDbStats: navigator.storage.estimate() недоступен', e)
    }

    return await new Promise<DbStats | DbStatsError>((resolve) => {
      const tx = db.transaction(['mediaCache', 'malCache', 'franchiseCache'], 'readonly')
      const mediaStore = tx.objectStore('mediaCache')
      const malStore = tx.objectStore('malCache')
      const franchiseStore = tx.objectStore('franchiseCache')

      const stats: DbStats = {
        media: 0,
        characters: 0,
        staff: 0,
        themes: 0,
        russianTitles: 0,
        noRussianNames: 0,
        looks: 0,
        ratings: 0,
        playable: 0,
        anilibertyLinks: 0,
        screenshots: 0,
        malMappings: 0,
        franchises: 0,
        other: 0,
        totalCacheRecords: 0,
        estimatedSize,
      }

      const malReq = malStore.count()
      malReq.onsuccess = () => {
        stats.malMappings = malReq.result
      }

      const franchiseReq = franchiseStore.count()
      franchiseReq.onsuccess = () => {
        stats.franchises = franchiseReq.result
      }

      const mediaReq = mediaStore.getAllKeys()
      mediaReq.onsuccess = () => {
        const keys = mediaReq.result
        stats.totalCacheRecords = keys.length

        for (const key of keys) {
          if (typeof key !== 'string') continue

          const known = KEY_PREFIXES.find(([prefix]) => key.startsWith(prefix))
          if (known) stats[known[1]]++
          // Незнакомый префикс не пропадает: other — признак того, что таблица отстала.
          else stats.other++
        }
      }

      tx.oncomplete = () => resolve(stats)
      tx.onerror = () => resolve({ error: 'Ошибка чтения метрик БД' })
      tx.onabort = () => resolve({ error: 'Транзакция чтения метрик БД прервана' })
    })
  } catch (e) {
    Logger('ERROR', 'Сбой getDbStats', e)
    return { error: e instanceof Error ? e.message : String(e) }
  }
}

/** Поле статистики, наполняемое по префиксу ключа: отдельный тип — опечатка ломает сборку, а не даёт вечный ноль. */
type PrefixField =
  | 'media'
  | 'characters'
  | 'staff'
  | 'themes'
  | 'russianTitles'
  | 'noRussianNames'
  | 'looks'
  | 'ratings'
  | 'playable'
  | 'anilibertyLinks'
  | 'screenshots'

/**
 * Что за запись под префиксом: таблица, а не череда else if; сравнение идёт первым совпадением.
 */
const KEY_PREFIXES: ReadonlyArray<readonly [string, PrefixField]> = [
  // Карточки тайтлов: пишет api/anilist-media.ts, срок — неделя у завершённого, сутки у идущего.
  ['MED3_', 'media'],
  ['CHR3_', 'characters'],
  ['STF4_', 'staff'],
  ['THEMES2_', 'themes'],
  ['RU4_', 'russianTitles'],
  // NAME1_ ведёт в то же поле, что RU4_: имя тайтла и карточка — один вид кэша.
  ['NAME1_', 'russianTitles'],
  // Отказ «русского имени нет» — тоже знание, но в russianTitles нельзя: сводка соврала бы.
  ['NONAME1_', 'noRussianNames'],
  ['LOOK3_', 'looks'],
  ['RATE1_', 'ratings'],
  // Два самых многочисленных вида записей: метка доступности на каждую плитку, соответствие — на каждый тайтл.
  ['PLAY1_', 'playable'],
  ['ALIB1_', 'anilibertyLinks'],
  // Кадры и ролики тайтла: одна запись на тайтл, раз в месяц и только при открытии карточки.
  ['SHOT1_', 'screenshots'],
]
