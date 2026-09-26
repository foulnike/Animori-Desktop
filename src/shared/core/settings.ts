// Пользовательские настройки: читать `settings.x` в момент использования; до loadSettings() — дефолты.
// Логгер недоступен: utils/logger сам читает этот модуль, импорт дал бы цикл.

import { Bridge } from '@/bridge'

export type TitleSource = 'shikimori' | 'anime365' | 'off' | 'none'
export type AccentPreset =
  'site' | 'sakura' | 'mono' | 'catppuccin' | 'nord' | 'dracula' | 'matcha' | 'sunset' | 'custom'

/**
 * Оформление окна; слово «тема» занято музыкальными темами, `amoled` — чёрный ноль: на OLED он не светится.
 */
export type AppearanceName = 'dark' | 'light' | 'amoled'

/**
 * Где живёт облачная копия; 'google' оставлен нарочно — у кого он лежит в хранилище, панель скажет переставить место.
 */
export type CloudPlace = 'none' | 'yandex' | 'google'

export interface AniMoriSettings {
  translateInterface: boolean
  titlePrimary: TitleSource
  titleFallback: TitleSource
  translateCharacters: boolean
  translateStaff: boolean
  enablePlayer: boolean
  enableRatings: boolean
  enableFranchise: boolean
  enableThemes: boolean
  enableExtLinks: boolean
  enableLinkRutracker: boolean
  enableLinkYummy: boolean
  enableLinkAnimego: boolean
  yummyDomain: string
  animegoDomain: string
  enableLogger: boolean
  accentPreset: AccentPreset
  /** Цвет пресета `custom` в hex: пустое и кривое равны теме сайта — разбор в core/accent.ts. */
  accentCustom: string
  /** Оформление окна: тёмное, светлое или AMOLED. */
  appearance: AppearanceName
  /**
   * Блокировать всплывающие окна плеера: ловит только НОВЫЕ окна (on_new_window), редиректы не режет.
   */
  blockPlayerPopups: boolean
  /** Резать рекламные блоки AniList: работает всюду — баннеры в главном фрейме на том же домене. */
  hideAds: boolean
  /**
   * Показывать взрослое (18+): прячется везде, включая свой список; история остаётся исключением.
   */
  showAdult: boolean
  /** Показывать пилюлю «Перенос»: смысл ключа чисто интерфейсный — окно остаётся смонтированным. */
  showSyncButton: boolean
  /** Показывать пилюлю ⇄: отдельный ключ, иначе объединение прятало бы обе кнопки ради одной. */
  showCompareButton: boolean
  /**
   * Папка для выгрузок XML: пусто — «ещё не выбрана», файл уходит загрузкой; в снимок ключ не попадает.
   */
  exportDir: string
  /**
   * Ник на Шикимори для переноса; пусто — «ни разу». Хранится, чтобы не набирать заново (пульт телевизора).
   */
  shikiNick: string
  /** Где держать облачную копию; по умолчанию нигде — облако включает человек, а не установщик. */
  cloudPlace: CloudPlace
  /**
   * Пропуск Яндекс Диска: лежит открытым текстом в хранилище окна; в копию списка не попадает никогда.
   */
  cloudToken: string
  /** Когда копия ушла в облако (мс); ноль — «ни разу», экран говорит это словами. */
  cloudSavedAt: number
  /** Сколько записей было в последней копии: ответ нужен до восстановления и без сети. */
  cloudSavedCount: number
  /**
   * Время правки файла копии по словам облака: сравнение знак в знак — часы у сторон разные; своя метка принадлежит текущему пропуску.
   */
  cloudSeenModified: string
  /** Производная: тайтлы включены, пока основной источник != 'off'. */
  translateTitles: boolean
}

/**
 * Значения НА СЛУЧАЙ ОТСУТСТВИЯ КЛЮЧА, не «сброс»: фоллбэк Shikimori, anime365 знает не все русские названия.
 */
const DEFAULT_SETTINGS: AniMoriSettings = {
  translateInterface: true,
  titlePrimary: 'anime365',
  titleFallback: 'shikimori',
  translateCharacters: true,
  translateStaff: true,
  enablePlayer: true,
  enableRatings: true,
  enableFranchise: true,
  enableThemes: true,
  enableExtLinks: true,
  enableLinkRutracker: true,
  enableLinkYummy: true,
  enableLinkAnimego: true,
  yummyDomain: 'yummyanime.tv',
  animegoDomain: 'animego.org',
  enableLogger: true,
  accentPreset: 'site',
  accentCustom: '',
  appearance: 'dark',
  blockPlayerPopups: false,
  hideAds: false,
  showAdult: false,
  showSyncButton: true,
  showCompareButton: true,
  exportDir: '',
  shikiNick: '',
  cloudPlace: 'none',
  cloudToken: '',
  cloudSavedAt: 0,
  cloudSavedCount: 0,
  cloudSeenModified: '',
  translateTitles: true,
}

