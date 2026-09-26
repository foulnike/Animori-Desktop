// Проверки формата облачной копии списка. Путь к модулю относительный, а не через @/: тест не
// должен зависеть от настройки псевдонимов сборщика.

import { describe, expect, it } from 'vitest'

import {
  CLOUD_DIR,
  CLOUD_FILE,
  CLOUD_FORMAT,
  buildCloudFile,
  parseCloudFile,
} from '../src/shared/core/cloud-file'

import type { SnapshotEntry } from '../src/shared/core/snapshot'

/** Версия формы записей в проверках: тот же SNAPSHOT_VERSION, только прямо. */
const LIST = 6

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

describe('buildCloudFile', () => {
  it('ставит обёртку и считает записи', () => {
    const done = buildCloudFile({
      entries: [entry({ mediaId: 1 }), entry({ mediaId: 2 })],
      listVersion: LIST,
      userId: 42,
      device: 'Windows',
      savedAt: 1000,
    })

    expect(done.file.format).toBe(CLOUD_FORMAT)
    expect(done.file.listVersion).toBe(LIST)
    expect(done.file.savedAt).toBe(1000)
    expect(done.file.device).toBe('Windows')
    expect(done.file.userId).toBe(42)
    expect(done.file.count).toBe(2)
    expect(done.bytes).toBeGreaterThan(0)
  })

  it('без счёта и без метки устройства копия всё равно целая', () => {
    const done = buildCloudFile({ entries: [entry()], listVersion: LIST, savedAt: 0 })

    expect(done.file.userId).toBeNull()
    expect(done.file.device).toBe('')
    expect(done.file.count).toBe(1)
  })

  it('метку устройства сводит к одной строке и подрезает', () => {
    const done = buildCloudFile({
      entries: [],
      listVersion: LIST,
      device: `  Дома\n\tшний ${'ТВ'.repeat(60)}  `,
      savedAt: 0,
    })

    expect(done.file.device.startsWith('Дома шний ТВ')).toBe(true)
    expect(done.file.device.length).toBeLessThanOrEqual(60)
  })

  it('чужие поля в облако не увозит: в файле только известные поля', () => {
    const dirty = { ...entry(), token: 'secret-token', cookie: 'am=1' } as unknown as SnapshotEntry

    const done = buildCloudFile({ entries: [dirty], listVersion: LIST, savedAt: 0 })

    expect(done.text).not.toContain('secret-token')
    expect(done.text).not.toContain('token')
    expect(done.text).not.toContain('cookie')
    expect(done.text).toContain('"mediaId":1')
  })

  it('кладёт записи по номеру тайтла: две копии одного списка совпадают', () => {
    const rows = [entry({ mediaId: 30 }), entry({ mediaId: 4 })]

    const straight = buildCloudFile({ entries: rows, listVersion: LIST, savedAt: 0 })
    const flipped = buildCloudFile({ entries: [...rows].reverse(), listVersion: LIST, savedAt: 0 })

    expect(straight.text).toBe(flipped.text)
    expect(straight.text.indexOf('"mediaId":4')).toBeLessThan(
      straight.text.indexOf('"mediaId":30'),
    )
  })

  it('битую запись отбрасывает, а не везёт в облако', () => {
    const broken = [
      entry({ mediaId: 5 }),
      { mediaId: 'seven' } as unknown as SnapshotEntry,
      null as unknown as SnapshotEntry,
    ]

    const done = buildCloudFile({ entries: broken, listVersion: LIST, savedAt: 0 })

    expect(done.file.count).toBe(1)
    expect(done.file.entries[0]?.mediaId).toBe(5)
  })

  it('на пустом списке даёт целый файл, а не обрывок', () => {
    const done = buildCloudFile({ entries: [], listVersion: LIST, savedAt: 0 })

    expect(done.file.count).toBe(0)
    expect(done.text).toContain('"entries":[]')
    expect(JSON.parse(done.text)).toBeTruthy()
  })
})

