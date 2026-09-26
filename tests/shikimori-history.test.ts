// Проверки чтения журнала изменений Шикимори (`api/shikimori-history`).

import { beforeEach, describe, expect, it, vi } from 'vitest'

import { SHIKI_DOMAINS } from '@/core/constants'
import type { HistoryDates } from '@/api/shikimori-history'

const SHIKI_HOST = SHIKI_DOMAINS[0] ?? 'shikimori.io'

/** Записей за страницу. Совпадает с PAGE_SIZE в самом модуле. */
const PAGE = 100

/** Одна запись журнала. Поля ровно те, что отдаёт служба. */
function event(
  id: number,
  malId: number,
  description: string,
  createdAt: string,
  url = `/animes/${malId}-t`,
): unknown {
  return { id, created_at: createdAt, description, target: { id: malId, url } }
}

/** Адрес страницы журнала. */
function pageUrl(page: number): string {
  return `https://${SHIKI_HOST}/api/users/1/history?limit=${PAGE}&page=${page}`
}

/** Читает журнал на подменённых ответах и отдаёт карту дат. */
async function read(pages: Record<number, unknown>): Promise<Map<string, HistoryDates>> {
  vi.resetModules()

  const mocks = await import('./mocks/bridge-module')
  const mock = mocks.installMockBridge()

  for (const [page, payload] of Object.entries(pages)) {
    mock.setHttpResponse(pageUrl(Number(page)), payload)
  }

  const { fetchShikiHistoryDates } = await import('@/api/shikimori-history')
  const done = await fetchShikiHistoryDates(1)

  return done.dates
}

/** Дата события в миллисекундах — по ней и сверяются границы. */
function at(iso: string): number {
  return Date.parse(iso)
}

describe('журнал Шикимори: что считается просмотром', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('закрытие тайтла — конец, серия — начало', async () => {
    const dates = await read({
      1: [
        event(1, 20, 'Смотрю', '2024-01-05T12:00:00+03:00'),
        event(2, 20, 'Просмотрено', '2024-03-09T12:00:00+03:00'),
      ],
    })

    const one = dates.get('anime:20')
    expect(one?.start).toBe(at('2024-01-05T12:00:00+03:00'))
    expect(one?.end).toBe(at('2024-03-09T12:00:00+03:00'))
  })

  it('«Просмотрено 7 эпизодов» — серия, а не закрытие тайтла', async () => {
    const dates = await read({
      1: [event(1, 21, 'Просмотрено 7 эпизодов', '2024-02-01T12:00:00+03:00')],
    })

    const one = dates.get('anime:21')
    expect(one?.start).toBe(at('2024-02-01T12:00:00+03:00'))
    expect(one?.end).toBeNull()
  })

  it('«Просмотрено и оценено на 7» — закрытие, разметка не мешает', async () => {
    const dates = await read({
      1: [event(1, 22, 'Просмотрено и оценено на <b>7</b>', '2024-02-02T12:00:00+03:00')],
    })

    const one = dates.get('anime:22')
    expect(one?.end).toBe(at('2024-02-02T12:00:00+03:00'))
    expect(one?.start).toBeNull()
  })

  it('«Просмотрены с 2-го по 5-й эпизоды» — начало', async () => {
    const dates = await read({
      1: [event(1, 23, 'Просмотрены с 2-го по 5-й эпизоды', '2024-02-03T12:00:00+03:00')],
    })

    expect(dates.get('anime:23')?.start).toBe(at('2024-02-03T12:00:00+03:00'))
  })

  it('правки, не связанные с просмотром, не дают ни одной даты', async () => {
    const dates = await read({
      1: [
        event(1, 24, 'Добавлено в список', '2024-01-01T12:00:00+03:00'),
        event(2, 24, 'Запланировано', '2024-01-02T12:00:00+03:00'),
        event(3, 24, 'Оценено на <b>8</b>', '2024-01-03T12:00:00+03:00'),
        event(4, 24, 'Изменена оценка c <b>8</b> на <b>9</b>', '2024-01-04T12:00:00+03:00'),
        event(5, 24, 'Отложено', '2024-01-05T12:00:00+03:00'),
        event(6, 24, 'Брошено', '2024-01-06T12:00:00+03:00'),
        event(7, 24, 'Удалено из списка', '2024-01-07T12:00:00+03:00'),
        event(8, 24, 'Сброшено число эпизодов', '2024-01-08T12:00:00+03:00'),
      ],
    })

    expect(dates.size).toBe(0)
  })

  /**
   * Существительное «эпизод» стоит в подписи и у сброса счётчика, поэтому
   * за просмотр оно не считается: сбросили серии — даты начала не было.
   */
  it('«Сброшено число эпизодов» — не просмотр', async () => {
    const dates = await read({
      1: [event(1, 26, 'Сброшено число эпизодов', '2024-03-01T12:00:00+03:00')],
    })

    expect(dates.size).toBe(0)
  })

  it('«Пересматриваю» — начало, а не закрытие', async () => {
    const dates = await read({
      1: [event(1, 27, 'Пересматриваю', '2024-03-02T12:00:00+03:00')],
    })

    const one = dates.get('anime:27')
    expect(one?.start).toBe(at('2024-03-02T12:00:00+03:00'))
    expect(one?.end).toBeNull()
  })

  it('начало — самое раннее событие, конец — самое позднее', async () => {
    const dates = await read({
      1: [
        event(1, 25, 'Смотрю', '2024-05-01T12:00:00+03:00'),
        event(2, 25, 'Просмотрено', '2024-06-01T12:00:00+03:00'),
        event(3, 25, 'Смотрю', '2024-04-01T12:00:00+03:00'),
        event(4, 25, 'Пересмотрено', '2024-08-01T12:00:00+03:00'),
      ],
    })

    const one = dates.get('anime:25')
    expect(one?.start).toBe(at('2024-04-01T12:00:00+03:00'))
    expect(one?.end).toBe(at('2024-08-01T12:00:00+03:00'))
  })

  it('тип цели берётся из адреса карточки, а не из target_type', async () => {
    const dates = await read({
      1: [
        event(1, 30, 'Просмотрено', '2024-01-01T12:00:00+03:00'),
        event(2, 40, 'Прочитано', '2024-01-02T12:00:00+03:00', '/mangas/40-t'),
      ],
    })

    expect(dates.get('anime:30')?.end).toBe(at('2024-01-01T12:00:00+03:00'))
    expect(dates.get('manga:40')?.end).toBe(at('2024-01-02T12:00:00+03:00'))
  })

  it('цель без понятного адреса пропускается, а не угадывается', async () => {
    const dates = await read({
      1: [
        event(1, 50, 'Просмотрено', '2024-01-01T12:00:00+03:00', '/clubs/50-t'),
        { id: 2, created_at: '2024-01-02T12:00:00+03:00', description: 'Просмотрено' },
      ],
    })

    expect(dates.size).toBe(0)
  })
})

