<script setup lang="ts">
// Настройки: импорт списка, свои данные, облачная копия, внешность и справка. Панели — в колонках-обёртках (порядок и ширина в settings-screen.css, разметка одна на все размеры окна).
// AniList и Шикимори — две одинаковые половины со своими ошибками и итогами; прокси — components/ProxyBox.vue, облако — CloudBox.vue, знаки сервисов — brand/*.svg.
import { onBeforeUnmount, onMounted, ref } from 'vue'

import { Bridge } from '@/bridge'
import { forgetCatalogMemory } from '@/api/anilist-catalog'
import {
  eachEntry,
  entryCount,
  forgetCollection,
  initCollection,
  pullFromMalFile,
  pullFromShikimori,
  refreshFromServer,
  unlinkCollection,
  type MalPullResult,
  type PullMode,
  type ShikiPullResult,
} from '@/core/collection'
import { datasetStatus, initDatasetNames } from '@/core/dataset-names'
import { clearCache, getDbStats } from '@/core/db'
import { buildMalXml, malXmlFileName, parseMalXml } from '@/core/mal-xml'
import { adultByBirth } from '@/core/adult'
import { clearHidden } from '@/core/recs'
import { saveSetting, settings } from '@/core/settings'

import { APPEARANCES, appearance, setAppearance } from '../appearance'
import {
  authStatus,
  isDesktop,
  logout,
  refreshAuth,
  startLogin,
  submitToken,
  type LoginStart,
} from '../auth/session'
import BrandMark from '../components/BrandMark.vue'
import CloudBox from '../components/CloudBox.vue'
import DatePick from '../components/DatePick.vue'
import ProxyBox from '../components/ProxyBox.vue'
import { pickTextFile } from '../load-file'
import { saveXmlFile } from '../save-file'
import { dropFeed } from './home-keep'

const version = __ANIMORI_VERSION__

const desktop = isDesktop()

/// Человеку важна его система, а не имя нашей сборки: слово «app» ему
/// не говорит ничего, а «Windows» отвечает на вопрос сразу.
function systemName(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent
  if (/Android/i.test(ua)) return 'Android'
  if (/Windows/i.test(ua)) return 'Windows'
  if (/Mac OS X/i.test(ua)) return 'macOS'
  if (/Linux/i.test(ua)) return 'Linux'
  return 'неизвестна'
}

const system = systemName()

/** Адрес датасета названий: ссылка осталась, но обязанностью не стала — CC0 атрибуции не требует. */
const DATASET_URL = 'https://github.com/foulnike/animori-data'

/// Внешние ссылки из окна открываются только оболочкой: target="_blank"
/// в WebView2 отбрасывается молча, без окна и без ошибки.
function onDatasetLink(): void {
  void Bridge.shell.openExternal(DATASET_URL)
}

/** Адрес репозитория и просьба при нём. В «О программе», а не окном при запуске: окно на старте читается вымогательством.
 * Звезда значит «пригодилась», issue — «сломалось», и обе вещи делаются в одном месте. */
const REPO_URL = 'https://github.com/foulnike/Animori-Desktop'

function onRepoLink(): void {
  void Bridge.shell.openExternal(REPO_URL)
}

/** Страница выгрузки списка на MAL: входа в сервис у нас нет, файл забирается руками. */
const MAL_EXPORT_URL = 'https://myanimelist.net/panel.php?go=export'

function onMalExportLink(): void {
  void Bridge.shell.openExternal(MAL_EXPORT_URL)
}

// Ошибки показываются рядом с кнопкой, а не глотаются: молчаливый catch
// здесь означал бы кнопку, которая не делает ничего и не говорит почему.
const error = ref('')
const busy = ref(false)
const manual = ref('')
const manualOpen = ref(false)

// Ответ Rust на нажатие «Войти». Держится до входа или до ухода с экрана:
// из него берётся срок ожидания для подсказки.
const login = ref<LoginStart | null>(null)

// Сброс и перенос идут молча, и без явного ответа человек не поймёт,
// случилось ли что-нибудь вообще.
const note = ref('')
const cleared = ref(false)

/** Спрошено ли подтверждение переноса: даже слияние двигает записи, а замена вычищает список целиком. */
const asking = ref(false)

/** Спрошено ли подтверждение удаления: местные записи вернуть потом неоткуда — их нет ни на каком сервере. */
const askingDrop = ref(false)

/** Ник на Шикимори: списывается из настроек один раз — общий объект не реактивен, v-model не показал бы. */
const shikiNick = ref(settings.shikiNick)

/** Спрошено ли подтверждение переноса с Шикимори. Спрашивается по тем же причинам. */
const askingShiki = ref(false)

