<script setup lang="ts">
// Пункт 3.4: карточка аниме — только разметка (данные в media-card.ts, оформление в media-screen.css).
// Шапка — читаемое за полсекунды; доска ниже — детали; описание на широком окне уезжает в шапку.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import BrandMark from '../components/BrandMark.vue'
import EmptyMark from '../components/EmptyMark.vue'
import EntrySheet from '../components/EntrySheet.vue'
import PeopleBox from '../components/PeopleBox.vue'
import RichText from '../components/RichText.vue'
import ShotBox from '../components/ShotBox.vue'
import TuneBox from '../components/TuneBox.vue'
import { genreWord } from '../labels'
import { currentRoute, navigate } from '../router'

import { scoreText, useMediaCard } from './media-card'

/** Открыто ли окно правки записи. */
const sheetOpen = ref(false)

/** Знак сервиса для ярлычка оценки: словарь сводит ключи media-card.ts и знаки BrandMark. */
const MARK_BRAND: Record<string, 'anilist' | 'shikimori' | 'myanimelist'> = {
  al: 'anilist',
  shiki: 'shikimori',
  mal: 'myanimelist',
}

/** Граница «широкого окна»: та же, что у раскладки шапки в CSS. */
const WIDE_AT = '(min-width: 1400px)'

/** Широкое ли окно: от этого зависит, где живёт описание. */
const wide = ref(false)

let watchWide: MediaQueryList | null = null

function onWide(event: MediaQueryListEvent): void {
  wide.value = event.matches
}

const mediaId = computed<number>(() => {
  const raw = Number(currentRoute.value.params.id ?? '')
  return Number.isFinite(raw) && raw > 0 ? raw : 0
})

const {
  card,
  busy,
  trouble,
  franList,
  status,
  score10,
  progress,
  repeat,
  startedAt,
  completedAt,
  notes,
  partsTotal,
  listed,
  listLabel,
  mainTitle,
  heroStyle,
  about,
  aboutWait,
  aboutLinks,
  facts,
  ratings,
  franchiseRows,
  franchiseHidden,
  load,
  studioLogo,
  franchiseName,
  franchiseStatus,
  franchiseHint,
  franchisePlay,
  onPartSeen,
  openFranchiseWork,
  openStudio,
  onOpen,
  onPickStatus,
  onPickScore,
  onPickProgress,
  onPickRepeat,
  onPickStarted,
  onPickCompleted,
  onPickNotes,
} = useMediaCard(mediaId)

// Просмотр — отдельный экран со своим адресом, а не окно поверх карточки:
// его можно обновить, а тяжёлая карточка не висит в памяти под видео.
function openPlayer(): void {
  if (mediaId.value > 0) navigate('player', { id: String(mediaId.value) })
}

/** Подсказка метки доступности. Слов на самой метке нет: там только знак. */
function playHint(state: 'yes' | 'no' | null): string {
  return state === 'yes' ? 'Можно посмотреть' : 'Нет в каталоге'
}

onMounted(() => {
  const mq = window.matchMedia(WIDE_AT)
  wide.value = mq.matches
  mq.addEventListener('change', onWide)
  watchWide = mq

  void load()
})

onBeforeUnmount(() => {
  watchWide?.removeEventListener('change', onWide)
  watchWide = null
})

// Переход с карточки на карточку не пересобирает экран: грузим сами.
// Окно правки закрывается заодно: оно про запись прошлого аниме.
watch(mediaId, () => {
  sheetOpen.value = false
  void load()
})
</script>

