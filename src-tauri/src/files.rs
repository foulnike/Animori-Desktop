// Запись и чтение собственных файлов приложения: дубль снимка на случай, когда хранилище окна
// почистили со стороны (пункт 2.5.2), и датасет названий.

use std::fs;

use tauri::{AppHandle, Manager};

/// Разрешённые имена. Список, а не проверка символов: так команда не станет способом положить в
/// каталог приложения что угодно и под любым именем.
const ALLOWED: &[&str] = &["animori-snapshot.json", "animori-dataset.json"];

/// Потолок записи в байтах. Снимок на десять тысяч записей весит около мегабайта, распакованный
/// датасет названий — около четырёх.
const MAX_BYTES: usize = 8 * 1024 * 1024;

/// Проверяет имя и собирает полный путь в приватном каталоге приложения.
/// Каталог создаётся здесь же: на первом запуске его ещё нет.
fn resolve(app: &AppHandle, name: &str) -> Result<std::path::PathBuf, String> {
    if !ALLOWED.contains(&name) {
        return Err(format!("Имя файла не разрешено: {name}"));
    }

    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Нет каталога приложения: {e}"))?;

    fs::create_dir_all(&dir).map_err(|e| format!("Не создать каталог приложения: {e}"))?;

    Ok(dir.join(name))
}

/// Пишет текст в файл целиком. Сначала во временный соседний файл, потом
/// переименованием: иначе гибель процесса оставит обрезанный снимок.
#[tauri::command]
pub async fn animori_file_write(app: AppHandle, name: String, text: String) -> Result<(), String> {
    if text.len() > MAX_BYTES {
        return Err(format!("Файл слишком большой: {} байт", text.len()));
    }

    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve(&app, &name)?;
        let temp = path.with_extension("tmp");

        fs::write(&temp, text.as_bytes()).map_err(|e| format!("Не записать файл: {e}"))?;
        fs::rename(&temp, &path).map_err(|e| format!("Не заменить файл: {e}"))?;

        Ok(())
    })
    .await
    .map_err(|e| format!("Запись файла не завершилась: {e}"))?
}

/// Читает файл целиком. Отсутствие файла — не ошибка, а None: первый
/// запуск выглядит ровно так же, как запуск без дубля.
#[tauri::command]
pub async fn animori_file_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = resolve(&app, &name)?;

        match fs::read_to_string(&path) {
            Ok(text) => Ok(Some(text)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(format!("Не прочитать файл: {e}")),
        }
    })
    .await
    .map_err(|e| format!("Чтение файла не завершилось: {e}"))?
}