/** Занятость и ответы Шикимори — отдельно: перенос идёт минутами, а общая строка встала бы в чужой панели. */
const shikiBusy = ref(false)
const shikiNote = ref('')
const shikiError = ref('')

/** Занятость и ответы переноса из файла MAL — отдельно: перенос долог и гасил бы чужие кнопки и панели. */
const malBusy = ref(false)
const malNote = ref('')
const malError = ref('')

/** Выбранный файл, ждущий ответа на вопрос. Разбирается сразу при выборе:
 * битый отказывает сразу, а живой даёт число записей для текста вопроса. */
const malFile = ref<{ name: string; text: string; count: number } | null>(null)

/** Спрошено ли подтверждение переноса из файла. Спрашивается по тем же причинам. */
const askingMal = ref(false)

const listCount = ref(0)
const usedSize = ref('')

/** Состояние датасета названий строкой: журнала нет, видно хотя бы здесь. */
const datasetText = ref('')

/** Датасет старше STALE_DAYS: отдельный признак, а не слово в строке — число дней прочитают и не заметят. */
const datasetStale = ref(false)

/** Порог подсветки возраста датасета — тридцать дней: столько пропускают три подряд упавшие недельные сборки.
 * Сторож в репозитории кричит на десятом дне, но письмо можно пропустить, а этот экран открывают сами. */
const STALE_DAYS = 30

/** Показ взрослого (пункт 3.8): списывается из настроек один раз — объект настроек не реактивен. */
const adult = ref(settings.showAdult)

/** Открыт ли вопрос о возрасте: взрослое включается ответом, а не нажатием — до него тумблер выключен. */
const askingAge = ref(false)

/** Дата рождения из календарика. Живёт только до ответа и никуда не пишется. */
const birth = ref('')

/** Слова отказа. Пустая строка — отказа нет. */
const ageError = ref('')

/** Папка выгрузок (3.3): списывается один раз — поле настроек в разметке не обновилось бы после выбора. */
const exportDir = ref(settings.exportDir)

/** Умеет ли площадка спрашивать папку: в браузере окна нет, там строку честнее спрятать. */
const canPickDir = Bridge.exportFile.available

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function guard(action: () => Promise<void>): Promise<void> {
  busy.value = true
  error.value = ''
  try {
    await action()
  } catch (e) {
    error.value = describe(e)
  } finally {
    busy.value = false
  }
}

/// Числа переспрашиваются после каждой кнопки: показанное должно совпадать с тем, что лежит внутри.
/// Подъём обязателен (настройки открывают раньше списков) и идемпотентен, в сеть не ходит.
async function readState(): Promise<void> {
  await initCollection()
  listCount.value = entryCount()

  const got = await getDbStats()
  usedSize.value = 'error' in got ? '' : got.estimatedSize

  // Датасет поднимается тем же общим обещанием, что и на старте:
  // второй цены чтения здесь нет.
  await initDatasetNames()
  const ds = datasetStatus()
  if (ds.loaded && ds.builtAt !== null) {
    const date = new Date(ds.builtAt).toLocaleDateString('ru-RU')
    const count = ds.names.toLocaleString('ru-RU')
    const days = daysSince(ds.builtAt)

    // Возраст рядом с датой: дата отвечает «когда собран», а возраст —
    // «пора ли дёргать репозиторий», и здесь важнее второй вопрос.
    const age = days === null ? '' : ` · ${ageText(days)}`
    datasetText.value = `${date} · ${count} записей${age}`
    datasetStale.value = days !== null && days > STALE_DAYS
  } else {
    datasetText.value = 'не загружен'
    datasetStale.value = false
  }
}

/// Копия из облака легла поверх списка: числа в панели данных пора
/// переспросить. Своё состояние облачная панель ведёт сама.
function onCloudChanged(): void {
  void readState()
}

function onLogin(): void {
  void guard(async () => {
    login.value = await startLogin()
  })
}

/** Отключение счёта: связь рвётся, список остаётся местным (3.16) — раньше выход уносил список совсем. */
function onLogout(): void {
  void guard(async () => {
    note.value = ''
    asking.value = false

    await logout()
    const left = await unlinkCollection()
    login.value = null
    await readState()

    note.value =
      left > 0 ? `Счёт отключён. Список остался здесь местным: записей ${left}.` : 'Счёт отключён.'
  })
}

function onManual(): void {
  void guard(async () => {
    await submitToken(manual.value)
    manual.value = ''
    manualOpen.value = false
    login.value = null
  })
}

/** Перенос списка с AniList одним из двух способов; зовётся только из подтверждения, никогда сам.
 * Итог говорится числами: после слияния важно не общее число, а что стало с набранным здесь. */