<template>
  <section class="am-page">
    <div v-if="mediaId === 0" class="am-empty">
      <span class="am-empty__mark"><EmptyMark name="question" /></span>
      <span>Аниме не выбрано: в адресе нет номера.</span>
      <span>Откройте карточку из списков или поиска.</span>
    </div>

    <template v-else>
      <p v-if="trouble" class="am-error">{{ trouble }}</p>

      <div v-if="busy && !card" class="am-wait">
        <span class="am-skeleton am-wait__hero" />
        <span class="am-skeleton am-wait__line" />
        <span class="am-skeleton am-wait__line am-wait__line--short" />
      </div>

      <template v-if="card">
        <div class="am-hero" :class="{ 'am-hero--told': wide }">
          <div class="am-hero__art" :style="heroStyle" />
          <div class="am-hero__veil" />

          <div class="am-hero__body">
            <!-- Постер и текст — одной группой: иначе текст рос по содержимому
                 и вытеснял описание в узкую полосу справа. -->
            <div class="am-hero__lead">
              <!-- Постер и оценки площадок одной колонкой: ярлычки стоят под
                   картинкой и читаются её подписью, а не рядом пилюль у названия. -->
              <div class="am-hero__stack">
                <img
                  v-if="card.cover"
                  class="am-hero__cover"
                  :src="card.cover"
                  :alt="mainTitle"
                  decoding="async"
                />
                <span v-else class="am-hero__cover am-hero__cover--empty" aria-hidden="true">?</span>

                <!-- Площадка названа знаком, а не словом: так ярлычок вдвое короче,
                     название осталось в подсказке. -->
                <ul v-if="ratings.length > 0" class="am-hero__marks">
                  <li
                    v-for="rate in ratings"
                    :key="rate.key"
                    v-tip="`Средняя оценка на ${rate.label}`"
                    class="am-hero__mark"
                  >
                    <BrandMark
                      v-if="MARK_BRAND[rate.key]"
                      class="am-hero__markicon"
                      :name="MARK_BRAND[rate.key]!"
                    />
                    <span class="am-hero__markval">{{ rate.value }}</span>
                  </li>
                </ul>
              </div>

              <div class="am-hero__text">
                <h2 class="am-hero__title">{{ mainTitle }}</h2>
                <p v-if="card.romaji" class="am-hero__sub">{{ card.romaji }}</p>
                <p v-if="card.native" class="am-hero__sub">{{ card.native }}</p>

                <ul class="am-pills">
                  <li v-if="score10 > 0" v-tip="'Моя оценка'" class="am-pill am-pill--mine">
                    ★ {{ scoreText(score10) }}
                  </li>
                  <li v-for="item in facts" :key="item" class="am-pill">{{ item }}</li>
                  <li v-if="card.isAdult" class="am-pill am-pill--adult">18+</li>
                </ul>

                <ul v-if="card.genres.length > 0" class="am-pills">
                  <li v-for="genre in card.genres" :key="genre" class="am-pill am-pill--soft">
                    {{ genreWord(genre) }}
                  </li>
                </ul>

                <ul v-if="card.studios.length > 0" class="am-pills">
                  <li v-for="studio in card.studios" :key="studio.studioId">
                    <button
                      v-tip="`Работы студии ${studio.name}`"
                      class="am-pill am-pill--studio"
                      :class="{ 'am-pill--studio-main': studio.main }"
                      type="button"
                      @click="openStudio(studio.studioId)"
                    >
                      <img
                        v-if="studioLogo(studio.name)"
                        class="am-pill__logo"
                        :src="studioLogo(studio.name)!"
                        alt=""
                        loading="lazy"
                        decoding="async"
                      />
                      {{ studio.name }}
                    </button>
                  </li>
                </ul>

                <div class="am-acts">
                  <button
                    v-tip="'Источники спрашиваются при открытии плеера'"
                    class="am-acts__play"
                    type="button"
                    @click="openPlayer"
                  >
                    <span aria-hidden="true">▶</span>
                    <span>Смотреть</span>
                  </button>

                  <button class="am-acts__save" type="button" @click="sheetOpen = true">
                    <span v-if="listed" class="am-acts__dot" aria-hidden="true" />
                    {{ listLabel }}
                  </button>
                </div>
              </div>
            </div>

            <!-- Описание в шапке только на широком окне, иначе остаётся панелью ниже.
                 Текст со своей прокруткой: баннер не должен вытягиваться из-за болтливого источника. -->
            <div v-if="wide" class="am-hero__note">
              <h3 class="am-h3 am-hero__noteh">Описание</h3>

              <div class="am-hero__scroll">
                <RichText v-if="about" class="am-about am-about--art" :text="about" />
                <div v-else-if="aboutWait" class="am-about__hold" aria-hidden="true">
                  <span class="am-skeleton am-about__hold-line" />
                  <span class="am-skeleton am-about__hold-line" />
                  <span class="am-skeleton am-about__hold-line am-about__hold-line--short" />
                </div>
                <p v-else class="am-hero__sub">Описания ни один источник не дал.</p>
              </div>

              <p v-if="aboutLinks.length > 0" class="am-about__tail am-about__tail--art">
                <template v-for="(link, at) in aboutLinks" :key="link.key">
                  <span v-if="at > 0" class="am-about__dot" aria-hidden="true">·</span>
                  <a
                    v-tip="link.hint"
                    class="am-about__link"
                    :href="link.url"
                    @click.prevent="onOpen(link.url)"
                    >{{ link.text }}</a
                  >
                </template>
              </p>
            </div>
          </div>
        </div>

        <div class="am-board">
          <!-- На широком окне панели описания здесь нет: текст ушёл в шапку.
               Обёртка сквозная: плиткой сетка считает саму панель. -->
          <div v-if="!wide" class="am-split__main">
            <div class="am-panel am-about-box">
              <h3 class="am-h3">Описание</h3>
              <!-- Разметка источника живая: ссылки, спойлеры и начертания рисует
                   компонент, а типографика .am-about остаётся на его корне. -->
              <RichText v-if="about" class="am-about" :text="about" />
              <div v-else-if="aboutWait" class="am-about__hold" aria-hidden="true">
                <span class="am-skeleton am-about__hold-line" />
                <span class="am-skeleton am-about__hold-line" />
                <span class="am-skeleton am-about__hold-line am-about__hold-line--short" />
              </div>
              <p v-else class="am-dim">Описания ни один источник не дал.</p>

              <p v-if="aboutLinks.length > 0" class="am-about__tail">
                <template v-for="(link, at) in aboutLinks" :key="link.key">
                  <span v-if="at > 0" class="am-about__dot" aria-hidden="true">·</span>
                  <a
                    v-tip="link.hint"
                    class="am-about__link"
                    :href="link.url"
                    @click.prevent="onOpen(link.url)"
                    >{{ link.text }}</a
                  >
                </template>
              </p>
            </div>
          </div>

          <!-- Музыка и франшиза делят ряд поровну. Обёртка сквозная: блок молчит, когда тем нет, и
               пустой колонки после себя не оставляет. -->
          <ShotBox
            :media-id="mediaId"
            :mal-id="card.malId"
            :trailer="card.trailer"
          />

          <div v-if="franchiseRows.length > 0" class="am-panel am-fran">
            <h3 class="am-h3">Франшиза</h3>

            <!-- v-seen сообщает о первом показе плитки: источники видео спрашиваются
                 только о показанных частях. Директива в app/see-tile.ts, глобально в main.ts. -->
            <div ref="franList" class="am-rail">
              <!-- Ключ по записи, а не по узлу Шикимори: у раздробленной части
                   строк несколько, и все они при одном номере MAL. -->
              <article
                v-for="work in franchiseRows"
                :key="work.mediaId ?? work.malId ?? work.name"
                v-seen="() => onPartSeen(work)"
                class="am-part"
              >
                <button
                  v-if="work.mediaId !== null && work.mediaId !== mediaId"
                  v-tip="franchiseHint(work)"
                  class="am-part__hit"
                  type="button"
                  @click="openFranchiseWork(work)"
                >
                  <img
                    v-if="work.cover"
                    class="am-part__art"
                    :src="work.cover"
                    :alt="work.name"
                    loading="lazy"
                    decoding="async"
                  />
                  <span v-else class="am-part__art am-part__art--empty" aria-hidden="true">
                    {{ work.name.slice(0, 1) }}
                  </span>
                  <span class="am-part__year">{{ work.year ?? '···' }}</span>
                  <span class="am-part__name">{{ franchiseName(work) }}</span>
                  <!-- Молчание метки — это «не спрашивали», а не «нет»: пока источники
                       не высказались все, на карточке не рисуется ничего. -->
                  <span
                    v-if="franchisePlay(work) !== null"
                    v-tip="playHint(franchisePlay(work))"
                    class="am-part__play"
                    :class="{ 'am-part__play--none': franchisePlay(work) === 'no' }"
                    role="img"
                    :aria-label="playHint(franchisePlay(work))"
                  />
                  <span v-if="franchiseStatus(work)" class="am-part__status">
                    {{ franchiseStatus(work) }}
                  </span>
                </button>
                <div
                  v-else
                  v-tip="franchiseHint(work)"
                  class="am-part__hit am-part__hit--still"
                  :class="{ 'am-part__hit--here': work.mediaId === mediaId }"
                >
                  <img
                    v-if="work.cover"
                    class="am-part__art"
                    :src="work.cover"
                    :alt="work.name"
                    loading="lazy"
                    decoding="async"
                  />
                  <span v-else class="am-part__art am-part__art--empty" aria-hidden="true">
                    {{ work.name.slice(0, 1) }}
                  </span>
                  <span class="am-part__year">{{ work.year ?? '···' }}</span>
                  <span class="am-part__name">{{ franchiseName(work) }}</span>
                  <span
                    v-if="franchisePlay(work) !== null"
                    v-tip="playHint(franchisePlay(work))"
                    class="am-part__play"
                    :class="{ 'am-part__play--none': franchisePlay(work) === 'no' }"
                    role="img"
                    :aria-label="playHint(franchisePlay(work))"
                  />
                  <span v-if="work.mediaId === mediaId" class="am-part__here">вы здесь</span>
                  <span v-else-if="franchiseStatus(work)" class="am-part__status">
                    {{ franchiseStatus(work) }}
                  </span>
                </div>
              </article>
            </div>

            <p v-if="franchiseHidden > 0" class="am-fran__hidden">
              Скрыто с меткой 18+: {{ franchiseHidden }}
            </p>
          </div>

          <div class="am-board__folk">
            <PeopleBox :media-id="mediaId" />
          </div>
        </div>

        <!-- Музыка последним в странице и липнет к низу окна: место в раскладке
             карточки ей не отведено, а под низом окна оставлено поле (padding у .am-view). -->
        <TuneBox :mal-id="card.malId" />

        <!-- Признак онгоинга нужен окну для автозакладки: у идущего сезона потолок счёта —
             последняя вышедшая серия, и дошедший до края счёт ещё не значит «просмотрено». -->
        <EntrySheet
          v-if="sheetOpen"
          :title="mainTitle"
          :status="status"
          :score10="score10"
          :progress="progress"
          :parts-total="partsTotal"
          :ongoing="card.airingEpisode !== null"
          :repeat="repeat"
          :started-at="startedAt"
          :completed-at="completedAt"
          :notes="notes"
          @close="sheetOpen = false"
          @status="onPickStatus"
          @score="onPickScore"
          @progress="onPickProgress"
          @repeat="onPickRepeat"
          @started-at="onPickStarted"
          @completed-at="onPickCompleted"
          @notes="onPickNotes"
        />
      </template>
    </template>
  </section>
