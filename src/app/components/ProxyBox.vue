<script setup lang="ts">
// Прокси: настройка соединения. Окно читает адрес из ключей запуска WebView2 — смена доходит
// только с новым процессом, поэтому кнопка перезапуска появляется лишь при реальном расхождении.
import { computed, onMounted, ref } from 'vue'

import { proxyLiveCheck } from '@/api/proxy-check'
import { Bridge, type ProxyStatus } from '@/bridge'
import {
  DEFAULT_PROXY,
  isProxyUsable,
  normalizeProxyKind,
  normalizeProxyPort,
  type ProxyConfig,
  type ProxyKind,
} from '@/core/proxy'
import { proxyRestartNeeded, readProxyConfig, saveProxyField } from '@/core/proxy-settings'

import PickBox from './PickBox.vue'

/** Виды прокси; из этого списка строится выбор. Свой PickBox, а не системный `<select>`:
 *  тот на тёмной теме выпадал белым, а переключатель из двух кнопок не влезает в строку. */
const KINDS: ReadonlyArray<{ key: ProxyKind; title: string }> = [
  { key: 'http', title: 'HTTP' },
  { key: 'socks5', title: 'SOCKS5' },
]

/** Значения на случай отсутствия ключа. До первого чтения поля не пустуют. */
const enabled = ref(DEFAULT_PROXY.enabled)
const kind = ref(DEFAULT_PROXY.kind)
const host = ref(DEFAULT_PROXY.host)
const login = ref(DEFAULT_PROXY.login)
const password = ref(DEFAULT_PROXY.password)
const bypass = ref(DEFAULT_PROXY.bypass)

/** Порт строкой, а не числом: normalizeProxyPort превратил бы стёртое поле в ноль под курсором. */
const portDraft = ref(String(DEFAULT_PROXY.port))

/** Снимок запуска: из него строка состояния и ответ, нужен ли перезапуск (движок читает адрес раз). */
const status = ref<ProxyStatus | null>(null)

const error = ref('')

const checking = ref(false)
const checkText = ref('')
const checkOk = ref(false)

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Что записано сейчас, в том виде, в каком это понимает остальной код. */
function currentConfig(): ProxyConfig {
  return {
    enabled: enabled.value,
    kind: kind.value,
    host: host.value.trim(),
    port: normalizeProxyPort(portDraft.value),
    login: login.value.trim(),
    password: password.value,
    bypass: bypass.value,
  }
}

/** Включённый тумблер с пустым или негодным адресом: трафик пойдёт напрямую. */
const badConfig = computed(() => enabled.value && !isProxyUsable(currentConfig()))

/** Кнопка перезапуска показывается только тогда, когда он что-то изменит. */
const needsRestart = computed(
  () => status.value !== null && proxyRestartNeeded(status.value, currentConfig()),
)

/** Пароль лежит в файле открытым текстом — предупредить до ввода; на пустом поле это шум. */
const hasPassword = computed(() => password.value.length > 0)

/** SOCKS5 с логином окно не принимает, запросы программы — да; сказать, что сломано не всё. */
const socksWithAuth = computed(() => kind.value === 'socks5' && login.value.trim().length > 0)

/** Строка состояния теми же словами, что были у карточки в юзерскрипте. */
const statusText = computed(() => {
  const s = status.value
  if (s === null) return 'читаем…'

  if (s.outcome === 'off') return 'при запуске прокси был выключен — трафик идёт напрямую'
  if (s.outcome === 'invalid') {
    return 'при запуске прокси был включён, но адрес негоден — трафик идёт напрямую'
  }
  if (s.outcome === 'unreachable')
    return `при запуске ${s.server} не ответил — трафик идёт напрямую`
  if (s.outcome === 'windowUnsupported') {
    // Не «не ответил»: адрес ответил, беда в платформе. Сказать и то, что тумблер
    // не впустую: запросы программы идут через прокси, страница — нет.
    return (
      `${s.server} отвечает, но окно на этой платформе прокси не умеет: ` +
      'запросы программы идут через него, страница — напрямую'
    )
  }

  if (s.auth === 'rejected') {
    return `${s.server} применён, но логин или пароль он не принял — страница останется пустой`
  }
  if (s.auth === 'pending') return `${s.server} применён, авторизация запрошена и ответа пока нет`
  if (s.auth === 'accepted') return `применён ${s.server}, авторизация пройдена`

  return `при запуске применён ${s.server}${s.hasCredentials ? ' (с логином)' : ''}`
})