describe('parseCloudFile', () => {
  it('читает то, что сам же собрал', () => {
    const made = buildCloudFile({
      entries: [entry({ mediaId: 9, progress: 12, notes: 'заметка' })],
      listVersion: LIST,
      userId: 7,
      device: 'ТВ',
      savedAt: 555,
    })

    const done = parseCloudFile(made.text, LIST)

    expect(done.ok).toBe(true)
    if (!done.ok) return

    expect(done.dropped).toBe(0)
    expect(done.file.userId).toBe(7)
    expect(done.file.device).toBe('ТВ')
    expect(done.file.savedAt).toBe(555)
    expect(done.file.entries).toHaveLength(1)
    expect(done.file.entries[0]?.progress).toBe(12)
    expect(done.file.entries[0]?.notes).toBe('заметка')
  })

  it('пустой файл и не JSON разбору не поддаются', () => {
    expect(parseCloudFile('', LIST).ok).toBe(false)
    expect(parseCloudFile('   ', LIST).ok).toBe(false)
    expect(parseCloudFile('<html>404</html>', LIST).ok).toBe(false)
  })

  it('чужой формат отвергает словами', () => {
    const alien = JSON.stringify({
      format: CLOUD_FORMAT + 1,
      listVersion: LIST,
      entries: [],
    })

    const done = parseCloudFile(alien, LIST)

    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.problem).toContain('формат')
  })

  it('копию от другой версии списка не прикладывает', () => {
    const older = JSON.stringify({
      format: CLOUD_FORMAT,
      listVersion: LIST - 1,
      entries: [entry()],
    })

    const done = parseCloudFile(older, LIST)

    expect(done.ok).toBe(false)
    if (done.ok) return
    expect(done.problem).toContain('версии')
  })

  it('без списка записей это не копия', () => {
    const noRows = JSON.stringify({ format: CLOUD_FORMAT, listVersion: LIST })

    expect(parseCloudFile(noRows, LIST).ok).toBe(false)
    expect(parseCloudFile(JSON.stringify([1, 2, 3]), LIST).ok).toBe(false)
  })

  it('битые записи считает поштучно, а не теряет всю копию', () => {
    const mixed = JSON.stringify({
      format: CLOUD_FORMAT,
      listVersion: LIST,
      entries: [entry({ mediaId: 3 }), { notes: 'без номера' }, 'strings', null],
    })

    const done = parseCloudFile(mixed, LIST)

    expect(done.ok).toBe(true)
    if (!done.ok) return

    expect(done.file.count).toBe(1)
    expect(done.dropped).toBe(3)
  })

  it('пустая копия — законный исход разбора, а не отказ', () => {
    const empty = JSON.stringify({ format: CLOUD_FORMAT, listVersion: LIST, entries: [] })

    const done = parseCloudFile(empty, LIST)

    expect(done.ok).toBe(true)
    if (!done.ok) return
    expect(done.file.count).toBe(0)
  })

  it('приводит поля к форме: копию могли править руками', () => {
    const hand = JSON.stringify({
      format: CLOUD_FORMAT,
      listVersion: LIST,
      savedAt: 'вчера',
      userId: 'семь',
      entries: [
        {
          mediaId: 11,
          malId: 0,
          status: 5,
          score10: 'восемь',
          progress: null,
          startedAt: '2025-13',
          completedAt: '2025-04-01',
          notes: '',
          isAdult: 'да',
          romaji: '',
        },
      ],
    })

    const done = parseCloudFile(hand, LIST)

    expect(done.ok).toBe(true)
    if (!done.ok) return

    const row = done.file.entries[0]
    expect(done.file.savedAt).toBe(0)
    expect(done.file.userId).toBeNull()
    expect(row?.malId).toBeNull()
    expect(row?.status).toBeNull()
    expect(row?.score10).toBe(0)
    expect(row?.progress).toBe(0)
    expect(row?.startedAt).toBeNull()
    expect(row?.completedAt).toBe('2025-04-01')
    expect(row?.notes).toBeNull()
    expect(row?.isAdult).toBe(false)
    expect(row?.romaji).toBeNull()
  })
})

describe('имена в облаке', () => {
  it('папка и файл одни на всех провайдеров', () => {
    expect(CLOUD_DIR).toBe('AniMori')
    expect(CLOUD_FILE).toBe('animori-list.json')
    expect(CLOUD_FILE.endsWith('.json')).toBe(true)
  })
})
