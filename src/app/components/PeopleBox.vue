<script setup lang="ts">
// Пункт 3.9: люди аниме под карточкой; добыча своя. Окошко человека — в общем слое (person-layer.ts).
// Длинное слитное имя режется по двум строкам, чтобы не лезло на соседние плитки; целиком — в подсказке.
import { computed, onBeforeUnmount, onMounted, ref, shallowReactive, watch } from 'vue'

import { fetchMalIds } from '@/api/anilist-media'
import {
  fetchMediaPeople,
  type CharacterRef,
  type PersonRef,
  type StaffRef,
} from '@/api/anilist-people'
import {
  getRussianPerson,
  peekRussianPerson,
  prefetchRussianPeople,
  type PersonKind,
  type RussianPerson,
} from '@/core/person-title'
import { settings } from '@/core/settings'
import { Logger } from '@/utils/logger'

import { openPerson } from '../person-layer'

import { CREW_WORDS } from './crew-words'

const props = defineProps<{ mediaId: number }>()

/** Авторов до раскрытия хвоста: 8 — ровно два ряда сетки по четыре колонки. */
const STAFF_HEAD = 8

/** Сколько заглушек класть на полку, пока люди едут. */
const HOLD_FACES = 8

/** Роли персонажей: сервер называет их тремя словами и других не бывает. */
const ROLE_WORDS: Record<string, string> = {
  MAIN: 'Главный',
  SUPPORTING: 'Второстепенный',
  BACKGROUND: 'Массовка',
}

const folk = ref<CharacterRef[]>([])
const crew = ref<StaffRef[]>([])
const busy = ref(false)

/** Раскрыт ли хвост списка авторов. */
const wide = ref(false)

/** Номер показа: ответ на прежнее аниме приходит уже не к месту. */
let run = 0

/** Русские имена, добытые фоном: ключ — `${kind}:${personId}`. */
const russian = shallowReactive(new Map<string, RussianPerson>())

const shownCrew = computed<StaffRef[]>(() =>
  wide.value ? crew.value : crew.value.slice(0, STAFF_HEAD),
)

const hiddenCrew = computed<number>(() => Math.max(0, crew.value.length - STAFF_HEAD))

const empty = computed<boolean>(() => folk.value.length === 0 && crew.value.length === 0)

/** Роль персонажа словом. Незнакомое значение лучше не показывать вовсе. */
function roleWord(role: string | null): string {
  return role === null ? '' : (ROLE_WORDS[role] ?? '')
}

/** Роль автора по-русски. Составная роль переводится по частям. */
function crewWord(role: string | null): string {
  if (role === null) return ''

  return role
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => CREW_WORDS[part] ?? part)
    .join(', ')
}

/** Первая буква имени: стоит на месте не приехавшего портрета. */
function letter(name: string): string {
  return name.slice(0, 1).toUpperCase()
}

function personKey(kind: PersonKind, personId: number): string {
  return `${kind}:${personId}`
}

/** Имя для плитки: русское, когда фон уже добыл. */
function displayName(kind: PersonKind, person: PersonRef): string {
  return russian.get(personKey(kind, person.personId))?.russian ?? person.name
}

/** Подсказка плитки тремя строками: показанное имя (в плитке оно режется), родное, латиница.
 *  Своя подсказка держит перенос строки, чего системная не умела. */
function personHint(kind: PersonKind, person: PersonRef): string {
  const shown = displayName(kind, person)
  const lines = [shown, person.native, person.name === shown ? null : person.name]

  return lines.filter((line): line is string => typeof line === 'string' && line !== '').join('\n')
}

async function load(): Promise<void> {
  const mine = ++run

  folk.value = []
  crew.value = []
  wide.value = false

  if (props.mediaId === 0) return

  busy.value = true

  try {
    const found = await fetchMediaPeople(props.mediaId)
    if (mine !== run) return

    folk.value = found.characters
    crew.value = found.staff
    void beginRussian(mine)
  } catch (e) {
    // Без людей карточка полноценна, поэтому секция просто не появится.
    Logger('WARN', `Люди аниме ${props.mediaId}: добыть не вышло`, e)
  } finally {
    if (mine === run) busy.value = false
  }
}

/** Фоновый проход по русским именам: массовый запрос списком ролей, остаток — точечно.
 *  Уход с аниме обрывает очередь тем же номером показа, что и основная добыча. */