async function loadConfig(): Promise<void> {
  try {
    const config = await readProxyConfig()

    enabled.value = config.enabled
    kind.value = config.kind
    host.value = config.host
    // Ноль значит «значения нет»: показать вместо него ноль — соврать про адрес.
    portDraft.value = config.port === 0 ? '' : String(config.port)
    login.value = config.login
    password.value = config.password
    bypass.value = config.bypass
  } catch (e) {
    error.value = 'Настройки не прочитаны — поля показывают значения по умолчанию. ' + describe(e)
  }
}

/** Снимок запуска. Зовётся и по нажатию проверки: исход авторизации меняется по ходу. */
async function loadStatus(): Promise<void> {
  try {
    status.value = await Bridge.proxyDiagnostics.status()
  } catch (e) {
    // Без снимка кнопка перезапуска не появится никогда; молчать нельзя:
    // человек решит, что настройка применилась.
    error.value = 'Состояние прокси неизвестно — перезапуск не предлагается. ' + describe(e)
  }
}

/** Адрес к виду движка: схему и замыкающую косую снимаем, иначе вышло бы «http://http://host:port». */
function cleanHost(): void {
  host.value = host.value
    .trim()
    .replace(/^\w+:\/\//, '')
    .replace(/\/+$/, '')
}

function onEnabled(): void {
  void saveProxyField('enabled', enabled.value)
}

/** Выбор вида: значение нормализуется, чтобы чужое не легло в файл настроек;
 *  повторный выбор того же вида ничего не пишет — лишняя запись на ровном месте. */
function pickKind(next: string): void {
  const wanted = normalizeProxyKind(next)
  if (kind.value === wanted) return

  kind.value = wanted
  void saveProxyField('kind', kind.value)
}

function onHost(): void {
  cleanHost()
  void saveProxyField('host', host.value)
}

function onPort(): void {
  void saveProxyField('port', normalizeProxyPort(portDraft.value))
}

function onLogin(): void {
  login.value = login.value.trim()
  void saveProxyField('login', login.value)
}

/// Пароль не обрезается: пробел по краям в нём законен, а тихая правка
/// дала бы отказ авторизации без единого слова о причине.
function onPassword(): void {
  void saveProxyField('password', password.value)
}

function onBypass(): void {
  void saveProxyField('bypass', bypass.value)
}

function onRestart(): void {
  void Bridge.shell.restart()
}

/** Проверка в два шага: TCP-щуп («кто-то слушает адрес?») и настоящий запрос («пускают ли наружу?»).
 *  Расхождение — самое ценное: «ответил, но не пустил» — логин/вид, «молчит, а запрос прошёл» — мимо прокси. */
async function check(): Promise<void> {
  if (checking.value) return

  checking.value = true
  checkText.value = ''
  void loadStatus()

  try {
    const probe = await Bridge.proxyDiagnostics.probe()

    if (probe.outcome === 'off') {
      checkOk.value = false
      checkText.value = 'Прокси выключен — проверять нечего.'
      return
    }

    if (probe.outcome === 'invalid') {
      checkOk.value = false
      checkText.value = 'Адрес или порт заданы неверно — проверять нечего.'
      return
    }

    const reached = await proxyLiveCheck()

    if (probe.reachable && reached) {
      checkOk.value = true
      checkText.value = `Прокси ${probe.server} ответил за ${probe.latencyMs} мс, и запрос через него прошёл.`
    } else if (probe.reachable && !reached) {
      checkOk.value = false
      checkText.value = `Прокси ${probe.server} ответил, но наружу не пустил: проверьте логин, пароль и вид прокси.`
    } else if (!probe.reachable && reached) {
      checkOk.value = false
      checkText.value = `Прокси ${probe.server} не отвечает, а запрос всё равно прошёл — значит, он ушёл напрямую.`
    } else {
      checkOk.value = false
      checkText.value = `Прокси ${probe.server} не отвечает, и запрос не прошёл.`
    }
  } catch (e) {
    checkOk.value = false
    checkText.value = 'Проверка не удалась: ' + describe(e)
  } finally {
    checking.value = false
  }
}

onMounted(() => {
  void loadConfig()
  void loadStatus()
})
</script>

<template>
  <div class="am-panel am-box">
    <h3 class="am-h3">Прокси</h3>

    <label class="am-switch">
      <input v-model="enabled" type="checkbox" class="am-switch__box" @change="onEnabled" />
      <span class="am-switch__name">Использовать прокси</span>
    </label>

    <!-- Вид и порт узкие, адрес забирает остаток: набирают его чаще всего.
         Подпись у списка невидимая, для читалок: у закрытого видно лишь значение. -->
    <div class="am-row">
      <div class="am-field am-proxy__kind">
        <PickBox
          :model-value="kind"
          :items="KINDS"
          label="Вид прокси"
          @update:model-value="pickKind"
        />
      </div>

      <label class="am-field am-proxy__addr">
        <input
          v-model="host"
          v-tip="'Адрес без схемы: 127.0.0.1 или proxy.local'"
          class="am-input"
          type="text"
          placeholder="Адрес: 127.0.0.1 или proxy.local"
          @change="onHost"
        />
      </label>

      <label class="am-field am-proxy__port">
        <input
          v-model="portDraft"
          class="am-input"
          type="text"
          inputmode="numeric"
          placeholder="Порт"
          @change="onPort"
        />
      </label>
    </div>

    <div class="am-row">
      <label class="am-field">
        <input
          v-model="login"
          class="am-input"
          type="text"
          placeholder="Логин, если прокси его требует"
          @change="onLogin"
        />
      </label>

      <label class="am-field">
        <input
          v-model="password"
          class="am-input"
          type="password"
          placeholder="Пароль"
          @change="onPassword"
        />
      </label>
    </div>

    <!-- Обёртка по необходимости: flex: 1 1 240px у .am-field в колонке панели
         дал бы высоту 240px, поэтому поле, как все прочие, стоит в .am-row. -->
    <div class="am-row">
      <label class="am-field">
        <input
          v-model="bypass"
          class="am-input"
          type="text"
          placeholder="Без прокси: localhost, 127.0.0.1"
          @change="onBypass"
        />
      </label>
    </div>

    <p class="am-meta">
      Адреса в обход прокси — через запятую или с новой строки. Пустое поле значит «через прокси
      идёт всё».
    </p>

    <p v-if="badConfig" class="am-warn">
      Прокси включён, но адрес или порт заданы неверно — трафик пойдёт напрямую.
    </p>

    <p v-if="hasPassword" class="am-warn">
      Пароль лежит в файле настроек открытым текстом: не вводите здесь пароль, который значит что-то
      ещё. Окно авторизуется у прокси само, второй раз его вводить не придётся.
    </p>

    <p v-if="socksWithAuth" class="am-warn">
      SOCKS5 с логином движок окна не поддерживает: страница пойдёт через такой прокси без
      авторизации и, скорее всего, получит отказ. Запросы AniMori логин и пароль используют, поэтому
      источники продолжат работать.
    </p>

    <!-- Строка состояния: подпись сверху, ответ снизу. Ответ длинный и переносится. -->
    <div class="am-proxy__state">
      <span class="am-proxy__name">Состояние</span>
      <span class="am-proxy__text">{{ statusText }}</span>
    </div>

    <p v-if="needsRestart" class="am-warn">
      Изменения сохранены и дойдут до окна только с новым запуском: ключи запуска движок читает один
      раз, при создании окна. Перезагрузка страницы здесь не поможет — она обновит разметку, а
      движок останется с прежним адресом.
    </p>

    <div class="am-row">
      <button class="am-btn am-btn--ghost" type="button" :disabled="checking" @click="check">
        {{ checking ? 'Проверяем…' : 'Проверить сейчас' }}
      </button>

      <button
        v-if="needsRestart"
        v-tip="'Перезапустить программу, чтобы новый адрес дошёл до окна'"
        class="am-btn"
        type="button"
        @click="onRestart"
      >
        Перезапустить
      </button>
    </div>

    <p v-if="checkText" :class="checkOk ? 'am-note' : 'am-error'">{{ checkText }}</p>
    <p v-if="error" class="am-error">{{ error }}</p>
  </div>
</template>

<style scoped src="../screens/settings-screen.css"></style>