</template>

<style scoped src="./media-screen.css"></style>

<!-- Основное оформление в media-screen.css. Здесь метка доступности, ярлычки оценок
     и раскладка доски: правила рядом с разметкой, которая их завела. -->
<style scoped>
/* Тот же знак, что на плитках, только мельче. Постер здесь — сама картинка,
   а не слой с углами, поэтому знак стоит строкой под ней, а не поверх. */
.am-part__play {
  display: grid;
  place-items: center;
  align-self: center;
  width: 16px;
  height: 16px;
  color: var(--am-accent);
}

/* clip-path, а не рамки: так треугольник остаётся ровно в центре своего
   квадрата и поверх него можно положить перечёркивание. */
.am-part__play::before {
  grid-area: 1 / 1;
  width: 9px;
  height: 11px;
  content: '';
  background: currentcolor;
  clip-path: polygon(0 0, 100% 50%, 0 100%);
}

/* «Нет в каталоге»: тот же знак, но серый и перечёркнутый. Это отсутствие
   в нашем плеере, а не свойство аниме. */
.am-part__play--none {
  color: var(--am-dim);
}

.am-part__play--none::after {
  grid-area: 1 / 1;
  width: 17px;
  height: 2px;
  content: '';
  background: currentcolor;
  border-radius: 1px;
  transform: rotate(-45deg);
}

