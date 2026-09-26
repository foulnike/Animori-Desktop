// Строки списка вынесены из показа: сборка, порядок и доборы обложек с названиями. Метки доступности: склад — целиком
// (даром), сеть — только по показанным плиткам (v-seen из app/see-tile.ts): закладка на полторы сотни не должна стоить столько же вопросов.
import { onScopeDispose, ref, type Ref } from 'vue'

import { setupVideoSources } from '@/api/video-sources'
import { notOutYet, partsCeiling, peekLook, warmLooks, type MediaLook } from '@/core/media-looks'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import {
  onPlayableChange,
  peekPlayable,
  primePlayable,
  requestPlayable,
  type PlayAsk,
  type PlayState,
} from '@/core/playable'
import type { SnapshotEntry } from '@/core/snapshot'
import { Logger } from '@/utils/logger'

import { formatWord, partsShort } from '../labels'

import type { SortName } from './lists-keep'

/** По скольку аниме просить названия за заход: источники отвечают по одному. */
const TITLE_CHUNK = 10

/** Пауза перед заказом меток: прокрутка приводит строки десятками, иначе каждая будила бы очередь ядра. */
const SEEN_PAUSE_MS = 200

/** Строка списка в виде, готовом к отрисовке: разметка ничего не считает. */
export interface Row {
  mediaId: number
  title: string
  facts: string
  mark: string | null
  repeat: number
  note: string | null
  ongoing: boolean
  /** Ни одной части ещё не вышло: на постере вместо сезона стоит анонс. */
  soon: boolean
  /** Есть ли аниме у источников видео. null — ещё не спрашивали. */
  play: PlayState | null
  /** Чем спрашивать источники про это аниме: добор видит только строки, а номер MAL и латиница — в снимке. */
  ask: PlayAsk
  own: string | null
  done: number
  cover: string | null
  color: string | null
  adult: boolean
}

/** Доборы, отданные экрану: флажки для подвала, пуски и отметка о показе. */
export interface RowWarm {
  looksBusy: Ref<boolean>
  titlesBusy: Ref<boolean>
  playBusy: Ref<boolean>
  fillLooks: () => Promise<void>
  fillTitles: () => Promise<void>
  loadMarks: () => Promise<void>
  onRowSeen: (mediaId: number) => void
}

/** Короткая подпись под названием: вид и год. Больше в две строки не влезает. */
function factsText(look: MediaLook | null): string {
  if (look === null) return ''

  const parts: string[] = []

  const kindWord = formatWord(look.format)
  if (kindWord !== null) parts.push(kindWord)
  if (look.seasonYear !== null) parts.push(String(look.seasonYear))

  return parts.join(' · ')
}

/** Свой счёт частей на постере. Неизвестный итог не выдумывается. */
function ownText(entry: SnapshotEntry, parts: number | null): string | null {
  const short = partsShort()
  if (parts === null) return entry.progress > 0 ? `${entry.progress} ${short}` : null
  return `${entry.progress} / ${parts} ${short}`
}

/** Доля пройденного для полосы. Завершённое залито целиком даже без итога. */
function donePart(entry: SnapshotEntry, parts: number | null): number {
  if (entry.status === 'COMPLETED') return 1
  if (parts === null || parts <= 0 || entry.progress <= 0) return 0
  return Math.min(1, entry.progress / parts)
}

/** Название записи: русское, латиница, английское, номер (номер — только у записи до ответа сервера). */
function titleOf(entry: SnapshotEntry): string {
  return (
    peekRussianName(entry.mediaId) ??
    entry.romaji ??
    entry.english ??
    peekLook(entry.mediaId)?.romaji ??
    `Аниме #${entry.mediaId}`
  )
}

/** Чем спрашивать источники: номер MAL и названия по убыванию пригодности (номер снимка не выдумывается).
 * Признак идущего сезона едет с вопросом ради срока ответа «нет»: без него core/playable.ts считал идущим всё за два года. */
