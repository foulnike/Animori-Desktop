// Внешние ссылки карточки: адреса собираются из номеров, никакой сети это не стоит.
// Редактора своих ссылок нет сознательно: набор источников известен заранее.

import { ANIME365_DOMAINS, SHIKI_DOMAINS } from '@/core/constants'

/** Имя узла AniList. Схема добавляется кодом: так же, как у русских зеркал. */
const ANILIST_HOST = 'anilist.co'

/** Имя узла MyAnimeList. */
const MAL_HOST = 'myanimelist.net'

/** Первое зеркало Шикимори с запасным именем: ссылка без узла вела бы в никуда. */
const SHIKI_HOST = SHIKI_DOMAINS[0] ?? 'shikimori.io'

/** Раздел каталога: у AniList и MAL путь аниме называется одинаково. */
const CATALOG_KIND = 'anime'

/** У Шикимори тот же раздел, но во множественном числе. */
const SHIKI_KIND = 'animes'

/** Одна ссылка хвоста описания. */
export interface MediaLink {
  /** Ключ для перебора в разметке. */
  key: string
  text: string
  url: string
  /** Подсказка: куда уводит ссылка. */
  hint: string
}

/** Всё, из чего собирается хвост. Вида тайтла здесь нет: только аниме. */
export interface MediaLinksInput {
  mediaId: number
  malId: number | null
  /** Адрес страницы, откуда взято описание. Пустая строка — как отсутствие. */
  sourceUrl?: string | null
  sourceName?: string | null
}

/** Собирает адрес из имени узла, раздела и номера. */
function pageUrl(host: string, kind: string, id: number): string {
  return 'https://' + host + '/' + kind + '/' + String(id)
}

/** Лежит ли адрес на одном из известных зеркал источника. */
function atDomain(url: string, domains: readonly string[]): boolean {
  return domains.some((domain) => url.includes(domain))
}

/** Собирает хвост описания. Номер Шикимори считается равным MAL — на этом допущении стоит весь поиск. */
export function mediaLinks(input: MediaLinksInput): MediaLink[] {
  const list: MediaLink[] = []
  const malId = input.malId !== null && input.malId > 0 ? input.malId : null

  list.push({
    key: 'anilist',
    text: `AniList #${input.mediaId}`,
    url: pageUrl(ANILIST_HOST, CATALOG_KIND, input.mediaId),
    hint: 'Открыть карточку на AniList',
  })

  if (malId !== null) {
    list.push({
      key: 'mal',
      text: `MAL #${malId}`,
      url: pageUrl(MAL_HOST, CATALOG_KIND, malId),
      hint: 'Открыть карточку на MyAnimeList',
    })
  }

  const sourceUrl = (input.sourceUrl ?? '').trim()
  const sourceName = (input.sourceName ?? '').trim()
  const fromShiki = sourceUrl !== '' && atDomain(sourceUrl, SHIKI_DOMAINS)

  // Своя страница описания точнее собранного адреса: у Шикимори бывают
  // отдельные страницы у частей, и номер MAL ведёт не туда.
  if (fromShiki) {
    list.push({
      key: 'shiki',
      text: 'Шикимори',
      url: sourceUrl,
      hint: 'Открыть страницу Шикимори: описание взято оттуда',
    })
  } else if (malId !== null) {
    list.push({
      key: 'shiki',
      text: 'Шикимори',
      url: pageUrl(SHIKI_HOST, SHIKI_KIND, malId),
      hint: 'Открыть карточку на Шикимори',
    })
  }

  // Второй русский источник: адрес каталога anime365 строится по своему
  // ярлыку, а не по номеру MAL, поэтому берётся только готовый.
  if (sourceUrl !== '' && !fromShiki) {
    const isAnime365 = atDomain(sourceUrl, ANIME365_DOMAINS)
    const text = isAnime365 ? 'Anime365' : sourceName === '' ? 'Источник описания' : sourceName

    list.push({
      key: 'source',
      text,
      url: sourceUrl,
      hint: `Описание отсюда: ${sourceName === '' ? sourceUrl : sourceName}`,
    })
  }

  return list
}