/* Колонка постера: ширина живёт здесь, а не на картинке, чтобы ярлычки
   под ней переносились ровно по её краю, а не по своей сумме. */
.am-hero__stack {
  display: flex;
  flex: none;
  flex-direction: column;
  gap: 12px;
  width: clamp(150px, 13vw, 226px);
}

.am-hero__stack .am-hero__cover {
  width: 100%;
}

/* Оценки площадок — ярлычки под постером. Ряд по центру и не растягивается:
   не влезший знак переносится под первые и остаётся посередине. */
.am-hero__marks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: center;
  margin: 0;
  padding: 0;
  list-style: none;
}

/* Стекло той же выделки, что пилюли у названия: плотная заливка на светлом
   кадре читалась заплатками. Знак и цифра в одну строку: слова разгоняли ярлычки. */
.am-hero__mark {
  display: flex;
  flex: 0 1 auto;
  gap: 6px;
  align-items: center;
  min-width: 0;
  padding: 5px 8px;
  background: color-mix(in srgb, var(--am-veil) 44%, transparent);
  border: 1px solid color-mix(in srgb, var(--am-on-art) 14%, transparent);
  border-radius: var(--am-r-cap);
  backdrop-filter: blur(10px) saturate(1.2);
  transition: border-color var(--am-fast) var(--am-ease);
}

