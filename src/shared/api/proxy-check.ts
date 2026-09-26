// Живой запрос через прокси — то, чего не может TCP-щуп в src-tauri/src/proxy.rs.
// Исход не отдаётся в core/net-health.ts: иначе та же неудача считалась бы дважды.

import { Bridge } from '@/bridge'

import { Logger } from '../utils/logger'
import { githubLimiter } from './rate-limit'

/** Что читаем: файл в репозитории GitHub, адрес разрешён в capabilities, отдаётся без входа. */
const CHECK_URL =
  'https://raw.githubusercontent.com/foulnike/Animori-Desktop/main/README.md'

/** Потолок ожидания: проверка идёт по кнопке, и ждать дольше нечего. */
const CHECK_TIMEOUT_MS = 8000

/** Прошёл ли запрос. Вид сбоя не возвращается: молчание прокси — дело щупа. */
export async function proxyLiveCheck(): Promise<boolean> {
  await githubLimiter.acquireSlot()

  try {
    const res = await Bridge.http.request({
      method: 'GET',
      url: CHECK_URL,
      credentials: 'omit',
      timeoutMs: CHECK_TIMEOUT_MS,
    })

    return res.ok
  } catch (e) {
    // Отказ — исход проверки, а не поломка; но в журнал пишем: молчаливый catch запрещён.
    Logger('WARN', 'Прокси: проверочный запрос не прошёл', e)
    return false
  }
}
