// Прокси для канала САМОГО ОКНА; наши запросы к API идут мимо, через TauriBridge.ts.

use std::net::{SocketAddr, TcpStream, ToSocketAddrs};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_store::StoreExt;

/// То же имя, что у LazyStore в src/shared/bridge/TauriBridge.ts: файл один на обе стороны.
const STORE_FILE: &str = "animori-settings.json";

/// Проверка идёт в setup() и задерживает появление окна; местному прокси хватает.
const PROBE_TIMEOUT_MS: u64 = 500;

/// По кнопке щедрее: удалённый прокси отвечает за секунду и зря счёлся бы мёртвым.
const PROBE_TIMEOUT_MANUAL_MS: u64 = 2000;

/// У to_socket_addrs() своего таймаута нет: при мёртвом DNS setup() висит
/// десятки секунд без единого окна на экране.
const RESOLVE_TIMEOUT_MS: u64 = 700;

// Ключи повторяют PROXY_KEYS из src/shared/core/proxy.ts: Rust к модулям TypeScript не ходит.
const KEY_ENABLED: &str = "set_proxy_on";
const KEY_KIND: &str = "set_proxy_kind";
const KEY_HOST: &str = "set_proxy_host";
const KEY_PORT: &str = "set_proxy_port";
const KEY_LOGIN: &str = "set_proxy_login";
const KEY_PASSWORD: &str = "set_proxy_pass";
const KEY_BYPASS: &str = "set_proxy_bypass";

/// Совпадает с DEFAULT_PROXY.bypass в src/shared/core/proxy.ts и подставляется только при
/// отсутствии ключа: пустая строка в файле — осознанный выбор человека.
const DEFAULT_BYPASS: &str = "localhost, 127.0.0.1";

/// Applied значит лишь «движок получил адрес»: прокси, что принимает соединение, но не пускает
/// наружу, TCP-щуп не отличит. WindowUnsupported — не Unreachable: адрес ответил, передать нечем.
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProxyOutcome {
    Off,
    Invalid,
    Unreachable,
    /// Собирается только вне Windows, поэтому на Windows предупреждение
    /// «никогда не строится» снимается — приём тот же, что у WindowAuth ниже.
    #[cfg_attr(windows, allow(dead_code))]
    WindowUnsupported,
    Applied,
}

/// Как окно живёт с авторизацией у прокси. Accepted косвенный: кода ошибки
/// в событии нет, и принятие видно лишь по отсутствию повторного запроса.
#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProxyAuth {
    None,
    Pending,
    Accepted,
    Rejected,
}

/// Что действует в окне прямо сейчас. Снимок делается один раз, при запуске.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyStatus {
    outcome: ProxyOutcome,
    /// Пусто для всех исходов, кроме Applied.
    server: String,
    /// По этому полю панель объясняет разницу в поведении окна и наших запросов.
    has_credentials: bool,
    /// Собирается при вызове команды: авторизация случается позже снимка.
    auth: ProxyAuth,
}

/// Ответ про то, что записано в настройках СЕЙЧАС, а не про снимок запуска.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyProbe {
    /// Здесь Applied читается как «отвечает и был бы применён при следующем запуске».
    outcome: ProxyOutcome,
    server: String,
    has_credentials: bool,
    /// Ноль, когда до щупа дело не дошло.
    latency_ms: u64,
}

/// Состояние живёт в приложении: команда status вызывается из окна, а окно
/// про setup() не знает. Mutex — требование Tauri, запись всё равно одна.
pub struct ProxyState(Mutex<ProxyStatus>);

/// Всё, что нужно обработчику авторизации окна. bypass здесь потому, что на этих
/// адресах трафик идёт мимо прокси и подставлять учётные данные нельзя.
#[derive(Clone)]
#[cfg_attr(not(windows), allow(dead_code))]
pub struct WindowAuth {
    pub login: String,
    pub password: String,
    pub bypass: Vec<String>,
}

/// Пароль живёт только в памяти процесса: файл настроек в обработчике события
/// читать нельзя, а в журнал он не попадает никогда.
pub struct ProxyCredentials(Mutex<Option<WindowAuth>>);