async function beginRussian(mine: number): Promise<void> {
  const queue: Array<{ kind: PersonKind; person: PersonRef }> = []
  if (settings.translateCharacters) {
    for (const person of folk.value) queue.push({ kind: 'character', person })
  }
  if (settings.translateStaff) {
    for (const person of crew.value) queue.push({ kind: 'staff', person })
    for (const person of folk.value) {
      if (person.voice) queue.push({ kind: 'staff', person: person.voice })
    }
  }
  if (queue.length === 0) return

  // MAL id нынешнего аниме: на нём висят и массовый проход, и гард тёзок.
  let malId: number | undefined
  try {
    malId = (await fetchMalIds([props.mediaId])).get(props.mediaId)
  } catch (e) {
    Logger('WARN', `Русские имена: MAL id аниме ${props.mediaId} не добыт`, e)
  }

  if (malId) {
    const left = await prefetchRussianPeople(malId, queue)
    if (mine !== run) return

    // Список ролей разрешил большинство разом: подметаем их в плитки.
    for (const entry of queue) {
      const card = peekRussianPerson(entry.kind, entry.person.personId)
      if (card) russian.set(personKey(entry.kind, entry.person.personId), card)
    }

    // Кого список не покрыл, добираем точечно, по одному.
    for (const entry of left) {
      if (mine !== run) return
      const card = await getRussianPerson(entry.kind, entry.person, [malId])
      if (mine !== run) return
      if (card) russian.set(personKey(entry.kind, entry.person.personId), card)
    }
    return
  }

  // Без номера MAL массового прохода нет: все идут точечным поиском.
  for (const entry of queue) {
    if (mine !== run) return
    const card = await getRussianPerson(entry.kind, entry.person)
    if (mine !== run) return
    if (card) russian.set(personKey(entry.kind, entry.person.personId), card)
  }
}

/** Открывает человека окошком поверх экрана: уход на сайт тут ни к чему. */
function onShow(kind: PersonKind, person: PersonRef): void {
  openPerson({ kind, ...person })
}

onMounted(() => {
  void load()
})

onBeforeUnmount(() => {
  run++
})

watch(
  () => props.mediaId,
  () => {
    void load()
  },
)
</script>

<template>
  <div v-if="busy && empty" class="am-panel am-folk">
    <h3 class="am-h3">Персонажи</h3>
    <div class="am-rail">
      <span v-for="at in HOLD_FACES" :key="at" class="am-skeleton am-face__wait" />
    </div>
  </div>

  <template v-else-if="!empty">
    <div v-if="folk.length > 0" class="am-panel am-folk">
      <h3 class="am-h3">Персонажи</h3>

      <div class="am-rail">
        <article v-for="person in folk" :key="person.personId" class="am-face">
          <button
            v-tip="personHint('character', person)"
            class="am-face__hit"
            type="button"
            @click="onShow('character', person)"
          >
            <span class="am-face__frame">
              <img
                v-if="person.image"
                class="am-face__art"
                :src="person.image"
                :alt="person.name"
                loading="lazy"
                decoding="async"
              />
              <span v-else class="am-face__art am-face__art--empty" aria-hidden="true">
                {{ letter(person.name) }}
              </span>

              <span v-if="roleWord(person.role)" class="am-face__role">
                {{ roleWord(person.role) }}
              </span>
            </span>

            <span class="am-face__name">{{ displayName('character', person) }}</span>
          </button>

          <!-- Озвучка своей целью: это второй человек, и окно у него своё. -->
          <button
            v-if="person.voice"
            v-tip="personHint('staff', person.voice)"
            class="am-face__voice"
            type="button"
            @click="onShow('staff', person.voice)"
          >
            {{ displayName('staff', person.voice) }}
          </button>
        </article>
      </div>
    </div>

    <div v-if="crew.length > 0" class="am-panel am-folk">
      <div class="am-bar">
        <h3 class="am-h3">Авторы</h3>
        <span class="am-bar__gap" />
        <button
          v-if="hiddenCrew > 0"
          class="am-btn am-btn--ghost"
          type="button"
          @click="wide = !wide"
        >
          {{ wide ? 'Свернуть' : `Ещё ${hiddenCrew}` }}
        </button>
      </div>

      <div class="am-crew">
        <button
          v-for="person in shownCrew"
          :key="`${person.personId}-${person.role ?? ''}`"
          v-tip="personHint('staff', person)"
          class="am-mate"
          type="button"
          @click="onShow('staff', person)"
        >
          <img
            v-if="person.image"
            class="am-mate__art"
            :src="person.image"
            :alt="person.name"
            loading="lazy"
            decoding="async"
          />
          <span v-else class="am-mate__art am-mate__art--empty" aria-hidden="true">
            {{ letter(person.name) }}
          </span>

          <span class="am-mate__text">
            <span class="am-mate__name">{{ displayName('staff', person) }}</span>
            <span v-if="crewWord(person.role)" class="am-mate__role">
              {{ crewWord(person.role) }}
            </span>
          </span>
        </button>
      </div>
    </div>
  </template>
</template>

<style scoped>
/* Ширина лица одним токеном: трек полки, плитка и заглушка раньше
   повторяли 132px три раза и легко расходились. */
.am-folk {
  --am-face: clamp(112px, 8.5vw, 156px);

  display: flex;
  flex-direction: column;
  gap: 14px;
  border-radius: var(--am-r-leaf);
}

