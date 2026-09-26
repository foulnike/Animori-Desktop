//! Пункт П.2: автообновление десктопной сборки. Весь процесс ведётся из Rust и ни одной строкой не
//! выходит в JS.

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// Запускает проверку в фоне. Вызывать строго ПОСЛЕ создания окна и только так: сетевой запрос к
/// GitHub в setup() задержал бы появление окна на время ответа сети, а при мёртвом соединении.
pub fn spawn_check(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        check(app).await;
    });
}

async fn check(app: AppHandle) {
    // Ошибка здесь — это неверная конфигурация (нет endpoints или битый pubkey),
    // а не проблема сети. Шуметь диалогом бессмысленно: пользователь такое не починит.
    let updater = match app.updater() {
        Ok(updater) => updater,
        Err(err) => {
            log::warn!("Апдейтер недоступен: {err}");
            return;
        }
    };

    // Отсутствие сети, упавший GitHub, корпоративный фаервол — всё это нормальные
    // состояния для фоновой проверки. Молча в журнал, без окошек.
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => {
            log::info!("Обновлений нет, текущая версия актуальная");
            return;
        }
        Err(err) => {
            log::warn!("Проверка обновлений не удалась: {err}");
            return;
        }
    };

    let version = update.version.clone();
    let current = update.current_version.clone();
    log::info!("Доступна версия {version} (установлена {current})");

    // Список изменений берётся из описания релиза и может быть сколь угодно длинным.
    // Родное окно Windows не умеет прокручиваться, поэтому обрезаем жёстко.
    let notes = update
        .body
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(|text| {
            let short: String = text.chars().take(600).collect();
            if text.chars().count() > 600 {
                format!("\n\n{short}...")
            } else {
                format!("\n\n{short}")
            }
        })
        .unwrap_or_default();

    let message = format!(
        "Доступна версия {version}. Установлена {current}.\n\nПриложение скачает установщик и перезапустится.{notes}"
    );

    // blocking_show блокирует вызывающий поток до ответа. Здесь это безопасно только потому, что
    // весь модуль живёт в фоновой задаче.
    let approved = app
        .dialog()
        .message(message)
        .title("Обновление AniMori")
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            "Установить".to_string(),
            "Позже".to_string(),
        ))
        .blocking_show();

    if !approved {
        log::info!("Обновление до {version} отложено пользователем");
        return;
    }

    // Оба обратных вызова обязательны по сигнатуре: первый зовётся на каждый кусок загрузки, второй
    // — один раз по её окончании.
    if let Err(err) = update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
    {
        log::error!("Установка обновления {version} не удалась: {err}");
        app.dialog()
            .message(format!(
                "Не удалось установить версию {version}.\n\n{err}\n\nСкачайте установщик вручную со страницы релизов на GitHub."
            ))
            .title("Обновление AniMori")
            .kind(MessageDialogKind::Error)
            .blocking_show();
        return;
    }

    log::info!("Версия {version} установлена, перезапуск");
    app.restart();
}