describe('журнал Шикимори: обход страниц', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('перекрытие страниц не удваивает событие и обход доходит до конца', async () => {
    // Первая страница полная — значит, за ней есть вторая. Последняя запись
    // первой страницы повторена первой записью второй: так и ведёт себя служба.
    const first = Array.from({ length: PAGE }, (_, i) =>
      event(i + 1, 60, 'Смотрю', '2024-01-01T12:00:00+03:00'),
    )
    const overlap = first[PAGE - 1]
    const second = [
      overlap,
      event(999, 60, 'Просмотрено', '2024-09-09T12:00:00+03:00'),
      event(1000, 61, 'Смотрю', '2024-09-10T12:00:00+03:00'),
    ]

    vi.resetModules()
    const mocks = await import('./mocks/bridge-module')
    const mock = mocks.installMockBridge()
    mock.setHttpResponse(pageUrl(1), first)
    mock.setHttpResponse(pageUrl(2), second)

    const { fetchShikiHistoryDates } = await import('@/api/shikimori-history')
    const done = await fetchShikiHistoryDates(1)

    // Повторённая запись не должна была стать третьим событием.
    expect(done.rows).toBe(PAGE + 2)
    expect(done.pages).toBe(2)
    expect(done.truncated).toBe(false)

    const sixty = done.dates.get('anime:60')
    expect(sixty?.start).toBe(at('2024-01-01T12:00:00+03:00'))
    expect(sixty?.end).toBe(at('2024-09-09T12:00:00+03:00'))
    expect(done.dates.get('anime:61')?.start).toBe(at('2024-09-10T12:00:00+03:00'))
  })

  it('страница без новых записей останавливает обход', async () => {
    const same = [event(1, 70, 'Смотрю', '2024-01-01T12:00:00+03:00')]

    vi.resetModules()
    const mocks = await import('./mocks/bridge-module')
    const mock = mocks.installMockBridge()
    // Полная страница, но та же самая: обход вернулся на круг и обязан встать.
    mock.setHttpResponse(pageUrl(1), Array.from({ length: PAGE }, () => same[0]))
    mock.setHttpResponse(pageUrl(2), Array.from({ length: PAGE }, () => same[0]))

    const { fetchShikiHistoryDates } = await import('@/api/shikimori-history')
    const done = await fetchShikiHistoryDates(1)

    expect(done.rows).toBe(1)
    expect(done.pages).toBe(2)
    expect(done.truncated).toBe(false)
  })

  it('неразобранная страница обход заканчивает, а не роняет', async () => {
    const dates = await read({ 1: { text: 'не json вовсе' } })

    expect(dates.size).toBe(0)
  })

  it('пустой журнал — это пустая карта, а не ошибка', async () => {
    const dates = await read({ 1: [] })

    expect(dates.size).toBe(0)
  })
})
