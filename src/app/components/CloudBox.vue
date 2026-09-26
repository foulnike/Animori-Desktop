<script setup lang="ts">
// Облачная копия своим узлом: место, вход, копия туда и обратно; каждую кнопку нажимает человек.
// Запись поверх незнакомой копии спрашивает; чтение по ссылке не требует ни пропуска, ни места.
import { onMounted, ref } from 'vue'

import { Bridge } from '@/bridge'
import {
  checkChosenPlace,
  checkPlace,
  choosePlace,
  cloudPathText,
  copyInfo,
  linkInfo,
  pullByLink,
  pullCopy,
  saveCopy,
  shareCopy,
  unshareCopy,
  type CloudLink,
  type CloudStranger,
} from '@/core/cloud'
import type { PullMode } from '@/core/collection'
import { saveSetting, settings } from '@/core/settings'

import BrandMark from './BrandMark.vue'
import CloudHelp from './CloudHelp.vue'

const props = defineProps<{
  /** Записей в списке сейчас: это число стоит в вопросах перед заменой. */
  list: number
  /** Как звать это устройство в файле копии. */
  device: string
}>()

/** Список сменился: копия легла поверх, и числа снаружи пора переспросить. */
const emit = defineEmits<{ changed: [] }>()

/** Где лежит копия. Списывается с настроек один раз: объект настроек не реактивен. */
const cloudPlace = ref(settings.cloudPlace)

/** Есть ли сохранённый пропуск. Хранится признак, а не сам пропуск: в разметку ему попадать незачем. */
const cloudSaved = ref(settings.cloudToken !== '')

/** Вставленный, но ещё не проверенный пропуск. Живёт только до сохранения. */
const tokenDraft = ref('')

/** Открыто ли поле пропуска при уже сохранённом: смена бывает редко. */
const tokenOpen = ref(false)

const cloudSavedAt = ref(settings.cloudSavedAt)
const cloudSavedCount = ref(settings.cloudSavedCount)

/** Что лежит в облаке сейчас, строкой. Пустая строка — «не спрашивали». */
const cloudThere = ref('')

/** Ссылка на нашу копию. В настройках не хранится: публикация может пропасть при перезаписи,
 *  поэтому ссылку всегда спрашивают у облака заново. */
const shareLink = ref('')

/** Ссылка, введённая для чтения чужой копии. */
const linkDraft = ref('')

/** Что нашлось по введённой ссылке. null — ещё не искали или не нашли. */
const linkFound = ref<CloudLink | null>(null)

/** Открыта ли справка. Состояние здесь, а не внутри неё: нажимают отсюда. */
const helpOpen = ref(false)

// Своя заметка и своя ошибка: отказ облака не должен красить соседние панели
// настроек и затирать их ответы.
const cloudNote = ref('')
const cloudError = ref('')
const cloudBusy = ref(false)

/** Спрошено ли подтверждение перед тем, как копия ляжет поверх списка. */
const askingCloud = ref(false)

/** Незнакомая копия, найденная перед записью; null — вопроса нет. Хранится сама находка:
 *  размер и время чужой копии — то, по чему человек решает, замещать её или забрать. */
const strangerAsk = ref<CloudStranger | null>(null)

/** Где человек берёт пропуск к Яндекс Диску. Своего приложения у сборки нет. */
const YANDEX_OAUTH_URL = 'https://oauth.yandex.com/client/new/'

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/// Ошибки показываются рядом с кнопкой, а не глотаются: молчаливый catch
/// здесь означал бы кнопку, которая не делает ничего и не говорит почему.
async function cloudGuard(action: () => Promise<void>): Promise<void> {
  cloudBusy.value = true
  cloudError.value = ''
  try {
    await action()
  } catch (e) {
    cloudError.value = describe(e)
  } finally {
    cloudBusy.value = false
  }
}

/** Готово ли облако к работе: место выбрано и пропуск к нему сохранён. */
function cloudOn(): boolean {
  return cloudPlace.value === 'yandex' && cloudSaved.value
}

/** Показывать ли поле пропуска: пока его нет или пока меняют руками. */
function tokenNeeded(): boolean {
  return cloudPlace.value === 'yandex' && (!cloudSaved.value || tokenOpen.value)
}