function onPull(mode: PullMode): void {
  asking.value = false

  void guard(async () => {
    note.value = ''
    const done = await refreshFromServer(mode)
    await readState()

    // Способ берётся из ответа, а не из просьбы: смена счёта переключает
    // перенос на замену сама, и сказать надо о том, что случилось на деле.
    if (done.mode === 'replace') {
      note.value = `Список замещён списком с AniList: записей ${done.total}.`
      return
    }

    note.value =
      `Списки слиты: всего ${done.total}, новых ${done.added}, ` +
      `обновлено ${done.updated}, своих правок сохранено ${done.kept}, ` +
      `только здесь ${done.onlyHere}.`
  })
}

/** Нажатие на кнопку переноса: сначала вопрос, действие потом. */
function onAsk(): void {
  note.value = ''
  error.value = ''
  asking.value = true
}

function onCancel(): void {
  asking.value = false
}

/** Ник запоминается по уходу из поля: набирать его заново на телевизоре пультом — то ещё удовольствие. */
function onShikiNick(): void {
  const clean = shikiNick.value.trim()
  shikiNick.value = clean
  void saveSetting('shikiNick', 'am_shiki_nick', clean)
}

/** Нажатие на перенос с Шикимори: сначала вопрос, действие потом. */
function onShikiAsk(): void {
  shikiNote.value = ''
  shikiError.value = ''
  askingShiki.value = true
}

function onShikiCancel(): void {
  askingShiki.value = false
}

/** Потери словами: тайтлы, которых нет у AniList, в список не попадают — молчать нельзя, человек решит, что съело половину.
 * Источник потерь не важен (Шикимори по нику или файл MAL): форма фразы одна — счётчик и имена. */
function lostText(done: { lost: number; lostTitles: string[] }): string {
  if (done.lost === 0) return ''
  if (done.lostTitles.length === 0) return ` Без пары на AniList: ${done.lost}.`

  const more = done.lost > done.lostTitles.length ? ' и другие' : ''
  return ` Без пары на AniList ${done.lost}: ${done.lostTitles.join(', ')}${more}.`
}

/** Даты просмотра словами: ноль здесь не поломка, а «просмотров не было» — у запланированного дат и не бывает. */
function datesText(done: ShikiPullResult): string {
  if (done.dated === 0) return ' Дат просмотра в журнале Шикимори не нашлось.'
  return ` Даты просмотра перенесены в ${done.dated} записей.`
}

/** Перенос списка с Шикимори по нику: способы те же два, и замена вычищает всё, включая перенесённое с AniList. */
function onShikiPull(mode: PullMode): void {
  askingShiki.value = false

  void (async () => {
    shikiBusy.value = true
    shikiError.value = ''
    shikiNote.value = ''

    try {
      // Ник сохраняется до переноса, а не после: перенос долгий, и уйти
      // с экрана посреди него человек вправе.
      onShikiNick()

      const done = await pullFromShikimori(shikiNick.value, mode)
      await readState()

      shikiNote.value =
        done.mode === 'replace'
          ? `Список замещён списком ${done.nick} с Шикимори: записей ${done.total}.` +
            lostText(done) +
            datesText(done)
          : `Списки слиты: всего ${done.total}, новых ${done.added}, ` +
            `обновлено ${done.updated}, своих правок сохранено ${done.kept}, ` +
            `только здесь ${done.onlyHere}.` +
            lostText(done) +
            datesText(done)
    } catch (e) {
      shikiError.value = describe(e)
    } finally {
      shikiBusy.value = false
    }
  })()
}

/** Выбор файла выгрузки: окно родное, закрытое без выбора ошибкой не считается; файл разбирается до вопроса —
 * битый XML отказывает сразу, а живой даёт число записей в текст вопроса. */
function onMalPick(): void {
  malNote.value = ''
  malError.value = ''

  void (async () => {
    malBusy.value = true

    try {
      const loaded = await pickTextFile('.xml,.gz')
      if (loaded === null) return

      const count = parseMalXml(loaded.text).rows.length
      malFile.value = { name: loaded.name, text: loaded.text, count }
      askingMal.value = true
    } catch (e) {
      malError.value = describe(e)
    } finally {
      malBusy.value = false
    }
  })()
}

function onMalCancel(): void {
  askingMal.value = false
  malFile.value = null
}

/** Перенос списка из файла: способы те же два, и замена столь же беспощадна — вычищает и перенесённое с AniList.
 * Разобранный при выборе текст едет в перенос как есть: копия в памяти, подменить её нечем. */