/* Засечка акцентом вместо голого заголовка: панелей на карточке много. */
.am-folk .am-h3 {
  display: flex;
  gap: 9px;
  align-items: center;
}

.am-folk .am-h3 {
  /* Засечка перед заголовком жила как украшение. Смысла она не несла:
     разрядка шрифтом делает то же самое. Убрана. */
}

/* Общая полка растягивает треки на всю ширину: при горсти лиц это разнос. */
.am-folk .am-rail {
  grid-auto-columns: var(--am-face);
  justify-content: start;
  mask-image: linear-gradient(to right, #000 94%, transparent);
}

/* Персонажи полкой, а не сеткой: их бывает два десятка, и сетка
   утопила бы панель записи в самый низ экрана. */
.am-face {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.am-face__hit {
  display: flex;
  flex-direction: column;
  gap: 7px;
  width: 100%;
  min-width: 0;
  padding: 0;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
}

/* Обойма портрета держит капсулу роли и режет её по форме. */
.am-face__frame {
  position: relative;
  display: block;
  overflow: hidden;
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-leaf);
  transition:
    transform var(--am-mid) var(--am-ease),
    border-color var(--am-fast) var(--am-ease),
    border-radius var(--am-mid) var(--am-ease);
}

.am-face__hit:hover .am-face__frame,
.am-face__hit:focus-visible .am-face__frame {
  transform: translateY(-3px);
  border-color: rgb(var(--am-accent-rgb) / 0.55);
  border-radius: var(--am-r-drop);
}

.am-face__art {
  display: block;
  width: 100%;
  aspect-ratio: 2 / 3;
  object-fit: cover;
  background: var(--am-fill-2);
}

.am-face__art--empty {
  display: grid;
  place-items: center;
  font-size: 28px;
  color: var(--am-faint);
}

/* Роль — капсула на портрете, а не третья серая строка под именем. */
.am-face__role {
  position: absolute;
  bottom: 6px;
  left: 6px;
  max-width: calc(100% - 12px);
  padding: 2px 8px;
  overflow: hidden;
  font-size: 10.5px;
  font-weight: 600;
  color: var(--am-text);
  text-overflow: ellipsis;
  white-space: nowrap;
  background: color-mix(in srgb, var(--am-veil) 72%, transparent);
  border-radius: var(--am-r-cap);
  backdrop-filter: blur(6px);
}

.am-face__wait {
  width: var(--am-face);
  aspect-ratio: 2 / 3;
  border-radius: var(--am-r-leaf);
}

/* Две строки максимум; anywhere рвёт слитное имя без пробелов, иначе оно легло бы
   поверх соседней плитки. Целиком имя — в подсказке. */
.am-face__name {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

/* Озвучка бледнее имени: это второй человек в той же плитке.
   Режется так же: имя актёра бывает длиннее имени героя. */
.am-face__voice {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  width: 100%;
  padding: 0;
  overflow: hidden;
  font: inherit;
  font-size: 12px;
  color: var(--am-dim);
  text-align: left;
  cursor: pointer;
  background: none;
  border: 0;
  overflow-wrap: anywhere;
  transition: color var(--am-fast) var(--am-ease);
}

.am-face__voice:hover,
.am-face__voice:focus-visible {
  color: var(--am-accent);
}

/* Авторов единицы, полка из четырёх плиток смотрелась бы обрубком. */
.am-crew {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
}

.am-mate {
  display: flex;
  gap: 11px;
  align-items: center;
  min-width: 0;
  padding: 8px 12px;
  font: inherit;
  color: inherit;
  text-align: left;
  cursor: pointer;
  background: var(--am-fill-1);
  border: 1px solid var(--am-line-soft);
  border-radius: var(--am-r-cap);
  transition:
    background-color var(--am-fast) var(--am-ease),
    border-color var(--am-fast) var(--am-ease),
    transform var(--am-fast) var(--am-ease);
}

.am-mate:hover,
.am-mate:focus-visible {
  background: var(--am-hover);
  border-color: rgb(var(--am-accent-rgb) / 0.45);
  transform: translateY(-1px);
}

.am-mate__art {
  flex: none;
  width: 42px;
  height: 42px;
  object-fit: cover;
  background: var(--am-fill-2);
  border-radius: var(--am-r-cap);
}

.am-mate__art--empty {
  display: grid;
  place-items: center;
  font-size: 17px;
  color: var(--am-faint);
}

.am-mate__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.am-mate__name {
  overflow: hidden;
  font-size: 13.5px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.am-mate__role {
  overflow: hidden;
  font-size: 11.5px;
  color: var(--am-faint);
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (prefers-reduced-motion: reduce) {
  .am-face__hit:hover .am-face__frame,
  .am-face__hit:focus-visible .am-face__frame,
  .am-mate:hover,
  .am-mate:focus-visible {
    transform: none;
  }
}
</style>