/// Разобранная настройка в том виде, в каком её принимает движок окна.
struct ProxyArgs {
    /// Адрес без схемы и порт отдельно: только так их принимает проверка связи.
    host: String,
    port: u16,
    /// Для --proxy-server, например http://10.0.0.1:8080 или socks5://127.0.0.1:1080.
    server: String,
    /// Для --proxy-bypass-list. Пусто, если исключений нет.
    bypass: String,
    /// Учётные данные движку не передать аргументом: они уходят в ProxyCredentials.
    login: String,
    password: String,
    /// Влияет на предупреждение в журнале и на подпись в панели.
    has_credentials: bool,
}

/// Три состояния файла настроек: Option не отличал «выключен» от «включён,
/// но задан негодно», а панели надо сказать про них разное.
enum Config {
    Off,
    Invalid,
    On(Box<ProxyArgs>),
}

/// Числа тоже принимаются: файл настроек правят руками, и адрес запросто
/// окажется числом, а порт — строкой.
fn read_string(value: Option<serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Пароль без обрезки пробелов, как и в карточке настроек: пробел по краям
/// законен, а тихая правка дала бы отказ авторизации.
fn read_password(value: Option<serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s,
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Ноль означает «значения нет», как и в normalizeProxyPort() из src/shared/core/proxy.ts:
/// трактовка обязана совпадать.
fn read_port(value: Option<serde_json::Value>) -> u16 {
    let parsed = match value {
        Some(serde_json::Value::Number(n)) => n.as_u64().unwrap_or(0),
        Some(serde_json::Value::String(s)) => s.trim().parse::<u64>().unwrap_or(0),
        _ => 0,
    };

    if parsed == 0 || parsed > 65535 {
        0
    } else {
        parsed as u16
    }
}

/// Разбор уезжает в поток, потому что таймаут резольверу не навязать; брошенный
/// поток ничего не держит и дешевле зависшего без окна приложения.
fn resolve_with_timeout(target: &str, timeout: Duration) -> Option<Vec<SocketAddr>> {
    let (tx, rx) = std::sync::mpsc::channel();
    let owned = target.to_string();

    std::thread::spawn(move || {
        let resolved = owned.to_socket_addrs().map(|it| it.collect::<Vec<_>>());
        // Ошибка отправки значит лишь, что ожидающая сторона уже сдалась по таймауту.
        let _ = tx.send(resolved);
    });

    match rx.recv_timeout(timeout) {
        Ok(Ok(addrs)) => Some(addrs),
        Ok(Err(e)) => {
            log::warn!("Прокси: не удалось разобрать адрес {target}: {e}");
            None
        }
        Err(_) => {
            log::warn!("Прокси: разбор адреса {target} не уложился в отведённое время");
            None
        }
    }
}

/// Самая грубая проверка: открылось ли TCP-соединение. Цель не «работает ли
/// прокси», а отсечь опечатки и выключенные клиенты, оставляющие окно пустым.
fn probe(host: &str, port: u16, timeout_ms: u64) -> (bool, u64) {
    let target = format!("{host}:{port}");
    let started = Instant::now();

    let Some(addrs) = resolve_with_timeout(&target, Duration::from_millis(RESOLVE_TIMEOUT_MS))
    else {
        return (false, started.elapsed().as_millis() as u64);
    };

    // Имя может дать IPv6 и IPv4: достаточно любого ответившего, как и у движка.
    let ok = addrs
        .iter()
        .any(|addr| TcpStream::connect_timeout(addr, Duration::from_millis(timeout_ms)).is_ok());

    (ok, started.elapsed().as_millis() as u64)
}

/// Читает настройку прокси из файла настроек.
fn read_config(app: &AppHandle) -> Config {
    // Без файла настроек работаем напрямую, но молчать нельзя (инвариант 4).
    let store = match app.store(STORE_FILE) {
        Ok(store) => store,
        Err(e) => {
            log::warn!("Не удалось открыть файл настроек для чтения прокси: {e}");
            return Config::Off;
        }
    };

    let enabled = matches!(store.get(KEY_ENABLED), Some(serde_json::Value::Bool(true)));
    if !enabled {
        return Config::Off;
    }

    let host = read_string(store.get(KEY_HOST));
    let port = read_port(store.get(KEY_PORT));

    if host.is_empty() || port == 0 {
        // Человек видит включённый тумблер и считает, что трафик идёт через прокси.
        log::warn!("Прокси включён, но адрес или порт заданы неверно — окно идёт напрямую");
        return Config::Invalid;
    }

    // Неизвестное значение трактуется как http, как и в normalizeProxyKind().
    let scheme = if read_string(store.get(KEY_KIND)) == "socks5" {
        "socks5"
    } else {
        "http"
    };

    // Отсутствие ключа и пустое значение — разные вещи, см. DEFAULT_BYPASS.
    let raw_bypass = match store.get(KEY_BYPASS) {
        None => DEFAULT_BYPASS.to_string(),
        Some(value) => read_string(Some(value)),
    };

    // Chromium ждёт список через точку с запятой; записи с пробелом отбрасываем —
    // в имени хоста его быть не может, а строку аргументов он бы разорвал.
    let bypass = raw_bypass
        .split(|c| c == ',' || c == ';' || c == '\n' || c == '\r')
        .map(|item| item.trim())
        .filter(|item| !item.is_empty() && !item.contains(' '))
        .collect::<Vec<_>>()
        .join(";");

    let login = read_string(store.get(KEY_LOGIN));

    Config::On(Box::new(ProxyArgs {
        server: format!("{scheme}://{host}:{port}"),
        host,
        port,
        bypass,
        has_credentials: !login.is_empty(),
        password: read_password(store.get(KEY_PASSWORD)),
        login,
    }))
}

/// Вызывается ОДИН раз, в начале setup() и до создания окна. Состояние заводится
/// здесь же: его нельзя забыть, и команда status найдёт готовый ответ.
pub fn apply_to_webview(app: &AppHandle) {
    // app.restart() отдаёт потомку окружение родителя: без сноса старый --proxy-server
    // переживает выключение прокси.
    #[cfg(windows)]
    std::env::remove_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS");

    // Заводится ДО decide(): учётные данные складывает он сам, по месту решения.
    app.manage(ProxyCredentials(Mutex::new(None)));

    let status = decide(app);
    app.manage(ProxyState(Mutex::new(status)));
}

/// Складывает учётные данные для обработчика авторизации окна. Только при Applied:
/// без прокси в окне подставлять их некому и незачем.
fn remember_credentials(app: &AppHandle, args: &ProxyArgs) {
    if args.login.is_empty() {
        return;
    }

    let Some(state) = app.try_state::<ProxyCredentials>() else {
        log::warn!("Прокси: учётные данные некуда сложить, окно останется без авторизации");
        return;
    };

    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());

    *guard = Some(WindowAuth {
        login: args.login.clone(),
        password: args.password.clone(),
        bypass: args
            .bypass
            .split(';')
            .filter(|item| !item.is_empty())
            .map(|item| item.to_string())
            .collect(),
    });
}

fn decide(app: &AppHandle) -> ProxyStatus {
    let args = match read_config(app) {
        Config::Off => {
            return ProxyStatus {
                outcome: ProxyOutcome::Off,
                server: String::new(),
                has_credentials: false,
                auth: ProxyAuth::None,
            }
        }
        Config::Invalid => {
            return ProxyStatus {
                outcome: ProxyOutcome::Invalid,
                server: String::new(),
                has_credentials: false,
                auth: ProxyAuth::None,
            }
        }
        Config::On(args) => args,
    };

    // Страховка от кирпича: с мёртвым адресом вместе с сайтом пропадает панель
    // настроек — единственный способ выключить прокси обратно.
    let (reachable, _) = probe(&args.host, args.port, PROBE_TIMEOUT_MS);
    if !reachable {
        log::warn!(
            "Прокси {} не отвечает — окно идёт напрямую. \
             Настройка не сброшена: исправьте адрес или выключите прокси в настройках",
            args.server
        );
        return ProxyStatus {
            outcome: ProxyOutcome::Unreachable,
            server: args.server,
            has_credentials: args.has_credentials,
            auth: ProxyAuth::None,
        };
    }

    // Событие авторизации приходит позже и только если прокси его спросит.
    if args.has_credentials {
        log::info!("У прокси задан логин: окно авторизуется через обработчик в proxy_auth.rs");
    }

    let mut value = format!("--proxy-server={}", args.server);
    if !args.bypass.is_empty() {
        value.push_str(&format!(" --proxy-bypass-list={}", args.bypass));
    }

    // Только Windows: переменную читает WebView2. Под Linux окно рисует WebKitGTK,
    // и это работа ветки linux-dev, а не молчаливое бездействие здесь.
    #[cfg(windows)]
    {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", &value);
        log::info!("Прокси для окна: {}", args.server);

        remember_credentials(app, &args);

        ProxyStatus {
            outcome: ProxyOutcome::Applied,
            server: args.server,
            has_credentials: args.has_credentials,
            auth: ProxyAuth::None,
        }
    }

    #[cfg(not(windows))]
    {
        let _ = &value;
        let _ = remember_credentials;
        log::warn!("Прокси для окна на этой платформе пока не поддержан — страница идёт напрямую");

        // Не Applied: адрес движку никто не отдавал, зелёной галочке взяться неоткуда.
        ProxyStatus {
            outcome: ProxyOutcome::WindowUnsupported,
            server: args.server,
            has_credentials: args.has_credentials,
            auth: ProxyAuth::None,
        }
    }
}

/// Живой опрос обработчика: снимок запуска об авторизации знать не может.
fn auth_state(has_credentials: bool) -> ProxyAuth {
    if !has_credentials {
        return ProxyAuth::None;
    }

    #[cfg(windows)]
    {
        if crate::proxy_auth::was_rejected() {
            ProxyAuth::Rejected
        } else if crate::proxy_auth::was_asked() {
            ProxyAuth::Accepted
        } else {
            ProxyAuth::Pending
        }
    }

    // За пределами Windows прокси в окно не попадает, значит и спрашивать некому.
    #[cfg(not(windows))]
    {
        ProxyAuth::None
    }
}

/// Что действует в окне прямо сейчас: в сеть команда не ходит, адрес неизменен
/// до перезапуска, а вот авторизация меняется по ходу сеанса.
#[tauri::command]
pub fn animori_proxy_status(state: State<'_, ProxyState>) -> ProxyStatus {
    // Отравленный мьютекс не повод отказывать: внутри структура без инвариантов.
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());

    let mut status = guard.clone();
    status.auth = auth_state(status.has_credentials);
    status
}

