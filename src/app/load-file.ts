// Загрузка файла ОТ человека — зеркало save-file.ts (отдаёт файл человеку). Путь один: скрытый <input type="file"> и родное окно; своя команда в Rust не нужна — читать выбранный самим человеком файл окну дозволено всегда. Место — app/, а не shared/core/: здесь DOM, ядро обязано оставаться независимым от площадки.
// GZIP распознаётся по подписи 1F 8B, а не по имени: MyAnimeList отдаёт animelist.xml.gz, но переименовать файл можно как угодно.

/** Выбранный файл, прочитанный в строку. */
export interface LoadedFile {
  /** Имя для весточек человеку: «Файл: animelist.xml.gz». */
  name: string
  /** Содержимое текстом, уже распакованное, если файл был сжат. */
  text: string
}

/** Первые два байта gzip: 1F 8B. */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

/** Читает файл в строку UTF-8, распаковав gzip по подписи; битый архив падает сам. */
async function readFile(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())

  if (!isGzip(bytes)) return new TextDecoder('utf-8').decode(bytes)

  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    return await new Response(stream).text()
  } catch {
    throw new Error('Файл сжат и не распаковывается. Стоит распаковать его и выбрать XML.')
  }
}

/** Выбор файла родным окном: null — передумал, отказ чтения — исключение; узел в документ не вставляется. */
export function pickTextFile(accept: string): Promise<LoadedFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept

    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        resolve(null)
        return
      }
      readFile(file).then(
        (text) => resolve({ name: file.name, text }),
        (e: unknown) => reject(e instanceof Error ? e : new Error(String(e))),
      )
    }

    // Событие cancel знают Chromium и WebView2; где его нет, окно закроется молча —
    // висеть обещанием безвредно: состояние занятости это не держит.
    input.oncancel = () => resolve(null)

    input.click()
  })
}
