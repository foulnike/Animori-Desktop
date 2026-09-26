// Главное окно приложения грузит СВОЮ сборку (dist/app), а не чужой сайт. Прежде рядом жил запасной
// вид: настоящий anilist.co со внедрённым бандлом скрипта во втором окне (hybrid.rs, пункт 3.7).

use tauri_plugin_log::{RotationStrategy, Target, TargetKind, TimezoneStrategy};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_window_state::StateFlags;

use tauri::{AppHandle, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

// Авторизация окна у прокси. Только Windows: целиком событие WebView2.
#[cfg(windows)]
mod proxy_auth;

// Пункт 2.2: вход в аккаунт AniList отдельным окном.
mod auth;

// Пункт 2.3: запросы к API из процесса оболочки. Без cfg: запрос из Rust
// одинаков на всех платформах, в отличие от прокси для окна.
mod anilist;

// Пункт 2.5.2: дубль снимка в файл приватного каталога. Без cfg: работа
// с файлом одинакова везде, а на Android она нужнее всего.
mod files;

// Пункт 3.3: выгрузка списка в папку, выбранную человеком. Отдельно от files.rs: там служебный
// каталог и список из трёх имён, здесь чужая папка и родное окно выбора.
mod export;

mod updater;

// Прокси для трафика окна. Без cfg сознательно: чтение настроек одинаково везде, разница в
// применении спрятана внутри модуля.
mod proxy;

/// Что запоминается между запусками. Не StateFlags::all(): сохранённый VISIBLE даёт запуск без
/// единого окна, а из FULLSCREEN в окне без меню нечем выйти.
fn window_state_flags() -> StateFlags {
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

/// Перезагружает окно, из которого пришёл вызов. Окно приходит параметром, а не ищется по метке:
/// окон по-прежнему два — своё и окно входа, — и перезагружать надо то, откуда просили.
#[tauri::command]
fn animori_reload(window: WebviewWindow) -> Result<(), String> {
    window.reload().map_err(|e| e.to_string())
}

/// Перезапускает приложение. Нужна там, где перезагрузки страницы мало.
#[tauri::command]
fn animori_restart(app: AppHandle) -> Result<(), String> {
    log::info!("Перезапуск приложения по просьбе окна");
    app.restart()
}

/// Переключает полноэкранный режим окна и возвращает новое состояние: без него его пришлось бы
/// спрашивать вторым вызовом после каждого нажатия.
#[tauri::command]
fn animori_toggle_fullscreen(window: WebviewWindow) -> Result<bool, String> {
    let next = !window.is_fullscreen().map_err(|e| e.to_string())?;
    window.set_fullscreen(next).map_err(|e| e.to_string())?;
    Ok(next)
}

/// Открывает адрес в браузере по умолчанию. В WebView2 target="_blank" и window.open() превращаются
/// в запрос нового окна, и без обработчика он отбрасывается МОЛЧА.
#[tauri::command]
fn animori_open_external(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();

    let lowered = trimmed.to_ascii_lowercase();
    if !(lowered.starts_with("https://") || lowered.starts_with("http://")) {
        return Err(format!("Схема адреса не разрешена: {trimmed}"));
    }

    // None во втором аргументе — «браузер по умолчанию».
    app.opener()
        .open_url(trimmed, None::<&str>)
        .map_err(|e| e.to_string())
}

/// Открывает системную панель трансляции экрана и больше ничего: выбор приёмника делает человек, и
/// чем он кончился, система не сообщает никому.
#[tauri::command]
fn animori_cast_panel(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        const PANELS: [&str; 2] = [
            "ms-settings-connectabledevices:devicediscovery",
            "ms-settings:connecteddevices",
        ];

        let mut reasons: Vec<String> = Vec::new();

        for uri in PANELS.iter().copied() {
            match app.opener().open_url(uri, None::<&str>) {
                Ok(()) => {
                    // Какая из двух открылась — видно только здесь, а разница
                    // в жалобах «открылось не то» решает всё.
                    log::info!("Панель трансляции открыта: {uri}");
                    return Ok(());
                }
                Err(e) => reasons.push(format!("{uri}: {e}")),
            }
        }

        let first = PANELS[0];
        let why = reasons.join("; ");

        // Последний заход. Тот же адрес по нажатию в самой Windows открывает проводник, и там, где
        // плагин отказал, панель иногда всё равно появляется.
        match std::process::Command::new("explorer.exe").arg(first).spawn() {
            Ok(_) => {
                log::warn!("Панель трансляции: плагин отказал ({why}), отдано проводнику: {first}");
                Ok(())
            }
            Err(second) => Err(format!(
                "Панель трансляции не открылась: {why}; проводник: {second}"
            )),
        }
    }

    #[cfg(not(windows))]
    {
        // Параметр не убран из подписи: команда одна на все платформы,
        // и разные подписи сломали бы generate_handler! под cfg.
        let _ = app;
        Err("Панель трансляции экрана есть только в Windows".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(anilist::AniListClientState::default())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        // Плагин открывает адреса в системных приложениях и нужен только со стороны Rust:
        // opener:allow-open-url, выданный окну, открыл бы что угодно любому коду в нём.
        .plugin(tauri_plugin_opener::init())
        // Память геометрии окон. Регистрация именно в цепочке Builder, а не в setup(): плагины
        // оттуда поднимаются ДО setup, а окно создаётся внутри него.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags())
                .build(),
        )
        // Родные окна системы. Потребителей теперь два: автообновление (обоснования — в updater.rs)
        // и выбор папки для выгрузки списка и для трека темы (export.rs).
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Список команд дублируется в build.rs и в файлах capabilities: разрешено ровно то, что
        // перечислено в capability нужного окна.
        .invoke_handler(tauri::generate_handler![
            animori_reload,
            animori_restart,
            animori_toggle_fullscreen,
            animori_open_external,
            animori_cast_panel,
            auth::animori_auth_start,
            auth::animori_auth_submit,
            auth::animori_auth_status,
            auth::animori_auth_logout,
            anilist::animori_anilist_query,
            files::animori_file_read,
            files::animori_file_write,
            export::animori_export_pick_dir,
            export::animori_export_write,
            export::animori_track_pick_dir,
            export::animori_track_write,
            proxy::animori_proxy_status,
            proxy::animori_proxy_probe
        ])
        .setup(|app| {
            let log_level = if cfg!(debug_assertions) {
                log::LevelFilter::Info
            } else {
                log::LevelFilter::Warn
            };

            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log_level)
                    .rotation_strategy(RotationStrategy::KeepOne)
                    .timezone_strategy(TimezoneStrategy::UseLocal)
                    .max_file_size(2_000_000)
                    .targets([Target::new(TargetKind::LogDir { file_name: None })])
                    .build(),
            )?;

            // движок читает аргументы один раз, на первом окне. Первым идёт свое окно, окно входа
            // открывается позже и пользуется тем же окружением.
            proxy::apply_to_webview(app.handle());

            // Свое окно: WebviewUrl::default() — это index.html из frontendDist, то есть наша
            // сборка dist/app.
            WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::default())
                .title("AniMori")
                .inner_size(1280.0, 800.0)
                .min_inner_size(1024.0, 600.0)
                .resizable(true)
                .center()
                .build()?;

            // Проверка обновлений — последним шагом и только фоновой задачей: запрос
            // прямо здесь задержал бы окно на ответ GitHub, а при мёртвой сети — на весь таймаут.
            updater::spawn_check(app.handle().clone());

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
