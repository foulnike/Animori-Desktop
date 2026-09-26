// Память Главной между показами: переход на карточку сносит экран, а отбор и набранная лента переживают его здесь.
// Состояние сеанса: ни в снимок, ни в базу не пишется, гибнет вместе с окном.

import { ref } from 'vue'

import { emptyPick, type CatalogPick } from '@/api/anilist-catalog'
import type { MediaBrief } from '@/api/anilist-media'
import type { FeedRun } from '@/core/recs'

/** Чем сужен подбор: жанры, тэги, годы, форматы и порядок. */
export const homePick = ref<CatalogPick>(emptyPick())

/** Набранная лента: ключ отбора, обход и уже показанное. */
export interface FeedKeep {
  key: string
  run: FeedRun | null
  items: MediaBrief[]
}

/** Вне реактивности: за перерисовку отвечает экран, а ref на сотни описаний вешал бы наблюдателя даром. */
export const feedKeep: FeedKeep = { key: '', run: null, items: [] }

/** Забыть набранное: смена отбора начинает ленту заново. */
export function dropFeed(): void {
  feedKeep.key = ''
  feedKeep.run = null
  feedKeep.items = []
}