function onMalPull(mode: PullMode): void {
  askingMal.value = false

  const file = malFile.value
  malFile.value = null
  if (file === null) return

  void (async () => {
    malBusy.value = true
    malError.value = ''
    malNote.value = ''

    try {
      const done: MalPullResult = await pullFromMalFile(file.text, mode)
      await readState()

      malNote.value =
        done.mode === 'replace'
          ? `Список замещён списком из файла: записей ${done.total}.` + lostText(done)
          : `Списки слиты: всего ${done.total}, новых ${done.added}, ` +
            `обновлено ${done.updated}, своих правок сохранено ${done.kept}, ` +
            `только здесь ${done.onlyHere}.` +
            lostText(done)
    } catch (e) {
      malError.value = describe(e)
    } finally {
      malBusy.value = false
    }
  })()
}

/** Нажатие на удаление списка: тоже только вопрос, без действия. */
function onAskDrop(): void {
  note.value = ''
  error.value = ''
  askingDrop.value = true
}

function onCancelDrop(): void {
  askingDrop.value = false
}

/** Удаление своего списка по прямой просьбе: счёт не трогается — список можно стереть и перенести заново.
 * На AniList это не отражается: удаляем только то, что лежит у нас. */
function onDropList(): void {
  askingDrop.value = false

  void guard(async () => {
    note.value = ''
    await forgetCollection()
    await readState()
    note.value = 'Список удалён. На AniList ваши записи остались нетронутыми.'
  })
}

/** Выбор папки для выгрузок: спрашивается один раз, дальше выгрузка идёт молча. Закрытое окно ошибкой не считается:
 * null значит «передумал». Ответа словами нет намеренно — новый путь встаёт в ту же строку, которую нажали. */
function onPickDir(): void {
  void guard(async () => {
    note.value = ''

    const picked = await Bridge.exportFile.pickDir()
    if (picked === null) return

    exportDir.value = picked
    await saveSetting('exportDir', 'set_export_dir', picked)
  })
}

/** Выгрузка списка файлом XML: формат чужой и старый, зато его понимают Шикимори, AniList, Kitsu и сам MyAnimeList.
 * Записи без номера MAL выразить нечем, и их число говорится вслух; путь показывается целиком, кнопки «показать в папке» нет. */
function onExport(): void {
  void guard(async () => {
    note.value = ''
    await initCollection()

    const built = buildMalXml({ entries: eachEntry() })
    if (built.exported === 0) {
      note.value = 'Выгружать нечего: ни одной записи с закладкой и номером MAL.'
      return
    }

    // Отказ записи прилетает исключением и попадает в error силами guard:
    // текст приходит из Rust готовым, вида «Папка не найдена: …».
    const saved = await saveXmlFile(malXmlFileName(), built.xml)

    const lost = built.noMalId.length
    const tail = lost > 0 ? ` Без номера MAL осталось ${lost} — их в файле нет.` : ''

    note.value = saved.toFolder
      ? `Выгружено записей: ${built.exported}. Файл: ${saved.path}${tail}`
      : `Выгружено записей: ${built.exported}. Папка не выбрана, файл ушёл в загрузки окна.${tail}`
  })
}

/** Переключение показа взрослого: отбор живёт в core/adult.ts и читает ключ в момент вопроса, перезапуск не нужен.
 * Включение спрашивает дату рождения (формально, ничего не хранит); тумблер встаёт в «включено» только после ответа. */
function onAdult(): void {
  if (!adult.value) {
    void saveSetting('showAdult', 'set_adult', false)
    closeAge()
    return
  }

  adult.value = false
  birth.value = ''
  ageError.value = ''
  askingAge.value = true
}

/** Ответ календарика. Пустая дата — «стёрли», и это не ответ. */
function onBirth(value: string): void {
  birth.value = value
  if (value === '') return

  if (!adultByBirth(value)) {
    ageError.value = 'В доступе отказано'
    return
  }

  closeAge()
  adult.value = true
  void saveSetting('showAdult', 'set_adult', true)
}

/** Отказ от вопроса: тумблер остаётся выключенным, и это его настоящее состояние. */
function closeAge(): void {
  askingAge.value = false
  birth.value = ''
  ageError.value = ''
}

// Память сбрасывается только руками: человек может быть в середине правок.
// Вместе со складом снимаются метки «не интересно», лента подбора тоже выбрасывается.
function onClear(): void {
  void guard(async () => {
    note.value = ''
    await clearCache()
    forgetCatalogMemory()
    await clearHidden()
    dropFeed()
    cleared.value = true
    await readState()
    note.value = 'Память очищена. Названия и описания загрузятся заново.'
  })
}

function onReload(): void {
  void Bridge.shell.reload()
}

/// Срок человеку показывается местным временем: в секундах эпохи он
/// ничего не значит.
function expiryText(seconds: number | null): string {
  if (seconds === null) return 'срок неизвестен'
  return `до ${new Date(seconds * 1000).toLocaleDateString('ru-RU')}`
}

