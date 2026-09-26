// Картинка в картинке и трансляция: два умения унести кадр из окна; живут на <video> и умирают с ним.
// Одно нажатие — один путь (жест тратится); оба пути мертвы — кнопка убирается; отказы трансляции — в журнал.
import { Bridge } from '@/bridge'
import { Logger } from '@/utils/logger'

import { JUMP_SEC, readIntent, STEP_SEC } from './player-input'

// Что показывать на кнопке: off — приёмников не видно, ready — устройство в сети,
// linking — связь устанавливается, on — поток уехал.
export type CastState = 'off' | 'ready' | 'linking' | 'on'

/** Чем кончилось нажатие: устройством, зеркалом экрана или ничем. */
export type CastWay = 'device' | 'screen' | 'none'

/** Обратные вызовы экрана. */
export interface CastHooks {
  /** Кадр ушёл в маленькое окно или вернулся: закрыть его могут и мимо нас. */
  onPip: (on: boolean) => void
  /** Состояние трансляции сменилось. */
  onCast: (state: CastState) => void
  /** Умение уносить кадр изменилось; ложь — «кнопку пора убрать». Необязателен. */
  onPipReady?: (ready: boolean) => void
}

/** Что экран умеет с кадром за пределами окна. */
export interface Cast {
  /** Есть ли хоть один путь из двух: кнопки без умения быть не должно. */
  readonly pipReady: boolean
  /** Уводит кадр в маленькое окно или возвращает назад. */
  togglePip: () => Promise<boolean>
  /** Предлагает приёмник, а где его нет — системную панель. */
  cast: () => Promise<CastWay>
  /** Снимает слежение и убирает маленькое окно за собой. */
  close: () => void
}

/** Та часть Remote Playback API, которой мы пользуемся: в описаниях DOM её может не быть. */
interface RemoteLink extends EventTarget {
  readonly state: string
  watchAvailability: (callback: (available: boolean) => void) => Promise<number>
  cancelWatchAvailability: (id?: number) => Promise<void>
  prompt: () => Promise<void>
}

/** Та часть Document Picture-in-Picture, которой мы пользуемся. Причина та же. */
interface DocPip {
  requestWindow: (options?: { width?: number; height?: number }) => Promise<Window>
}

/** Чем кончилась попытка открыть своё окно. */
type OwnAnswer = 'ok' | 'refused' | 'later'

/** Что движок доказал про пути; память на весь запуск: приговор движка от серии к серии не меняется. */
let ownWorks = false
let ownDead = false
let ownMisses = 0
let nativeDead = false

/** Сколько невнятных отказов своего окна терпим: два «не сейчас» подряд — уже не случайность. */
const OWN_MISS_LIMIT = 2

/** Убранство своего окна: документ другой, стили приложения в него не приезжают. */
const PIP_STYLE = [
  'html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}',
  'video{display:block;width:100%;height:100%;object-fit:contain;background:#000}',
].join('')

/** Куда вернуть тег: место в разметке экрана, а не копия тега. */
interface Spot {
  parent: Element
  next: ChildNode | null
}

/** Есть ли у тега свой список приёмников. Проверка по трём полям, которыми зовём. */
function remoteOf(video: HTMLVideoElement): RemoteLink | null {
  const box = video as unknown as { remote?: unknown }
  const remote = box.remote

  if (typeof remote !== 'object' || remote === null) return null

  const maybe = remote as Partial<RemoteLink>
  const whole =
    typeof maybe.prompt === 'function' &&
    typeof maybe.watchAvailability === 'function' &&
    typeof maybe.cancelWatchAvailability === 'function'

  return whole ? (remote as RemoteLink) : null
}

/** Умеет ли движок открывать своё окно поверх всего. */
function docPipOf(): DocPip | null {
  const box = window as unknown as { documentPictureInPicture?: unknown }
  const api = box.documentPictureInPicture

  if (typeof api !== 'object' || api === null) return null

  const maybe = api as Partial<DocPip>

  return typeof maybe.requestWindow === 'function' ? (api as DocPip) : null
}

/** Умеет ли тег родное окно: движок разрешил и тег не запретил; спрашивается раз на жизнь экрана. */
function pipAllowed(video: HTMLVideoElement): boolean {
  if (!document.pictureInPictureEnabled) return false

  return !video.disablePictureInPicture
}

