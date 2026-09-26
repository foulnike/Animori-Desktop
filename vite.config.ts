import { readFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// Номер версии — из package.json, единственный источник в ветке: отсюда его берёт Tauri, а по нему
// обновляются установленные копии. Чтение файла, а не import JSON: иначе resolveJsonModule и типы.
const readJson = (name: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf-8'))

const { version } = readJson('./package.json') as { version: string }

// Сборка одна: своё веб-приложение со своим index.html внутри окна Tauri; режимов и ветвления
// по mode больше нет, поэтому defineConfig принимает объект, и --mode в командах npm не нужен.
export default defineConfig({
  // Корень сборки — src/app: там лежит свой index.html. Разметка держится вне
  // корня репозитория сознательно: корневой index.html Vite подхватывает сам.
  root: fileURLToPath(new URL('./src/app', import.meta.url)),
  resolve: {
    alias: {
      // Лёгкая сборка hls.js: полная приносила в кусок просмотра около 594 КБ; её лишнего
      // (DRM, субтитры, HEVC, AC-3 в TS) в наших потоках нет. Шов здесь: у лёгкой нет .d.ts.
      'hls.js': fileURLToPath(new URL('./node_modules/hls.js/dist/hls.light.mjs', import.meta.url)),
      // Пункт 3.4: реализация моста подставляется сборкой; шов оставлен — он ничего не стоит.
      // Вырезание потребовало бы правок импортов (Android из планов). Ключ обязан идти до '@'.
      '@bridge-impl': fileURLToPath(new URL('./src/shared/bridge/TauriBridge.ts', import.meta.url)),
      // Пункт 1.3: имена модулей при переезде в shared не менялись — старые сведены здесь.
      // Порядок обязателен: побеждает первое совпадение. Те же соответствия — в tsconfig.json.
      '@/api': fileURLToPath(new URL('./src/shared/api', import.meta.url)),
      '@/bridge': fileURLToPath(new URL('./src/shared/bridge', import.meta.url)),
      '@/core': fileURLToPath(new URL('./src/shared/core', import.meta.url)),
      '@/utils': fileURLToPath(new URL('./src/shared/utils', import.meta.url)),
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  define: {
    // Платформа одна. Значение оставлено, а не вырезано: по нему ветвится общий
    // код ядра, а впереди Android — там появится второе значение.
    __ANIMORI_PLATFORM__: JSON.stringify('app'),
    // Пункт 5.3.5: номер версии нужен рантайму для заголовка User-Agent
    // нашего канала (src/shared/bridge/TauriBridge.ts) и для экранов приложения.
    __ANIMORI_VERSION__: JSON.stringify(version),
    // Этап 2: флаги сборки Vue. Без них рантаим сыплет предупреждения в консоль.
    // Options API нигде не используется — только Composition API, поэтому false.
    __VUE_OPTIONS_API__: 'false',
    __VUE_PROD_DEVTOOLS__: 'false',
    __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
  },
  plugins: [vue()],
  build: {
    // Путь абсолютный: корень сборки — src/app, и относительный 'dist' уехал бы
    // внутрь исходников. Именно на dist/app смотрит frontendDist в tauri.conf.json.
    outDir: fileURLToPath(new URL('./dist/app', import.meta.url)),
    // Теперь можно без оглядки: в dist пишет один продукт. Прежде здесь стояло emptyOutDir:
    // !isTauri — тауринная сборка не имела права снести уже собранный рядом animori.user.js.
    emptyOutDir: true,
    minify: 'esbuild',
    target: 'es2022',
  },
})