/// Учётные данные для обработчика авторизации окна. None — подставлять нечего:
/// прокси выключен, задан негодно, молчит или логина у него нет.
pub fn window_auth(app: &AppHandle) -> Option<WindowAuth> {
    let state = app.try_state::<ProxyCredentials>()?;
    let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    guard.clone()
}

/// Перечитывает файл ЗАНОВО: смысл кнопки — проверить только что введённый адрес.
/// spawn_blocking обязателен: чтение, разбор имени и соединение блокируют поток.
#[tauri::command]
pub async fn animori_proxy_probe(app: AppHandle) -> Result<ProxyProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let args = match read_config(&app) {
            Config::Off => {
                return ProxyProbe {
                    outcome: ProxyOutcome::Off,
                    server: String::new(),
                    has_credentials: false,
                    latency_ms: 0,
                }
            }
            Config::Invalid => {
                return ProxyProbe {
                    outcome: ProxyOutcome::Invalid,
                    server: String::new(),
                    has_credentials: false,
                    latency_ms: 0,
                }
            }
            Config::On(args) => args,
        };

        let (reachable, latency_ms) = probe(&args.host, args.port, PROBE_TIMEOUT_MANUAL_MS);

        ProxyProbe {
            outcome: if reachable {
                ProxyOutcome::Applied
            } else {
                ProxyOutcome::Unreachable
            },
            server: args.server,
            has_credentials: args.has_credentials,
            latency_ms,
        }
    })
    .await
    .map_err(|e| format!("Проверка прокси не завершилась: {e}"))
}
