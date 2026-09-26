// Обёртка над hls.js: WebView2 не умеет HLS, а где умеет — библиотека мешала бы. Смена качества — другой
// манифест, поэтому open() принимает секунду продолжения. Вид отказа уходит наверх, решение за экраном.
import Hls from 'hls.js'

import { Logger } from '@/utils/logger'

/** Почему поток не пойдёт: `link` — срок подписи вышел (лечится новой ссылкой),
 * `net` — связь или движок: новый адрес не поможет. */
export type DeadKind = 'link' | 'net'

/** Что экран умеет с воспроизведением. */
export interface Playback {
  /** Открывает манифест на startAt секунд; `andPlay` = false — продолжать за человека нельзя. */
  open: (url: string, startAt: number, andPlay?: boolean) => void
  /** Гасит воспроизведение и освобождает память под буферы. */
  close: () => void
}

/** Обратные вызовы экрана. */
export interface PlaybackHooks {
  /** Непоправимая ошибка: вид отказа — чтобы экран сначала попробовал вылечить сам. */
  onFatal: (text: string, kind: DeadKind) => void
}

/** Числа с рабочего плеера Kodik: заводские вдвое скромнее, фрагменты не успевают на тонком канале. */
const TUNE = {
  maxBufferSize: 7e7,
  maxBufferLength: 30,
  maxMaxBufferLength: 60,
  liveSyncDuration: 30,
  fragLoadingTimeOut: 30000,
  manifestLoadingTimeOut: 20000,
  enableWorker: true,
  lowLatencyMode: false,
}

/** Сколько раз поднимать загрузку после срыва сети, прежде чем сдаться. */
const NET_TRIES = 2

/** Чем площадка отвечает на мёртвую подпись; текст не разбираем: слова у каждой площадки свои. */
const GONE = [401, 403, 410]

/** Коды тега <video>: сетевой отказ и непонятный источник. */
const ERR_NET = 2
const ERR_SRC = 4

/** Родной HLS есть только у WebKit; проверка дешёвая и честная. */
function nativeHls(video: HTMLVideoElement): boolean {
  return video.canPlayType('application/vnd.apple.mpegurl') !== ''
}

/** Код ответа площадки из отказа библиотеки: поле плавает по версиям, спрашиваем по факту. */
function codeOf(data: unknown): number {
  const box = data as { response?: { code?: unknown } }
  const code = box.response?.code

  return typeof code === 'number' ? code : 0
}

/** Одна обёртка на тег на всю жизнь экрана: пересоздание hls.js на серию оставляло бы чужие буферы. */
export function attachPlayback(video: HTMLVideoElement, hooks: PlaybackHooks): Playback {
  let hls: Hls | null = null
  let tries = 0
  let want = 0

  /** Пускать ли кадр после разбора манифеста. Слово за open(). */
  let go = true

  /** Посадка на нужную секунду: раньше готовности перемотка молча теряется. */
  function seat(): void {
    if (want <= 0) return
    video.currentTime = want
    want = 0
  }

  function play(): void {
    // Замена адреса на паузе кадр не пускает: пауза — слово человека.
    if (!go) return

    void video.play().catch((e: unknown) => {
      // Автозапуск мог быть запрещён — это не отказ, кнопка на месте.
      Logger('WARN', 'Плеер: автозапуск не случился', e)
    })
  }

  function drop(): void {
    hls?.destroy()
    hls = null
  }

  /** Отказ родного пути: у тега свои коды, и они грубее библиотечных. */
  const onNativeError: EventListener = () => {
    const code = video.error?.code ?? 0

    // Мёртвая подпись у родного пути выглядит сетевым отказом или испорченным
    // источником: и то и другое лечится новым адресом, а не жалобой.
    if (code === ERR_NET || code === ERR_SRC) {
      Logger('WARN', `Плеер: тег не принял поток (код ${code}), похоже на мёртвую ссылку`)
      hooks.onFatal('Ссылка на поток больше не действует.', 'link')
      return
    }

    Logger('ERROR', `Плеер: тег остановил воспроизведение (код ${code})`)
    hooks.onFatal('Поток оборвался. Проверьте сеть и нажмите «Переспросить».', 'net')
  }

  /** Разбор отказа: сеть и звук лечатся на месте, остальное — наверх. */
  function onError(details: string, kind: string, code: number): void {
    if (hls === null) return

    // Срок подписи вышел. Повторять загрузку бессмысленно: тот же адрес
    // площадка не отдаст ни с какой попытки.
    if (GONE.includes(code)) {
      Logger('WARN', `Плеер: площадка не отдаёт поток (${details}, код ${code})`)
      drop()
      hooks.onFatal('Ссылка на поток больше не действует.', 'link')
      return
    }

    if (kind === Hls.ErrorTypes.NETWORK_ERROR && tries < NET_TRIES) {
      tries += 1
      Logger('WARN', `Плеер: срыв сети (${details}), попытка ${tries}`)
      hls.startLoad()
      return
    }

    if (kind === Hls.ErrorTypes.MEDIA_ERROR) {
      Logger('WARN', `Плеер: сбой потока (${details}), восстанавливаю`)
      hls.recoverMediaError()
      return
    }

    Logger('ERROR', `Плеер: воспроизведение остановлено (${details})`)
    drop()

    // Сеть отработала выше; всё прочее пробуем вылечить новым адресом — самая частая причина.
    if (kind === Hls.ErrorTypes.NETWORK_ERROR) {
      hooks.onFatal('Поток оборвался. Проверьте сеть и нажмите «Переспросить».', 'net')
      return
    }

    hooks.onFatal('Источник не даёт рабочую ссылку на эту серию.', 'link')
  }

  function open(url: string, startAt: number, andPlay = true): void {
    want = startAt
    tries = 0
    go = andPlay

    // Родной путь: браузер сам разберёт манифест, обёртка лишняя.
    if (!Hls.isSupported()) {
      if (!nativeHls(video)) {
        hooks.onFatal('Этот движок не умеет HLS: смотреть нечем.', 'net')
        return
      }

      // Слушатель один на все открытия: иначе на смене качества их копилось
      // бы по числу серий, и один отказ докладывался бы многократно.
      video.removeEventListener('error', onNativeError)
      video.addEventListener('error', onNativeError)

      video.src = url
      video.addEventListener('loadedmetadata', seat, { once: true })
      play()
      return
    }

    drop()

    const next = new Hls(TUNE)
    hls = next

    next.on(Hls.Events.MANIFEST_PARSED, () => {
      seat()
      play()
    })

    next.on(Hls.Events.ERROR, (_event, data) => {
      if (!data.fatal) return
      onError(String(data.details), String(data.type), codeOf(data))
    })

    next.loadSource(url)
    next.attachMedia(video)
  }

  function close(): void {
    drop()
    video.removeEventListener('error', onNativeError)
    video.removeAttribute('src')
    video.load()
  }

  return { open, close }
}