/// Ожидание в минутах: секунды читать неудобно.
function waitText(seconds: number): string {
  return `${Math.round(seconds / 60)} мин`
}

/// Возраст сборки в днях. null — когда дата не читается: «NaN дней назад»
/// хуже, чем отсутствие возраста вовсе.
function daysSince(iso: string): number | null {
  const ms = Date.now() - new Date(iso).getTime()
  if (!Number.isFinite(ms)) return null
  return Math.floor(ms / 86400000)
}

/// Возраст словами: «собран сегодня», «1 день назад», «6 дней назад».
/// Развёрнуто, а не тернарниками: падежи русских числительных в одну строку не читаются.
function ageText(days: number): string {
  if (days <= 0) return 'собран сегодня'

  const tail = days % 100
  const last = days % 10
  let word = 'дней'
  if (tail < 11 || tail > 19) {
    if (last === 1) word = 'день'
    else if (last >= 2 && last <= 4) word = 'дня'
  }

  return `${days} ${word} назад`
}

/** Граница «полного экрана»: та же, что у раскладки в settings-screen.css. */
const WIDE_AT = '(min-width: 1400px)'

/** Широкое ли окно: от этого зависит, где живёт панель прокси. */
const wide = ref(false)

let watchWide: MediaQueryList | null = null

function onWide(event: MediaQueryListEvent): void {
  wide.value = event.matches
}

onMounted(() => {
  const mq = window.matchMedia(WIDE_AT)
  wide.value = mq.matches
  mq.addEventListener('change', onWide)
  watchWide = mq

  void guard(refreshAuth)
  void readState()
})

onBeforeUnmount(() => {
  watchWide?.removeEventListener('change', onWide)
  watchWide = null
})
</script>

