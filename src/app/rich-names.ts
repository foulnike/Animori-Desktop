// Подписи голых ссылок BBcode Шикимори. Живёт в надстройке: ядру негде взять ни сеть, ни словари.
// Пути по возрастанию цены, первый бесплатный: люди открытого тайтла разрешаются без запроса.

import { shallowReactive } from 'vue'

import { fetchBriefsByMal } from '@/api/anilist-lookup'
import { peekRussianName, prefetchRussianNames } from '@/core/media-title'
import { resolveShikiPerson } from '@/core/person-link'
import { peekPersonByShiki, peekRussianPerson, type PersonKind } from '@/core/person-title'
import type { RichAim } from '@/core/rich-text'
import { Logger } from '@/utils/logger'

import { linkStubWord } from './labels'

/** Готовые подписи этого запуска. Слежение нарочно: абзац уже нарисован, когда имя приезжает. */
const names = shallowReactive(new Map<string, string>())

/** Кого уже спрашивали: пять ссылок на одного стоят одного запроса. */
const asked = new Set<string>()

/** Ключ цели. У людей номера свои в каждом разделе, у тайтлов — номер MAL. */
function keyOf(aim: RichAim): string {
  if (aim.kind === 'person') return `${aim.who}:${aim.shikiId}`
  if (aim.kind === 'media') return `media:${aim.malId}`
  return `web:${aim.url}`
}

/** Слово на время ожидания: чужой домен адреса говорит больше, чем слово «ссылка». */
function stubOf(aim: RichAim): string {
  if (aim.kind === 'person') return linkStubWord(aim.who)
  if (aim.kind === 'media') return linkStubWord('media')
  return aim.url
}

/** Имя человека: русское, если склад его знает, иначе латиница AniList. */
function personName(who: PersonKind, personId: number, latin: string): string {
  return peekRussianPerson(who, personId)?.russian ?? latin
}

/** Подпись, известная прямо сейчас. Ничего не заказывает — за добором следит warmRichLink. */
export function richLinkLabel(aim: RichAim): string {
  const ready = names.get(keyOf(aim))
  if (ready !== undefined) return ready

  if (aim.kind === 'person') {
    // Люди открытого тайтла уже сопоставлены складом карточек: имя
    // есть сразу, и слово-заглушка даже на миг не мелькнет.
    const known = peekPersonByShiki(aim.shikiId)
    if (known !== null && known.kind === aim.who) {
      return personName(known.kind, known.person.personId, known.person.name)
    }
  }

  return stubOf(aim)
}

/** Имя человека по номеру Шикимори: разрешение живёт в ядре. */
async function warmPerson(who: PersonKind, shikiId: number, key: string): Promise<void> {
  const target = await resolveShikiPerson(who, shikiId)
  if (target === null) return

  names.set(key, personName(who, target.personId, target.name))
}

/** Название тайтла по MAL. Латиница ставится сразу и заменяется русским: читаемое лучше слова «тайтл». */
async function warmMedia(malId: number, key: string): Promise<void> {
  const brief = (await fetchBriefsByMal([malId]))[0]
  if (brief === undefined) return

  const latin = brief.romaji ?? brief.english ?? brief.native
  if (latin !== null) names.set(key, latin)

  const ready = peekRussianName(brief.mediaId)
  if (ready !== null) {
    names.set(key, ready)
    return
  }

  await prefetchRussianNames([brief.mediaId])

  const russian = peekRussianName(brief.mediaId)
  if (russian !== null) names.set(key, russian)
}

/** Заказывает подпись ссылке; повторы отсекает набор. Промах стирается: повторный заход пробует снова. */
export function warmRichLink(aim: RichAim): void {
  if (aim.kind === 'web') return

  const key = keyOf(aim)
  if (names.has(key) || asked.has(key)) return

  asked.add(key)

  if (aim.kind === 'person') {
    const known = peekPersonByShiki(aim.shikiId)
    if (known !== null && known.kind === aim.who) {
      names.set(key, personName(known.kind, known.person.personId, known.person.name))
      return
    }
  }

  const task =
    aim.kind === 'person' ? warmPerson(aim.who, aim.shikiId, key) : warmMedia(aim.malId, key)

  void task.catch((e: unknown) => {
    asked.delete(key)
    Logger('WARN', `Подпись ссылки: добыть не вышло (${key})`, e)
  })
}

/** Забывает знание запуска. Нужно очистке памяти из настроек. */
export function forgetRichNames(): void {
  names.clear()
  asked.clear()
}