async function readSettings(): Promise<AniMoriSettings> {
  const storage = Bridge.storage

  // Все ключи читаются одним залпом: в Tauri последовательный await дал бы два
  // десятка вызовов через IPC на старте приложения.
  const [
    translateInterface,
    storedTitlePrimary,
    legacyTitles,
    titleFallback,
    translateCharacters,
    translateStaff,
    enablePlayer,
    enableRatings,
    enableFranchise,
    enableThemes,
    enableExtLinks,
    enableLinkRutracker,
    enableLinkYummy,
    enableLinkAnimego,
    yummyDomain,
    animegoDomain,
    enableLogger,
    accentPreset,
    accentCustom,
    appearance,
    blockPlayerPopups,
    hideAds,
    showAdult,
    showSyncButton,
    showCompareButton,
    exportDir,
    shikiNick,
    cloudPlace,
    cloudToken,
    cloudSavedAt,
    cloudSavedCount,
    cloudSeenModified,
  ] = await Promise.all([
    storage.get('set_interface', DEFAULT_SETTINGS.translateInterface),
    storage.get<TitleSource>('set_title_primary'),
    storage.get('set_titles', true),
    storage.get<TitleSource>('set_title_fallback', DEFAULT_SETTINGS.titleFallback),
    storage.get('set_chars', DEFAULT_SETTINGS.translateCharacters),
    storage.get('set_staff', DEFAULT_SETTINGS.translateStaff),
    storage.get('set_player', DEFAULT_SETTINGS.enablePlayer),
    storage.get('set_ratings', DEFAULT_SETTINGS.enableRatings),
    storage.get('set_franchise', DEFAULT_SETTINGS.enableFranchise),
    storage.get('set_themes', DEFAULT_SETTINGS.enableThemes),
    storage.get('set_extlinks', DEFAULT_SETTINGS.enableExtLinks),
    storage.get('set_link_rutracker', DEFAULT_SETTINGS.enableLinkRutracker),
    storage.get('set_link_yummy', DEFAULT_SETTINGS.enableLinkYummy),
    storage.get('set_link_animego', DEFAULT_SETTINGS.enableLinkAnimego),
    storage.get('set_yummy_domain', DEFAULT_SETTINGS.yummyDomain),
    storage.get('set_animego_domain', DEFAULT_SETTINGS.animegoDomain),
    storage.get('set_logger', DEFAULT_SETTINGS.enableLogger),
    storage.get<AccentPreset>('am_accent', DEFAULT_SETTINGS.accentPreset),
    storage.get('am_accent_custom', DEFAULT_SETTINGS.accentCustom),
    storage.get<AppearanceName>('am_appearance', DEFAULT_SETTINGS.appearance),
    storage.get('set_block_popups', DEFAULT_SETTINGS.blockPlayerPopups),
    storage.get('set_hide_ads', DEFAULT_SETTINGS.hideAds),
    storage.get('set_adult', DEFAULT_SETTINGS.showAdult),
    storage.get('set_btn_sync', DEFAULT_SETTINGS.showSyncButton),
    storage.get('set_btn_compare', DEFAULT_SETTINGS.showCompareButton),
    storage.get('set_export_dir', DEFAULT_SETTINGS.exportDir),
    storage.get('am_shiki_nick', DEFAULT_SETTINGS.shikiNick),
    storage.get<CloudPlace>('am_cloud_place', DEFAULT_SETTINGS.cloudPlace),
    storage.get('am_cloud_token', DEFAULT_SETTINGS.cloudToken),
    storage.get('am_cloud_saved_at', DEFAULT_SETTINGS.cloudSavedAt),
    storage.get('am_cloud_saved_count', DEFAULT_SETTINGS.cloudSavedCount),
    storage.get('am_cloud_seen_modified', DEFAULT_SETTINGS.cloudSeenModified),
  ])

  // Совместимость: старый set_titles применяется только при отсутствии нового ключа. Литерал
  // 'shikimori' здесь писать НЕЛЬЗЯ.
  const titlePrimary = storedTitlePrimary ?? (legacyTitles ? DEFAULT_SETTINGS.titlePrimary : 'off')

  return {
    translateInterface,
    titlePrimary,
    titleFallback,
    translateCharacters,
    translateStaff,
    enablePlayer,
    enableRatings,
    enableFranchise,
    enableThemes,
    enableExtLinks,
    enableLinkRutracker,
    enableLinkYummy,
    enableLinkAnimego,
    yummyDomain,
    animegoDomain,
    enableLogger,
    accentPreset,
    accentCustom,
    appearance,
    blockPlayerPopups,
    hideAds,
    showAdult,
    showSyncButton,
    showCompareButton,
    exportDir,
    shikiNick,
    cloudPlace,
    cloudToken,
    cloudSavedAt,
    cloudSavedCount,
    cloudSeenModified,
    translateTitles: titlePrimary !== 'off',
  }
}

/** Единственный экземпляр настроек: мутируется на месте — на этом держатся реактивные модели панели. */
export const settings: AniMoriSettings = { ...DEFAULT_SETTINGS }

/** Перечитать настройки из хранилища (вызывается из start() в app/main.ts). */
export async function loadSettings(): Promise<AniMoriSettings> {
  try {
    Object.assign(settings, await readSettings())
  } catch (e) {
    // Хранилище недоступно — работаем на дефолтах: без настроек приложение ещё полезно, без запуска — уже нет.
    console.error('[AniMori] Не удалось прочитать настройки, используются значения по умолчанию', e)
  }
  return settings
}

/**
 * Записать настройку и обновить производные; память обновляется ДО записи, отказ глушится — зовут из сеттеров.
 */
export async function saveSetting<K extends keyof AniMoriSettings>(
  key: K,
  storageKey: string,
  value: AniMoriSettings[K],
): Promise<void> {
  settings[key] = value
  settings.translateTitles = settings.titlePrimary !== 'off'

  try {
    await Bridge.storage.set(storageKey, value)
  } catch (e) {
    console.error('[AniMori] Не удалось сохранить настройку ' + storageKey, e)
  }
}