/// Подпись под названием площадки: одна строка на все состояния,
/// а не три абзаца в разных местах панели, как раньше.
function placeNote(): string {
  if (cloudPlace.value !== 'yandex') return 'Копия списка одним файлом в папке приложения'
  if (!cloudSaved.value) return 'Пропуск не сохранён'
  if (cloudThere.value === '') return 'На связи'
  return `В облаке: ${cloudThere.value}`
}

/// Время человеку — местное и словами. Ноль и нечитаемая дата дают прочерк:
/// «1 января 1970» на месте «копии не было» хуже пустоты.
function whenText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return new Date(ms).toLocaleString('ru-RU')
}

/// Размер копии в килобайтах: байты человеку ничего не говорят, а мегабайта
/// список не набирает даже в тысячу записей.
function sizeText(bytes: number): string {
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`
}

/// Чужая копия одной строкой: размер и время правки. Ровно те два числа,
/// по которым видно, свежее там или старее нашего.
function strangerText(found: CloudStranger): string {
  const when = found.modified === null ? '' : ` · ${whenText(Date.parse(found.modified))}`
  return `${sizeText(found.bytes)}${when}`
}

/// Хвост ссылки: то немногое, что придётся набирать пультом. Ядро принимает
/// и хвост, и ссылку целиком, поэтому показываем короткое.
function linkTail(link: string): string {
  const cut = link.replace(/\/+$/, '')
  return cut.slice(cut.lastIndexOf('/') + 1)
}

/** Спрашивает облако, что там лежит. Отказ не кричит: это строка факта, а не ответ на нажатие;
 *  красная надпись пугала бы там, где всего лишь нет сети. Кнопки ниже скажут громко. */
async function readCloud(): Promise<void> {
  if (!cloudOn()) {
    cloudThere.value = ''
    shareLink.value = ''
    return
  }

  const got = await copyInfo()
  if (!got.ok) {
    cloudThere.value = 'спросить не удалось'
    return
  }

  // Ссылка приходит вместе со сведениями о файле: отдельный запрос ради неё
  // был бы лишним, а пропавшую публикацию видно сразу.
  shareLink.value = got.value.share ?? ''

  if (!got.value.there) {
    cloudThere.value = 'копии нет'
    return
  }

  const when = got.value.modified === null ? '' : ` · ${whenText(Date.parse(got.value.modified))}`
  cloudThere.value = `${sizeText(got.value.bytes)}${when}`
}

/** Подключение площадки. Смена места стирает память о чужой копии и прошлые числа:
 *  в другом облаке другой файл. Здесь остаётся переспросить и открыть поле пропуска. */
function onConnect(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''
    strangerAsk.value = null

    if (cloudPlace.value !== 'yandex') {
      await choosePlace('yandex')
      cloudPlace.value = 'yandex'
      cloudSavedAt.value = settings.cloudSavedAt
      cloudSavedCount.value = settings.cloudSavedCount
      cloudThere.value = ''
      shareLink.value = ''
    }

    tokenOpen.value = true
    await readCloud()
  })
}

/** Проверка и сохранение пропуска. Проверяется ДО записи: молча запомнить негодную строку —
 *  соврать, что облако подключено. */
function onCloudToken(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    const token = tokenDraft.value.trim()
    const done = await checkPlace(token)
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    await saveSetting('cloudToken', 'am_cloud_token', token)
    cloudSaved.value = true
    tokenDraft.value = ''
    tokenOpen.value = false
    cloudNote.value = 'Пропуск принят: Яндекс Диск на связи.'
    await readCloud()
  })
}

/// Отказ от смены пропуска. Черновик стирается: недонабранная строка,
/// всплывшая через месяц, читалась бы как сохранённый пропуск.
function onTokenCancel(): void {
  tokenDraft.value = ''
  tokenOpen.value = false
}

/** Пропуск выдаёт сам Яндекс: адрес открывает оболочка, окно ходит только к API. */
function onCloudHelp(): void {
  void Bridge.shell.openExternal(YANDEX_OAUTH_URL)
}

/** Проверка связи по кнопке: пропуск можно отозвать со стороны, и узнать об этом лучше сейчас. */
function onCloudCheck(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    const done = await checkChosenPlace()
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    cloudNote.value = 'Связь есть: пропуск годен и папка копии доступна.'
    await readCloud()
  })
}

/** Запись копии: метка устройства идёт в файл, чтобы на ТВ было видно, с какой машины копия.
 *  Отказ двух видов: незнакомая копия — вопрос в своём узле, всё прочее — красная строка. */
async function writeCopy(force: boolean): Promise<void> {
  cloudNote.value = ''

  const done = await saveCopy(props.device, force)
  if (!done.ok) {
    if (done.stranger !== undefined) {
      strangerAsk.value = done.stranger
      return
    }

    cloudError.value = done.problem
    return
  }

  strangerAsk.value = null
  cloudSavedAt.value = done.value.savedAt
  cloudSavedCount.value = done.value.count
  cloudNote.value = `Копия сохранена: записей ${done.value.count}, ${sizeText(done.value.bytes)}.`
  await readCloud()
}

function onCloudSave(): void {
  strangerAsk.value = null
  void cloudGuard(() => writeCopy(false))
}

/** «Заменить»: та же запись, но с явным разрешением затереть чужую копию. */
function onCloudReplace(): void {
  strangerAsk.value = null
  void cloudGuard(() => writeCopy(true))
}

/// «Сначала забрать»: вопрос сменяется вопросом о способе, ничего не записывается —
/// человек почти всегда хочет сперва увидеть чужие записи у себя.
function onStrangerPull(): void {
  strangerAsk.value = null
  onCloudAsk()
}

function onStrangerCancel(): void {
  strangerAsk.value = null
}

/** Нажатие «Забрать»: сначала вопрос — копия ляжет поверх живого списка. */
function onCloudAsk(): void {
  cloudNote.value = ''
  cloudError.value = ''
  askingCloud.value = true
}

function onCloudCancel(): void {
  askingCloud.value = false
}

/** Возвращение копии. Числа как у переноса с AniList: после слияния важно,
 *  что стало с набранным здесь, а не общее число. */
function onCloudPull(mode: PullMode): void {
  askingCloud.value = false

  void cloudGuard(async () => {
    cloudNote.value = ''

    const done = await pullCopy(mode)
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    // Список сменился: числа снаружи переспрашивает тот, кто их показывает.
    emit('changed')

    // Прочитанная копия теперь знакомая, и панель говорит о ней же:
    // числа обновляет ядро, здесь остаётся их переспросить.
    cloudSavedAt.value = settings.cloudSavedAt
    cloudSavedCount.value = settings.cloudSavedCount

    cloudNote.value = pullText(done.value)
    await readCloud()
  })
}

/// Итог возвращения словами. Один текст на оба пути — по пропуску и по ссылке:
/// разница и так видна по нажатой кнопке.
function pullText(got: {
  mode: PullMode
  total: number
  added: number
  updated: number
  kept: number
  onlyHere: number
  dropped: number
  from: { device: string }
}): string {
  const from = got.from.device === '' ? '' : ` Копия с устройства «${got.from.device}».`
  const lost = got.dropped > 0 ? ` Битых записей в копии: ${got.dropped} — их пропустили.` : ''

  return got.mode === 'replace'
    ? `Список замещён копией: записей ${got.total}.${from}${lost}`
    : `Копия приложена: всего ${got.total}, новых ${got.added}, ` +
        `обновлено ${got.updated}, своих правок сохранено ${got.kept}, ` +
        `только здесь ${got.onlyHere}.${from}${lost}`
}

/** Публикация копии: единственное место, где список доступен кому-то ещё, — предупреждение под ссылкой.
 *  Повторное нажатие законно и вернёт ту же ссылку, если перезапись файла сбросила публикацию. */
function onShare(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    const done = await shareCopy()
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    shareLink.value = done.value
    cloudNote.value = 'Ссылка готова. На другом устройстве достаточно набрать её хвост.'
  })
}

/** Закрытие доступа. Сам файл копии остаётся на месте и в работе. */
function onUnshare(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    const done = await unshareCopy()
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    shareLink.value = ''
    cloudNote.value = 'Доступ по ссылке закрыт. Файл копии остался на месте.'
  })
}

/** Адрес ссылки открывает оболочка: по нему браузер просто скачает файл. */
function onShareOpen(): void {
  if (shareLink.value === '') return
  void Bridge.shell.openExternal(shareLink.value)
}

/** Поиск копии по ссылке: пропуска не требует — на этом держится первый запуск без клавиатуры.
 *  Сперва показываются размер и время, и только потом предлагается положить копию поверх списка. */
function onLinkFind(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''
    linkFound.value = null

    const done = await linkInfo(linkDraft.value.trim())
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    linkFound.value = done.value
  })
}

function onLinkCancel(): void {
  linkFound.value = null
}

/** Чтение по ссылке. Отметок о своей копии не двигает: их у читателя нет. */
function onLinkPull(mode: PullMode): void {
  const found = linkFound.value
  if (found === null) return

  linkFound.value = null

  void cloudGuard(async () => {
    cloudNote.value = ''

    const done = await pullByLink(found.key, mode)
    if (!done.ok) {
      cloudError.value = done.problem
      return
    }

    emit('changed')
    linkDraft.value = ''
    cloudNote.value = pullText(done.value)
  })
}

/** Отключение облака: файл на Диске остаётся нетронутым — стирать чужое хранилище программа не вправе.
 *  Память о правке стирается с пропуском: с новым пропуском прежняя метка выдала бы чужую копию за свою. */
function onCloudForget(): void {
  void cloudGuard(async () => {
    cloudNote.value = ''

    await saveSetting('cloudToken', 'am_cloud_token', '')
    await choosePlace('none')

    cloudPlace.value = 'none'
    cloudSaved.value = false
    cloudSavedAt.value = 0
    cloudSavedCount.value = 0
    cloudThere.value = ''
    shareLink.value = ''
    tokenDraft.value = ''
    tokenOpen.value = false
    strangerAsk.value = null

    cloudNote.value = 'Облако отключено. Файл копии на Диске остался нетронутым.'
  })
}

onMounted(() => {
  void readCloud()
})
</script>

<template>
  <div class="am-panel am-box">
    <div class="am-bar">
      <h3 class="am-h3">Облачная копия</h3>
      <span class="am-bar__gap" />
      <span class="am-flag" :class="{ 'am-flag--on': cloudOn() }">
        <span class="am-flag__dot" aria-hidden="true" />
        {{ cloudOn() ? 'подключено' : 'не подключено' }}
      </span>
    </div>

    <!-- Площадка строкой: знак, название, состояние и действия; служебные — значками с подсказками.
         Знак — components/BrandMark.vue: фирменного вектора Диска нет, узнаваемость даёт плита цвета. -->
    <div class="am-place">
      <BrandMark class="am-place__mark" name="yandex-disk" />

      <span class="am-place__text">
        <span class="am-place__name">Яндекс Диск</span>
        <span class="am-place__note">{{ placeNote() }}</span>
      </span>

      <button
        v-tip="'Подробно: как это устроено и где взять пропуск'"
        class="am-icon"
        type="button"
        aria-label="Как это работает"
        @click="helpOpen = true"
      >
        i
      </button>

      <span class="am-place__acts">
        <template v-if="cloudOn()">
          <button
            v-tip="'Проверить связь: годен ли пропуск и на месте ли папка копии'"
            class="am-icon"
            type="button"
            aria-label="Проверить связь"
            :disabled="cloudBusy"
            @click="onCloudCheck"
          >
            ↻
          </button>
          <button
            v-tip="'Сменить пропуск'"
            class="am-icon"
            type="button"
            aria-label="Сменить пропуск"
            :disabled="cloudBusy || tokenOpen"
            @click="tokenOpen = true"
          >
            🔑
          </button>
          <button
            v-tip="'Отключить облако: забыть пропуск. Файл копии на Диске останется'"
            class="am-icon"
            type="button"
            aria-label="Отключить облако"
            :disabled="cloudBusy"
            @click="onCloudForget"
          >
            ✕
          </button>
        </template>

        <button
          v-else
          v-tip="'Ввести пропуск Яндекс Диска'"
          class="am-btn"
          type="button"
          :disabled="cloudBusy || tokenNeeded()"
          @click="onConnect"
        >
          Подключить
        </button>
      </span>
    </div>

    <!-- Прежний выбор Google: место считается невыбранным, и об этом сказано
         прямо. Подставить другое облако молча программа не вправе. -->
    <p v-if="cloudPlace === 'google'" class="am-meta">
      Google Диск убран из программы: вход с устройства не давал скрытой папки, а без проверки
      Google пропуск умирал за неделю. Подключите Яндекс Диск — файл копии в Google Диске остался
      на месте и никуда не денется.
    </p>

    <!-- Пропуск вставляется руками: готовых Яндекс не выдаёт. Порядок по шагам
         живёт в справке под «i», здесь только адрес и поле. -->
    <template v-if="tokenNeeded()">
      <p class="am-meta">
        Пропуск выдаёт сам Яндекс: заведите приложение с правом «Приложения на Диске» на
        <button class="am-link" type="button" @click="onCloudHelp">oauth.yandex.com</button>
        и вставьте выданный токен сюда. Он останется на этом устройстве. Порядок по шагам — под
        кнопкой «i».
      </p>

      <div class="am-row">
        <label class="am-field">
          <input
            v-model="tokenDraft"
            class="am-input"
            type="password"
            placeholder="Пропуск Яндекс Диска"
          />
        </label>
        <button
          class="am-btn"
          type="button"
          :disabled="cloudBusy || !tokenDraft.trim()"
          @click="onCloudToken"
        >
          {{ cloudBusy ? 'Проверяем…' : 'Проверить и сохранить' }}
        </button>
        <button
          v-if="cloudSaved"
          class="am-btn am-btn--ghost"
          type="button"
          :disabled="cloudBusy"
          @click="onTokenCancel"
        >
          Отмена
        </button>
      </div>
    </template>

    <template v-if="cloudPlace === 'yandex'">
      <!-- То, что делают каждый день: две крупные кнопки со значком направления —
           общепринятый лоток со стрелкой; направление продублировано словами. -->
      <div class="am-duo">
        <button
          v-tip="'Записать нынешний список в облако. Незнакомую копию не затрёт без спроса'"
          class="am-duo__btn"
          type="button"
          :disabled="!cloudOn() || cloudBusy"
          @click="onCloudSave"
        >
          <svg
            class="am-duo__mark"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M12 3v13" />
            <path d="m7 8 5-5 5 5" />
          </svg>
          <span class="am-duo__name">{{ cloudBusy ? 'Работаем…' : 'Сохранить' }}</span>
          <span class="am-duo__note">список → облако</span>
        </button>

        <button
          v-tip="'Забрать копию из облака: слиянием или с заменой'"
          class="am-duo__btn"
          type="button"
          :disabled="!cloudOn() || cloudBusy"
          @click="onCloudAsk"
        >
          <svg
            class="am-duo__mark"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <path d="M12 4v13" />
            <path d="m7 12 5 5 5-5" />
          </svg>
          <span class="am-duo__name">Забрать</span>
          <span class="am-duo__note">облако → список</span>
        </button>
      </div>

      <ul class="am-facts">
        <li class="am-fact">
          <span class="am-fact__name">Файл копии</span>
          <span class="am-fact__value"><code>{{ cloudPathText() }}</code></span>
        </li>
        <li class="am-fact">
          <span class="am-fact__name">Последняя копия</span>
          <span class="am-fact__value">{{ whenText(cloudSavedAt) }}</span>
        </li>
        <li class="am-fact">
          <span class="am-fact__name">Записей в копии</span>
          <span class="am-fact__value">
            {{ cloudSavedCount > 0 ? cloudSavedCount : '—' }}
          </span>
        </li>
      </ul>

      <!-- Незнакомая копия: узел вопроса как у переноса, но первым стоит «Сначала забрать» —
           предлагать необратимую замену главной кнопкой значило бы толкать под руку. -->
      <div v-if="strangerAsk" class="am-ask">
        <p class="am-ask__text">
          В облаке копия, которую писали не мы: {{ strangerText(strangerAsk) }}. Здесь записей:
          {{ list }}.
        </p>

        <div class="am-row">
          <button class="am-btn" type="button" :disabled="cloudBusy" @click="onStrangerPull">
            Сначала забрать
          </button>
          <button
            v-tip="'Записать свой список поверх. Чужую копию не вернуть'"
            class="am-btn am-btn--ghost"
            type="button"
            :disabled="cloudBusy"
            @click="onCloudReplace"
          >
            Заменить копию
          </button>
          <button class="am-btn am-btn--ghost" type="button" @click="onStrangerCancel">
            Отмена
          </button>
        </div>
      </div>

      <!-- Копия ложится поверх живого списка: спрашиваем всегда, теми же
           словами и тем же узлом, что и перенос с AniList. -->
      <div v-if="askingCloud" class="am-ask">
        <p class="am-ask__text">Записей: {{ list }}.</p>

        <div class="am-row">
          <button class="am-btn" type="button" :disabled="cloudBusy" @click="onCloudPull('merge')">
            Добавить недостающее
          </button>
          <button
            class="am-btn am-btn--ghost"
            type="button"
            :disabled="cloudBusy"
            @click="onCloudPull('replace')"
          >
            Заменить целиком
          </button>
          <button class="am-btn am-btn--ghost" type="button" @click="onCloudCancel">Отмена</button>
        </div>
      </div>

      <!-- Ссылка своим разделом: это не ещё одна кнопка в общем ряду,
           а единственное место, где список открывается кому-то ещё. -->
      <template v-if="cloudOn()">
        <p class="am-sub">Ссылка для телевизора</p>

        <div class="am-row">
          <button
            v-if="!shareLink"
            v-tip="'Опубликовать файл копии и получить короткую ссылку на него'"
            class="am-btn am-btn--ghost"
            type="button"
            :disabled="cloudBusy"
            @click="onShare"
          >
            Создать ссылку
          </button>

          <template v-else>
            <label class="am-field">
              <input class="am-input" type="text" readonly :value="shareLink" />
            </label>
            <button
              v-tip="'Открыть ссылку в браузере'"
              class="am-icon"
              type="button"
              aria-label="Открыть ссылку"
              @click="onShareOpen"
            >
              ↗
            </button>
            <button
              v-tip="'Закрыть доступ по ссылке. Файл копии останется на месте'"
              class="am-btn am-btn--ghost"
              type="button"
              :disabled="cloudBusy"
              @click="onUnshare"
            >
              Закрыть доступ
            </button>
          </template>
        </div>

        <p v-if="shareLink" class="am-meta">
          На телевизоре набирают только хвост — <code>{{ linkTail(shareLink) }}</code> — в поле
          «Забрать по ссылке» ниже. По ссылке копию прочитает любой, кто её знает; когда перенос
          закончен, доступ можно закрыть.
        </p>
        <p v-else class="am-meta">
          Пропуск пультом не набрать. Ссылка даёт короткий хвост — его и вводят на телевизоре.
        </p>
      </template>
    </template>

    <!-- Чтение по ссылке стоит последним и живёт отдельно от места:
         ни пропуска, ни выбранного облака оно не требует — только хвост ссылки. -->
    <p class="am-sub">Забрать по ссылке · пропуск не нужен</p>

    <div class="am-row">
      <label class="am-field">
        <input
          v-model="linkDraft"
          class="am-input"
          type="text"
          placeholder="Ссылка на копию или её хвост"
        />
      </label>
      <button
        v-tip="'Спросить, что лежит по ссылке. Список пока не меняется'"
        class="am-btn"
        type="button"
        :disabled="cloudBusy || !linkDraft.trim()"
        @click="onLinkFind"
      >
        {{ cloudBusy ? 'Смотрим…' : 'Найти копию' }}
      </button>
    </div>

    <div v-if="linkFound" class="am-ask">
      <p class="am-ask__text">
        По ссылке лежит копия: {{ sizeText(linkFound.bytes) }}<template v-if="linkFound.modified">
          · {{ whenText(Date.parse(linkFound.modified)) }}</template>. Здесь записей: {{ list }}.
      </p>

      <div class="am-row">
        <button class="am-btn" type="button" :disabled="cloudBusy" @click="onLinkPull('merge')">
          Добавить недостающее
        </button>
        <button
          v-tip="'Заменить свой список копией по ссылке целиком'"
          class="am-btn am-btn--ghost"
          type="button"
          :disabled="cloudBusy"
          @click="onLinkPull('replace')"
        >
          Заменить целиком
        </button>
        <button class="am-btn am-btn--ghost" type="button" @click="onLinkCancel">Отмена</button>
      </div>
    </div>

    <p v-if="cloudError" class="am-error">{{ cloudError }}</p>
    <p v-if="cloudNote" class="am-note">{{ cloudNote }}</p>

    <!-- Справка отдельным узлом и модалкой: длинные объяснения нужны один
         раз, а в панели они стояли абзацами и мешали каждый день. -->
    <CloudHelp :open="helpOpen" :path="cloudPathText()" @close="helpOpen = false" />
  </div>
</template>

<style scoped src="../screens/settings-screen.css"></style>