/** Жив ли жест человека: спрашиваем движок — наше нажатие могло сгореть в ожиданиях до нас. */
function hasGesture(): boolean {
  const box = navigator as unknown as { userActivation?: { isActive?: unknown } }
  const live = box.userActivation?.isActive

  return typeof live === 'boolean' ? live : true
}

/** Отказ-приговор: движок сказал «этого здесь нет», а не «сейчас нельзя»; жест уже проверен. */
function forever(e: unknown): boolean {
  if (!(e instanceof DOMException)) return false

  return (
    e.name === 'NotSupportedError' || e.name === 'NotAllowedError' || e.name === 'SecurityError'
  )
}

// Отказ, который отказом не считается: человек закрыл список (AbortError) или движок не увидел жеста.
// Только у настоящего списка: иначе NotAllowedError движка без трансляции читался бы как слово человека.
function dismissed(e: unknown): boolean {
  if (!(e instanceof DOMException)) return false

  return e.name === 'AbortError' || e.name === 'NotAllowedError'
}

/** Привязывает оба умения к тегу: один тег — одна связка на всю жизнь экрана. */
export function attachCast(video: HTMLVideoElement, hooks: CastHooks): Cast {
  const remote = remoteOf(video)
  const docPip = docPipOf()
  const nativePip = pipAllowed(video)

  // Своё окно работает и там, где родное закрыто настройкой движка.
  const pipReady = docPip !== null || nativePip

  /** Видит ли движок приёмник в сети прямо сейчас. */
  let near = false

  /** Номер слежения: только для того, чтобы его снять. */
  let watch: number | null = null

  /** Своё окно, пока оно открыто. */
  let mine: Window | null = null

  /** Место, откуда уехал тег. Запоминается ровно на время переезда. */
  let spot: Spot | null = null

  /** Остался ли хоть один непохороненный путь. */
  function pipAlive(): boolean {
    return (docPip !== null && !ownDead) || (nativePip && !nativeDead)
  }

  /** Говорит экрану про умение, когда оно меняется: обычно — когда исчезает. */
  function tellPip(): void {
    hooks.onPipReady?.(pipAlive())
  }

  // Какой путь кормить нажатием: первым идёт наверняка существующий — родное спрашивается синхронно.
  // Доказавшее себя своё окно становится первым: в нём нет чужой панели.
  function pickWay(): 'own' | 'native' | null {
    const own = docPip !== null && !ownDead
    const native = nativePip && !nativeDead

    if (own && (ownWorks || !native)) return 'own'
    if (native) return 'native'

    return null
  }

  /** Состояние считается в одном месте: подпись на кнопке одна. */
  function tell(): void {
    if (remote === null) {
      hooks.onCast('off')
      return
    }

    if (remote.state === 'connected') {
      hooks.onCast('on')
      return
    }

    if (remote.state === 'connecting') {
      hooks.onCast('linking')
      return
    }

    hooks.onCast(near ? 'ready' : 'off')
  }

  /** Возвращает тег на своё место, а не в конец родителя: рядом живут завеса и панель, порядок решает. */
  function bringBack(): void {
    const home = spot
    spot = null

    if (home === null) return

    if (!home.parent.isConnected) {
      // Разметка уехала целиком —
      // обычно это уход с экрана.
      Logger('WARN', 'Плеер: разметка экрана уехала, кадр возвращать некуда')
      return
    }

    // Сосед мог не дожить до возврата: тогда тег встаёт последним, а не
    // падает с NotFoundError.
    const next = home.next !== null && home.next.parentNode === home.parent ? home.next : null

    home.parent.insertBefore(video, next)
  }

  /** Перемотка самим тегом: в своём окне больше спросить некого. */
  function seek(by: number): void {
    const now = video.currentTime
    const end = Number.isFinite(video.duration) ? video.duration : now + Math.abs(by)

    video.currentTime = Math.min(end, Math.max(0, now + by))
  }

  function toggle(): void {
    if (!video.paused) {
      video.pause()
      return
    }

    void video.play().catch((e: unknown) => {
      Logger('WARN', 'Плеер: серия не пошла из своего окна', e)
    })
  }

  /** Своё окно закрылось — крестиком или нашей же кнопкой. Зовётся один раз. */
  function letGo(): void {
    const win = mine
    if (win === null) return

    mine = null
    win.removeEventListener('pagehide', onGone)
    win.document.removeEventListener('keydown', onKey)

    bringBack()
    hooks.onPip(false)
  }

  /** Закрывает своё окно сами: кадр возвращается в экран, наружу идёт слово. */
  function shut(): void {
    const win = mine
    if (win === null) return

    // Порядок важен: сперва тег домой, потом закрытие. Иначе он останется
    // в закрытом документе и серия оборвётся.
    letGo()
    win.close()
  }

  // Клавиши своего окна: слушатель свой (события чужого документа не всплывают), раскладка та же — readIntent.
  // Разбираем только паузу, перемотку и выход: звук и скорость помнятся в экране.
  const onKey: EventListener = (event) => {
    if (!(event instanceof KeyboardEvent)) return

    // inList = false: кнопок в своём окне нет вовсе, водить фокус нечем.
    const intent = readIntent(event, false)

    switch (intent) {
      case 'toggle':
        toggle()
        break
      case 'seekBack':
        seek(-STEP_SEC)
        break
      case 'seekAhead':
        seek(STEP_SEC)
        break
      case 'jumpBack':
        seek(-JUMP_SEC)
        break
      case 'jumpAhead':
        seek(JUMP_SEC)
        break
      case 'pip':
      case 'exit':
        shut()
        break
      default:
        // Остальное нажатие остаётся ничьим: гасить то, чего мы не делаем,
        // незачем.
        return
    }

    event.preventDefault()
  }

  const onGone: EventListener = () => {
    letGo()
  }

  /** Открывает своё окно и перевозит тег; ответ говорит и стоит ли пробовать путь впредь. */
  async function openMine(): Promise<OwnAnswer> {
    if (docPip === null) return 'refused'

    // Размер берём с тега: окно должно быть тем же кадром, а не квадратом
    // по умолчанию. Нули бывают у скрытого тега.
    const wide = Math.max(320, Math.round(video.clientWidth) || 480)
    const tall = Math.max(180, Math.round(video.clientHeight) || 270)

    let win: Window

    try {
      win = await docPip.requestWindow({ width: wide, height: tall })
    } catch (e) {
      // Оболочка может не давать окно вовсе; жест потрачен, запасной путь не втиснуть — запоминаем ответ.
      Logger('WARN', 'Плеер: своё окно поверх всего не открылось', e)
      return forever(e) ? 'refused' : 'later'
    }

    const parent = video.parentElement

    if (parent === null) {
      // Тег вне разметки: перевозить его
      // значило бы потерять место возврата.
      Logger('WARN', 'Плеер: кадр вне разметки экрана, своё окно не открываем')
      win.close()
      return 'later'
    }

    spot = { parent, next: video.nextSibling }

    const style = win.document.createElement('style')
    style.textContent = PIP_STYLE
    win.document.head.append(style)

    // Переезд, а не копия: второй тег скачал бы поток заново, а место
    // в серии, звук и скорость живут на этом теге.
    win.document.body.append(video)

    win.addEventListener('pagehide', onGone)
    win.document.addEventListener('keydown', onKey)

    mine = win
    hooks.onPip(true)
    return 'ok'
  }

  // События тега, а не наш вызов: родное окно закрывается само; своё говорит через pagehide.
  const onPipIn: EventListener = () => {
    hooks.onPip(true)
  }

  const onPipOut: EventListener = () => {
    hooks.onPip(false)
  }

  const onRemote: EventListener = () => {
    tell()
  }

  video.addEventListener('enterpictureinpicture', onPipIn)
  video.addEventListener('leavepictureinpicture', onPipOut)

  if (remote !== null) {
    remote.addEventListener('connect', onRemote)
    remote.addEventListener('connecting', onRemote)
    remote.addEventListener('disconnect', onRemote)

    // Движок обновляет список молча: без слежения кнопка обещала бы устройство, которого уже нет в сети.
    void remote
      .watchAvailability((available: boolean) => {
        near = available
        tell()
      })
      .then((id: number) => {
        watch = id
      })
      .catch((e: unknown) => {
        // Слежение может быть закрыто политикой движка. Кнопка остаётся
        // работать: без видимого приёмника нажатие уходит в системную панель.
        Logger('WARN', 'Плеер: движок не дал следить за приёмниками', e)
      })
  }

  // Переключает маленькое окно: одно нажатие — один путь, жест тратится целиком; какой — решает pickWay.
  // Вызывать до любого await: после ожидания жеста может уже не быть.
  async function togglePip(): Promise<boolean> {
    // Своё окно открыто — его же кнопкой и закрываем.
    if (mine !== null) {
      shut()
      return false
    }

    if (document.pictureInPictureElement === video) {
      try {
        await document.exitPictureInPicture()
        return false
      } catch (e) {
        Logger('WARN', 'Плеер: родное окно движка не закрылось', e)
        return document.pictureInPictureElement === video
      }
    }

    const way = pickWay()

    if (way === null) {
      Logger('WARN', 'Плеер: картинка в картинке в этом движке не открывается, убираю кнопку')
      tellPip()
      return false
    }

    // Жест потратили до нас — виноват не движок, и хоронить путь нельзя:
    // в следующий раз он же и сработает.
    if (!hasGesture()) {
      Logger('WARN', 'Плеер: до вопроса об окошке жест человека не дожил')
      return false
    }

    if (way === 'native') {
      try {
        await video.requestPictureInPicture()
        return true
      } catch (e) {
        Logger('WARN', 'Плеер: родное окошко движка отказало', e)

        if (forever(e)) {
          nativeDead = true
          tellPip()
        }

        return document.pictureInPictureElement === video
      }
    }

    const answer = await openMine()

    if (answer === 'ok') {
      // Путь доказал себя: дальше он и будет первым — окошко без чужой панели.
      ownWorks = true
      return true
    }

    if (answer === 'refused') {
      ownDead = true
      tellPip()
      return false
    }

    ownMisses += 1

    if (ownMisses >= OWN_MISS_LIMIT) {
      ownDead = true
      tellPip()
    }

    return false
  }

  /** Системная панель: дальше выбирает человек, и ответа мы не узнаем. */
  async function mirror(): Promise<CastWay> {
    try {
      await Bridge.shell.castPanel()
      return 'screen'
    } catch (e) {
      Logger('WARN', 'Плеер: панель трансляции не открылась', e)
      return 'none'
    }
  }

  // Нажатие на кнопку: список движка первым — увозит серию, а не рабочий стол, и гасится повторным нажатием.
  // Список только при видимом приёмнике: иначе prompt() падает с NotAllowedError, как и закрытый список.
  async function cast(): Promise<CastWay> {
    if (remote !== null && near) {
      try {
        await remote.prompt()
        tell()
        return 'device'
      } catch (e) {
        if (dismissed(e)) {
          tell()
          return 'none'
        }

        // Приёмник пропал или умение лишь на бумаге: остаётся зеркало; пустое нажатие хуже второй панели.
        Logger('WARN', 'Плеер: список приёмников не помог', e)
      }
    }

    return await mirror()
  }

  function close(): void {
    video.removeEventListener('enterpictureinpicture', onPipIn)
    video.removeEventListener('leavepictureinpicture', onPipOut)

    if (remote !== null) {
      remote.removeEventListener('connect', onRemote)
      remote.removeEventListener('connecting', onRemote)
      remote.removeEventListener('disconnect', onRemote)

      if (watch !== null) {
        const id = watch
        watch = null

        void remote.cancelWatchAvailability(id).catch((e: unknown) => {
          Logger('WARN', 'Плеер: слежение за приёмниками не снялось', e)
        })
      }
    }

    // Окно переживает уход с экрана: кадр висел бы поверх списка; со своим окном уехал бы и тег.
    shut()

    if (document.pictureInPictureElement === video) {
      void document.exitPictureInPicture().catch((e: unknown) => {
        Logger('WARN', 'Плеер: маленькое окно не закрылось', e)
      })
    }
  }

  // Первое слово наружу сразу: начальное состояние считается тем же местом,
  // что и все последующие.
  tell()

  // Умение могло быть похоронено ещё в прошлом заходе в плеер: память о нём
  // живёт весь запуск, и экран должен узнать об этом до первого нажатия.
  if (pipReady && !pipAlive()) tellPip()

  return { pipReady, togglePip, cast, close }
}