function playAskOf(entry: SnapshotEntry, look: MediaLook | null): PlayAsk {
  const names = [
    entry.romaji,
    entry.english,
    look?.romaji ?? null,
    peekRussianName(entry.mediaId),
  ]

  return {
    mediaId: entry.mediaId,
    malId: entry.malId ?? null,
    titles: [...new Set(names.filter((name): name is string => name !== null && name !== ''))],
    year: look?.seasonYear ?? undefined,
    // Облик ещё не добран — признак не выдумывается: «завершено» заперло бы отказ по догадке.
    airing: look === null ? undefined : (look.airingEpisode ?? null) !== null,
  }
}

/** Средняя оценка каталога для порядка: неизвестная уходит в конец. */
function ratingOf(entry: SnapshotEntry): number {
  return peekLook(entry.mediaId)?.averageScore ?? -1
}

/** Порядок показа: названия сравниваются по-русски, поэтому список слегка переставится, когда доберутся переводы.
 * На входе список только для чтения, копия делается здесь. */
export function sortEntries(list: readonly SnapshotEntry[], key: SortName): SnapshotEntry[] {
  const out = [...list]

  switch (key) {
    case 'score':
      out.sort((a, b) => b.score10 - a.score10 || b.updatedAt - a.updatedAt)
      break
    case 'rating':
      out.sort((a, b) => ratingOf(b) - ratingOf(a) || b.updatedAt - a.updatedAt)
      break
    case 'nameUp':
      out.sort((a, b) => titleOf(a).localeCompare(titleOf(b), 'ru'))
      break
    case 'nameDown':
      out.sort((a, b) => titleOf(b).localeCompare(titleOf(a), 'ru'))
      break
    default:
      out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  return out
}

/** Запись памяти в плитку. */
export function toRow(entry: SnapshotEntry): Row {
  const look = peekLook(entry.mediaId)

  // У идущего сезона знаменателем служат вышедшие серии.
  const parts = partsCeiling(look)

  return {
    mediaId: entry.mediaId,
    title: titleOf(entry),
    facts: factsText(look),
    mark: entry.score10 > 0 ? `★ ${entry.score10.toFixed(1)}` : null,
    repeat: entry.repeat,
    note: entry.notes,
    ongoing: (look?.airingEpisode ?? null) !== null,
    soon: notOutYet(look),
    // Спрашивается только память: сеть здесь задержала бы отрисовку списка целиком.
    play: peekPlayable(entry.mediaId),
    ask: playAskOf(entry, look),
    own: ownText(entry, parts),
    done: donePart(entry, parts),
    cover: look?.cover ?? null,
    color: look?.color ?? null,
    adult: entry.isAdult,
  }
}

/** Доборы для показанных строк: обложек в снимке нет, имена — на складе; номера гасят устаревшие ответы. */
export function useRowWarm(rows: Ref<Row[]>, redraw: () => void): RowWarm {
  const looksBusy = ref(false)
  const titlesBusy = ref(false)
  const playBusy = ref(false)

  let lookRun = 0
  let titleRun = 0
  let playRun = 0

  /** Номера, о которых вопрос уже задан: по ним горит флажок в подвале. */
  const askedRows = new Set<number>()

  /** Плитки, попавшие в окно и ещё без метки: о них уйдёт ближайший заказ. */
  const seenRows = new Set<number>()

  let seenTimer: ReturnType<typeof setTimeout> | null = null

  /** Подъём меток со склада: заказ в сеть ждёт его — спрашивать чужое о том, что уже на диске, незачем. */
  let priming: Promise<void> = Promise.resolve()

  /** Гасит флажок подвала, когда на свои вопросы пришли ответы: счёт по своим, а не по очереди ядра. */
  function keepFlag(): void {
    for (const id of askedRows) {
      if (peekPlayable(id) !== null) askedRows.delete(id)
    }

    playBusy.value = askedRows.size > 0
  }

  // Метки приходят по одной и долго: подписка рисует каждый ответ, и метки
  // проступают на глазах, а не рывком в конце.
  const unwatch = onPlayableChange(() => {
    keepFlag()
    redraw()
  })
  onScopeDispose(unwatch)

  // Отложенный заказ пережил бы экран и будил очередь ради списка, которого больше нет.
  onScopeDispose(() => {
    if (seenTimer !== null) clearTimeout(seenTimer)
    seenTimer = null
  })

  /** Снимает отложенный заказ: показанное относилось к прошлому отбору. */
  function dropSeen(): void {
    if (seenTimer !== null) clearTimeout(seenTimer)
    seenTimer = null
    seenRows.clear()
    askedRows.clear()
    playBusy.value = false
  }

  /** Добирает обложки для показанных плиток: сотня строк — два запроса, возврат в ту же закладку — даром. */
  async function fillLooks(): Promise<void> {
    const mine = ++lookRun
    const wanted = rows.value
      .filter((row) => peekLook(row.mediaId) === null)
      .map((row) => row.mediaId)

    if (wanted.length === 0) return

    looksBusy.value = true

    try {
      await warmLooks(wanted)
      if (mine !== lookRun) return

      redraw()
    } catch (e) {
      // Без обложек список живой: на плитке останется первая буква названия.
      Logger('WARN', 'Списки: обложки добрать не вышло', e)
    } finally {
      if (mine === lookRun) looksBusy.value = false
    }
  }

  /** Добирает русские названия плиток пачками; ошибка не стопорит экран — название останется на латинице. */
  async function fillTitles(): Promise<void> {
    const mine = ++titleRun
    const wanted = rows.value
      .filter((row) => peekRussianName(row.mediaId) === null)
      .map((row) => row.mediaId)

    if (wanted.length === 0) return

    titlesBusy.value = true

    try {
      for (let from = 0; from < wanted.length; from += TITLE_CHUNK) {
        // Закладку успели сменить: остаток пачек этому показу не нужен.
        if (mine !== titleRun) return

        // Строке нужно одно имя: описание с оценками спросит открытая карточка.
        await prefetchRussianNames(wanted.slice(from, from + TITLE_CHUNK))
        if (mine !== titleRun) return

        redraw()
      }
    } catch (e) {
      Logger('WARN', 'Списки: названия добрать не вышло', e)
    } finally {
      if (mine === titleRun) titlesBusy.value = false
    }
  }

  /** Поднимает метки со склада по всем показанным строкам разом — сети не касается, спрошенное показывается даром.
   * Зовётся на каждую смену отбора и снимает отложенный заказ прошлого показа. */
  async function loadMarks(): Promise<void> {
    const mine = ++playRun
    dropSeen()

    const unknown = rows.value.filter((row) => row.play === null).map((row) => row.mediaId)
    if (unknown.length === 0) return

    priming = (async () => {
      try {
        const primed = await primePlayable(unknown)
        if (mine !== playRun) return
        if (primed > 0) redraw()
      } catch (e) {
        // Без метки список живой: плитка про доступность просто молчит.
        Logger('WARN', 'Списки: метки доступности со склада не поднялись', e)
      }
    })()

    await priming
  }

  /** Заказывает метки для показанных строк: ответы приезжают подпиской, темп держит очередь ядра. */
  async function askSeen(): Promise<void> {
    const mine = playRun

    // Склад мог ещё не договорить: иначе в сеть ушли бы вопросы о том,
    // что уже лежит на диске.
    await priming
    if (mine !== playRun) return

    const wanted: PlayAsk[] = []

    for (const row of rows.value) {
      if (!seenRows.has(row.mediaId)) continue
      if (peekPlayable(row.mediaId) !== null) continue

      wanted.push(row.ask)
      askedRows.add(row.mediaId)
    }

    seenRows.clear()

    if (wanted.length === 0) return

    // Реестр источников собирает экран: ядро своих поставщиков не зовёт.
    setupVideoSources()

    playBusy.value = true
    requestPlayable(wanted)
  }

  /** Плитка строки показалась человеку: номера копятся пачкой, а известная метка вопроса не задаёт вовсе. */
  function onRowSeen(mediaId: number): void {
    if (peekPlayable(mediaId) !== null) return

    seenRows.add(mediaId)
    if (seenTimer !== null) return

    seenTimer = setTimeout(() => {
      seenTimer = null
      void askSeen()
    }, SEEN_PAUSE_MS)
  }

  return { looksBusy, titlesBusy, playBusy, fillLooks, fillTitles, loadMarks, onRowSeen }
}