.am-hero__mark:hover {
  border-color: color-mix(in srgb, var(--am-warn) 52%, transparent);
}

/* Знак мелкий, но не мельче: ниже 14 пикселей буквы плит перестают
   различаться и все три ярлычка выглядят одинаковыми. */
.am-hero__markicon {
  width: 18px;
  height: 18px;
}

.am-hero__markval {
  font-size: 15.5px;
  font-weight: 700;
  line-height: 1.15;
  color: var(--am-on-art);
  font-variant-numeric: tabular-nums;
}

/* Проба вида: описание стоит по оси баннера, как постер и название, а не тянется
   во всю его высоту — иначе короткий текст прижимался к верху, оставляя пустоту снизу. */
.am-hero--told .am-hero__note {
  align-self: center;
  justify-content: center;
  height: auto;
}

/* Прокрутка у описания остаётся, но блок больше не занимает всю
   свободную высоту: растёт только до своего потолка и стоит по центру. */
.am-hero--told .am-hero__scroll {
  flex: 0 1 auto;
}

/* Стекло гаснет ко всем трём краям блока, а не только влево: иначе оставались резкие полосы кадра.
   Масок две пересечением: одним градиентом не задать разную длину растворения по осям. */
.am-hero--told .am-hero__note::before {
  -webkit-mask-image:
    linear-gradient(90deg, transparent 0%, #000 34%),
    linear-gradient(180deg, transparent 0%, #000 18%, #000 82%, transparent 100%);
  mask-image:
    linear-gradient(90deg, transparent 0%, #000 34%),
    linear-gradient(180deg, transparent 0%, #000 18%, #000 82%, transparent 100%);
  -webkit-mask-composite: source-in;
  mask-composite: intersect;
}

/* Плитки доски берут свою высоту, а не тянутся по соседу: растянутая панель оставляет пустоту.
   `:deep` у кадров: у компонента пять корней, Vue не передаёт ему признак области (filterSingleRoot). */
.am-board > :deep(.am-shots),
.am-board > .am-fran {
  align-self: start;
}

/* Рядом с кадрами франшиза тянется по ряду: высоту задают кадры, и низы сходятся на любой ширине.
   `contain: size` — содержимое списка не задаёт высоту ряда: иначе кадры стояли бы в пустой панели. */
.am-board:has(.am-shots) > .am-fran {
  align-self: stretch;
  contain: size;
}

/* Потолка у списка рядом с кадрами нет: высоту ему задаёт ряд. */
.am-board:has(.am-shots) .am-fran .am-rail {
  max-height: none;
}

/* Доска: ряд из двух равных колонок вместо плотного потока по измерению — для трёх плиток
 * скрипт-измеритель был ценой без выгоды: перекладки и лесенка. */
.am-board {
  /* Высота строки хронологии: миниатюра 32px при 2/3 плюс поля. Потолок плитки
     считается строками, а не долей экрана: доля давала то три, то шесть строк. */
  --am-fran-row: 58px;

  grid-auto-flow: row;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: stretch;
}

/* Описание и люди — полосы во всю ширину: текст в половину доски
   читался столбиком, а ряд портретов в одной колонке вставал лестницей. */
.am-board .am-about-box,
.am-board .am-board__folk {
  grid-column: 1 / -1;
}

/* Плитка-одиночка занимает весь ряд: у половины тайтлов нет кадров или франшизы,
   и вторая колонка оставалась бы дырой. Проверяем панели, а не обёртки. */
.am-board:not(:has(.am-shots)) .am-fran {
  grid-column: 1 / -1;
}

/* Кадры без франшизы растягиваются через доску: колонка принадлежит доске, она и решает.
   Правило прямо на плитке не совпадало ни с чем — у неё пять корней без признака области. */
.am-board:not(:has(.am-fran)) {
  grid-template-columns: minmax(0, 1fr);
}

/* Хронология в плитке-одиночке — мозаикой два на два: иначе справа пустая полоса.
   Сетка жёсткая по осям: раньше третье наименование уходило третьим столбцом и обрезалось краем. */
.am-board:not(:has(.am-shots)) .am-fran .am-rail {
  display: grid;
  grid-auto-flow: row;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  grid-auto-rows: var(--am-fran-row);
  gap: 2px 14px;
  align-content: start;
  max-height: calc(2 * var(--am-fran-row) + 2px);
  overflow-x: hidden;
  overflow-y: auto;
}

/* Строка мозаики не должна вылезать за свой столбец: без обрезки длинное
   название растягивало столбец и ломало равенство колонок. */
.am-board:not(:has(.am-shots)) .am-fran .am-rail .am-part {
  min-width: 0;
  overflow: hidden;
}

/* Список берёт высоту строки, но не выше четырёх наименований: дальше прокрутка.
   Прежний потолок долей экрана резал последнюю строку посередине. */
.am-board .am-fran .am-rail {
  flex: 1 1 auto;
  min-height: 0;
  max-height: calc(4 * var(--am-fran-row) + 6px);
}

/* Узкое окно — одна колонка: сетка кадров и строки франшизы в половине
   такой ширины уже не читаются. */
@media (max-width: 1000px) {
  .am-board {
    grid-template-columns: minmax(0, 1fr);
  }

  /* В одну колонку высоту франшизе взять не у кого: тянуться по соседу она может
     только в паре с кадрами. Здесь снова считаем содержимое и возвращаем потолок строками. */
  .am-board:has(.am-shots) > .am-fran {
    contain: none;
  }

  .am-board:has(.am-shots) .am-fran .am-rail {
    max-height: calc(4 * var(--am-fran-row) + 6px);
  }

  .am-board:not(:has(.am-shots)) .am-fran .am-rail {
    display: flex;
    max-height: calc(4 * var(--am-fran-row) + 6px);
  }
}
</style>