<template>
  <section class="am-page">
    <!-- Две стопки: каждая набирает свои панели встык, и высота соседней ей безразлична.
         Порядок и ширина под каждый размер окна живут в settings-screen.css. -->
    <div class="am-set">
      <!-- Левая стопка: Данные и справка; на полном экране CSS раскладывает её по столбцам. -->
      <div class="am-set__col am-set__col--left">
        <div class="am-set__col am-set__col--main">
        <!-- Импорт списка: две половины одного вида. У каждой знак сервиса,
             название, строка состояния, кнопки и свои ответы. -->
        <div class="am-panel am-box">
          <h3 class="am-h3">Импорт списка</h3>

          <!-- AniList. Знак берёт components/BrandMark.vue из файла
               src/app/brand/anilist.svg: фирменный вектор, а не наш рисунок. -->
          <div class="am-serv">
            <div class="am-serv__head">
              <BrandMark class="am-serv__logo" name="anilist" />

              <span class="am-serv__text">
                <span class="am-serv__name">AniList</span>
                <span class="am-serv__note">
                  {{
                    authStatus.authorized
                      ? `Подключён ${expiryText(authStatus.expiresAt)}.`
                      : 'Нужен вход в аккаунт.'
                  }}
                </span>
              </span>

              <span class="am-flag" :class="{ 'am-flag--on': authStatus.authorized }">
                <span class="am-flag__dot" aria-hidden="true" />
                {{ authStatus.authorized ? 'подключён' : 'не подключён' }}
              </span>
            </div>

            <p v-if="!desktop" class="am-meta">
              Вход работает только в приложении. Запустите <code>npm run tauri dev</code>.
            </p>

            <template v-else>
              <div class="am-row">
                <button
                  v-if="!authStatus.authorized"
                  class="am-btn"
                  type="button"
                  :disabled="busy"
                  @click="onLogin"
                >
                  Подключить аккаунт
                </button>
                <template v-else>
                  <button
                    v-tip="'Забрать список с AniList: слиянием или с заменой'"
                    class="am-btn"
                    type="button"
                    :disabled="busy"
                    @click="onAsk"
                  >
                    {{ busy ? 'Переносим…' : 'Перенести список' }}
                  </button>
                  <button
                    v-tip="'Разорвать связь с AniList. Список останется здесь'"
                    class="am-btn am-btn--ghost"
                    type="button"
                    :disabled="busy"
                    @click="onLogout"
                  >
                    Отключить
                  </button>
                </template>

                <button
                  v-if="!authStatus.authorized"
                  class="am-btn am-btn--ghost"
                  type="button"
                  @click="manualOpen = !manualOpen"
                >
                  Ввести токен
                </button>
              </div>

              <!-- Вопрос перед переносом: одно число и два способа рядом. Разницу говорят подписи
                   кнопок, поэтому абзац объяснений здесь убран — он повторял их втрое длиннее. -->
              <div v-if="asking" class="am-ask">
                <p class="am-ask__text">Записей: {{ listCount }}.</p>

                <div class="am-row">
                  <button class="am-btn" type="button" :disabled="busy" @click="onPull('merge')">
                    Добавить недостающее
                  </button>
                  <button
                    class="am-btn am-btn--ghost"
                    type="button"
                    :disabled="busy"
                    @click="onPull('replace')"
                  >
                    Заменить целиком
                  </button>
                  <button class="am-btn am-btn--ghost" type="button" @click="onCancel">
                    Отмена
                  </button>
                </div>
              </div>

              <!-- Показывается только после нажатия: до него окна входа нет
                   и ждать человеку нечего. -->
              <p v-if="login && !authStatus.authorized" class="am-meta">
                Окно AniList открыто, после разрешения оно закроется само. Ожидание —
                {{ waitText(login.waitSecs) }}.
              </p>

              <div v-if="manualOpen && !authStatus.authorized" class="am-row">
                <label class="am-field">
                  <input
                    v-model="manual"
                    class="am-input"
                    type="text"
                    placeholder="Токен AniList"
                  />
                </label>
                <button
                  class="am-btn"
                  type="button"
                  :disabled="busy || !manual.trim()"
                  @click="onManual"
                >
                  Сохранить
                </button>
              </div>

              <p v-if="error" class="am-error">{{ error }}</p>
            </template>
          </div>

          <!-- Шикимори. Знак тоже фирменный, из src/app/brand/shikimori.svg.
               Вход не нужен: открытый профиль сайт отдаёт любому по нику. -->
          <div class="am-serv">
            <div class="am-serv__head">
              <BrandMark class="am-serv__logo" name="shikimori" />

              <span class="am-serv__text">
                <span class="am-serv__name">Шикимори</span>
                <span class="am-serv__note">Профиль на Шикимори должен быть открытым.</span>
              </span>

              <span class="am-flag">
                <span class="am-flag__dot" aria-hidden="true" />
                вход не нужен
              </span>
            </div>

            <div class="am-row">
              <label class="am-field">
                <input
                  v-model="shikiNick"
                  class="am-input"
                  type="text"
                  placeholder="Ник на Шикимори"
                  :disabled="shikiBusy"
                  @change="onShikiNick"
                />
              </label>
              <button
                v-tip="'Забрать список с Шикимори: слиянием или с заменой'"
                class="am-btn"
                type="button"
                :disabled="shikiBusy || !shikiNick.trim()"
                @click="onShikiAsk"
              >
                {{ shikiBusy ? 'Переносим…' : 'Перенести список' }}
              </button>
            </div>

            <!-- Вопрос тот же, что у AniList, и по той же причине: замена вычищает список целиком,
                 включая перенесённое и набранное руками. -->
            <div v-if="askingShiki" class="am-ask">
              <p class="am-ask__text">Записей: {{ listCount }}.</p>

              <div class="am-row">
                <button
                  class="am-btn"
                  type="button"
                  :disabled="shikiBusy"
                  @click="onShikiPull('merge')"
                >
                  Добавить недостающее
                </button>
                <button
                  class="am-btn am-btn--ghost"
                  type="button"
                  :disabled="shikiBusy"
                  @click="onShikiPull('replace')"
                >
                  Заменить целиком
                </button>
                <button class="am-btn am-btn--ghost" type="button" @click="onShikiCancel">
                  Отмена
                </button>
              </div>
            </div>

            <p v-if="shikiNote" class="am-note">{{ shikiNote }}</p>
            <p v-if="shikiError" class="am-error">{{ shikiError }}</p>
          </div>

          <!-- MyAnimeList: знак из src/app/brand/myanimelist.svg; входа нет и не будет: список
               приезжает файлом выгрузки; тот же файл отдаёт Шикимори — формат MAL до тега. -->
          <div class="am-serv">
            <div class="am-serv__head">
              <BrandMark class="am-serv__logo" name="myanimelist" />

              <span class="am-serv__text">
                <span class="am-serv__name">MyAnimeList</span>
                <span class="am-serv__note">
                  Перейдите
                  <button class="am-link" type="button" @click="onMalExportLink">сюда</button>
                  → «Export my anime list».
                </span>
              </span>

              <span class="am-flag">
                <span class="am-flag__dot" aria-hidden="true" />
                вход не нужен
              </span>
            </div>

            <div class="am-row">
              <button
                v-tip="'Загрузить список из файла выгрузки MAL или Шикимори: слиянием или с заменой'"
                class="am-btn"
                type="button"
                :disabled="malBusy"
                @click="onMalPick"
              >
                {{ malBusy ? 'Переносим…' : 'Выбрать файл' }}
              </button>
            </div>

            <!-- Вопрос тот же, что у AniList и Шикимори, и по той же причине: замена вычищает
                 список целиком. -->
            <div v-if="askingMal && malFile" class="am-ask">
              <p class="am-ask__text">
                Файл: {{ malFile.name }}, записей в нём {{ malFile.count }}. Записей у вас:
                {{ listCount }}.
              </p>

              <div class="am-row">
                <button
                  class="am-btn"
                  type="button"
                  :disabled="malBusy"
                  @click="onMalPull('merge')"
                >
                  Добавить недостающее
                </button>
                <button
                  class="am-btn am-btn--ghost"
                  type="button"
                  :disabled="malBusy"
                  @click="onMalPull('replace')"
                >
                  Заменить целиком
                </button>
                <button class="am-btn am-btn--ghost" type="button" @click="onMalCancel">
                  Отмена
                </button>
              </div>
            </div>

            <p v-if="malNote" class="am-note">{{ malNote }}</p>
            <p v-if="malError" class="am-error">{{ malError }}</p>
          </div>
        </div>

        <!-- Данные: что лежит на этом диске и что с этим можно сделать. -->
        <div class="am-panel am-box">
          <h3 class="am-h3">Данные</h3>

          <ul class="am-facts">
            <li class="am-fact">
              <span class="am-fact__name">Записей в списке</span>
              <span class="am-fact__value">{{ listCount }}</span>
            </li>
            <li v-if="usedSize" class="am-fact">
              <span class="am-fact__name">Занято на диске</span>
              <span class="am-fact__value">{{ usedSize }}</span>
            </li>
          </ul>

          <!-- Необратимое одной строкой: сброс памяти и удаление списка стоят
               рядом, потому что оба про то, что лежит на этом диске. -->
          <div class="am-row">
            <button
              v-tip="'Убрать сохранённые названия, описания и обложки'"
              class="am-btn am-btn--ghost"
              type="button"
              :disabled="busy"
              @click="onClear"
            >
              Очистить память
            </button>

            <button
              v-if="listCount > 0"
              v-tip="'Удалить свой список с этого устройства'"
              class="am-btn am-btn--ghost"
              type="button"
              :disabled="busy"
              @click="onAskDrop"
            >
              Удалить мой список
            </button>

            <button v-if="cleared" class="am-btn am-btn--ghost" type="button" @click="onReload">
              Перезагрузить
            </button>
          </div>

          <!-- Выгрузка отдельным узлом: место и действие рядом, строка папки нажимается целиком.
               Класс свой, am-dir, а не am-pick: в styles/theme.css им одет нативный select. -->
          <div v-if="canPickDir || listCount > 0" class="am-out">
            <button
              v-if="canPickDir"
              v-tip="'Сменить папку, куда уходят выгрузки XML'"
              class="am-dir"
              type="button"
              :disabled="busy"
              @click="onPickDir"
            >
              <span class="am-dir__mark" aria-hidden="true">📁</span>
              <span class="am-dir__text">
                <span class="am-dir__name">Папка выгрузок</span>
                <span class="am-dir__path" :class="{ 'am-dir__path--none': !exportDir }">
                  {{ exportDir || 'Не выбрана — файл уйдёт в загрузки окна' }}
                </span>
              </span>
              <span class="am-dir__act">{{ exportDir ? 'Сменить' : 'Выбрать' }}</span>
            </button>

            <button
              v-if="listCount > 0"
              v-tip="'Сохранить список файлом XML для переноса в другой сервис'"
              class="am-btn am-btn--ghost"
              type="button"
              :disabled="busy"
              @click="onExport"
            >
              Выгрузить в XML
            </button>
          </div>

          <!-- Удаление списка необратимо для местных записей: спрашиваем всегда.
               Вопрос коротким: подпись кнопки под ним и есть весь ответ. -->
          <div v-if="askingDrop" class="am-ask">
            <p class="am-ask__text">Удалить список с этого устройства?</p>

            <div class="am-row">
              <button class="am-btn" type="button" :disabled="busy" @click="onDropList">
                Удалить список
              </button>
              <button class="am-btn am-btn--ghost" type="button" @click="onCancelDrop">
                Отмена
              </button>
            </div>
          </div>

          <p v-if="note" class="am-note">{{ note }}</p>
        </div>
      </div>

      <!-- Оформление и справка: то, что смотрят, а не то, чем правят. -->
      <div class="am-set__col am-set__col--look">
        <div class="am-panel am-box">
          <h3 class="am-h3">Оформление</h3>

          <div class="am-skins">
            <button
              v-for="item in APPEARANCES"
              :key="item.name"
              v-tip="item.hint"
              class="am-skins__btn"
              :class="{ 'am-skins__btn--on': item.name === appearance }"
              type="button"
              @click="setAppearance(item.name)"
            >
              <span class="am-skins__mark" aria-hidden="true">{{ item.mark }}</span>
              <span class="am-skins__name">{{ item.title }}</span>
            </button>
          </div>

          <label class="am-switch">
            <input v-model="adult" type="checkbox" class="am-switch__box" @change="onAdult" />
            <span class="am-switch__name">Показывать контент для взрослых (18+)</span>
          </label>

          <!-- Вопрос о возрасте стоит под тумблером, а не отдельным окном: уход с экрана его
               закрывает. Поле даты своё: системное на тёмных темах выбивалось из стекла. -->
          <div v-if="askingAge" class="am-age">
            <p class="am-age__ask">Укажите ваш возраст</p>

            <DatePick :value="birth" title="Дата рождения" @pick="onBirth" />

            <p v-if="ageError" class="am-error">{{ ageError }}</p>

            <button class="am-btn am-btn--soft am-age__back" type="button" @click="closeAge">
              Отмена
            </button>
          </div>
        </div>

        <div class="am-panel am-box">
          <h3 class="am-h3">О программе</h3>

          <ul class="am-facts">
            <li class="am-fact">
              <span class="am-fact__name">Версия</span>
              <span class="am-fact__value">{{ version }}</span>
            </li>
            <li class="am-fact">
              <span class="am-fact__name">Система</span>
              <span class="am-fact__value">{{ system }}</span>
            </li>
            <li class="am-fact">
              <span class="am-fact__name">Датасет названий</span>
              <span class="am-fact__value" :class="{ 'am-fact__value--stale': datasetStale }">
                {{ datasetText }}
              </span>
            </li>
          </ul>

          <!-- Плашка репозитория: не строка заметок, а приглашение — свой фон и своё сердце,
               нажимается вся плашка. Почему именно здесь и так — у REPO_URL в скрипте. -->
          <button class="am-repo" type="button" @click="onRepoLink">
            <svg class="am-repo__heart" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <!-- Градиент сердцу задан классами: stop-color через var() в атрибуте не читается,
                   только css-свойством; оттенок из темы, на всех трёх темах сердце своё. -->
              <defs>
                <linearGradient
                  id="am-repo-heart"
                  x1="2.4"
                  y1="2.4"
                  x2="13.6"
                  y2="13.6"
                  gradientUnits="userSpaceOnUse"
                >
                  <stop class="am-repo__stop" offset="0" />
                  <stop class="am-repo__stop am-repo__stop--end" offset="1" />
                </linearGradient>
              </defs>
              <path
                fill="url(#am-repo-heart)"
                d="M8 14.1S1.9 10.3 1.9 6.1C1.9 3.9 3.7 2.4 5.5 2.4 6.8 2.4 7.6 3.1 8 4c.4-.9 1.2-1.6 2.5-1.6 1.8 0 3.6 1.5 3.6 3.7 0 4.2-6.1 8-6.1 8Z"
              />
            </svg>

            <span class="am-repo__text">
              AniMori — бесплатное приложение, без рекламы и телеметрии.
              Если вам понравилось — поставьте звездочку,
              если что-то сломалось — оставьте issue в репозитории.
            </span>
          </button>

          <!-- Имя источника, лицензия и ссылка. Обязанностью строка быть перестала: CC0-1.0
               атрибуции не требует, и это вежливость к единственному источнику кириллицы. -->
          <p class="am-meta am-fine">
            Русские названия поставляет датасет
            <button class="am-link" type="button" @click="onDatasetLink">animori-data</button>
            (лицензия CC0-1.0): номера и связки собраны перечислением каталога Шикимори,
            сами названия — из открытых API Шикимори и anime365.
          </p>

          <!-- Свежесть датасета — единственное, за чем человеку приходится следить
               руками, поэтому про просрочку говорим словами, а не одной цифрой выше. -->
          <p v-if="datasetStale" class="am-stale">
            Датасет не обновлялся больше {{ STALE_DAYS }} дней. Названия, которых в нём нет,
            программа добирает из сети по одному — это медленно. Загляните в
            <button class="am-link" type="button" @click="onDatasetLink">animori-data</button>
            и запустите сборку кнопкой.
          </p>
        </div>

        <ProxyBox v-if="wide" />
      </div>
      </div>

      <!-- Правая стопка: копия и прокси; на полном экране остаётся копией одной. -->
      <div class="am-set__col am-set__col--right">
        <CloudBox :list="listCount" :device="system" @changed="onCloudChanged" />
        <ProxyBox v-if="!wide" />
      </div>
    </div>
  </section>
</template>

<style scoped src="./settings-screen.css"></style>
