// Пункт 2.3: запросы к AniList GraphQL из процесса оболочки. Пропуск в разметку не отдаётся:
// команда принимает только тело запроса, а заголовок авторизации подставляет сама, читая настройки.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_http::reqwest;
use tauri_plugin_store::StoreExt;

const GRAPHQL_URL: &str = "https://graphql.anilist.co";

/// Тот же файл, что у входа и прокси: второе хранилище разошлось бы с первым.
const STORE_FILE: &str = "animori-settings.json";

/// Ключ повторяет KEY_TOKEN из auth.rs: пропуск пишет вход, читаем его мы.
const KEY_TOKEN: &str = "auth_token";

// Ключи прокси повторяют proxy.rs. Общего разбора нет намеренно: тот файл
// у потолка размера, и переезд разбора отложен до его следующей правки.
const KEY_PROXY_ENABLED: &str = "set_proxy_on";
const KEY_PROXY_KIND: &str = "set_proxy_kind";
const KEY_PROXY_HOST: &str = "set_proxy_host";
const KEY_PROXY_PORT: &str = "set_proxy_port";
const KEY_PROXY_LOGIN: &str = "set_proxy_login";
const KEY_PROXY_PASSWORD: &str = "set_proxy_pass";

/// Потолок ожидания ответа. AniList отвечает за секунды, всё дольше — авария.
const TIMEOUT_SECS: u64 = 30;

struct CachedClient {
    key: String,
    client: reqwest::Client,
}

/** Переиспользует TLS-сессии и соединения до смены настроек прокси. */
pub struct AniListClientState(Mutex<Option<CachedClient>>);

impl Default for AniListClientState {
    fn default() -> Self {
        Self(Mutex::new(None))
    }
}

/// Ответ в том же виде, что HttpResponse у моста, кроме адреса: он всегда один.
/// Заголовки идут наверх целиком: по ним ограничитель узнаёт остаток лимита.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AniListReply {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub text: String,
}

/// Строка из настроек. Числа тоже принимаются: файл правят руками.
fn read_string(value: Option<serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s.trim().to_string(),
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Пароль без обрезки краёв: пробел в нём законен, а тихая правка даст отказ.
fn read_password(value: Option<serde_json::Value>) -> String {
    match value {
        Some(serde_json::Value::String(s)) => s,
        Some(serde_json::Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// Ноль значит «значения нет», как в normalizeProxyPort() и в proxy.rs.
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

/// Пропуск из файла настроек. None — вход не выполнен либо пропуск стёрт.
/// Срок здесь не проверяется: об истёкшем пропуске скажет сам AniList отказом.
fn read_token(app: &AppHandle) -> Option<String> {
    let store = app.store(STORE_FILE).ok()?;
    let token = read_string(store.get(KEY_TOKEN));

    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

/// Прокси для НАШЕГО канала: адрес, логин, пароль. None — идём напрямую.
/// Список исключений не читается: у запроса один адрес, и он не локальный.
fn read_proxy(app: &AppHandle) -> Option<(String, String, String)> {
    let store = app.store(STORE_FILE).ok()?;

    let enabled = matches!(
        store.get(KEY_PROXY_ENABLED),
        Some(serde_json::Value::Bool(true))
    );
    if !enabled {
        return None;
    }

    let host = read_string(store.get(KEY_PROXY_HOST));
    let port = read_port(store.get(KEY_PROXY_PORT));

    if host.is_empty() || port == 0 {
        // Инвариант 4: включённый тумблер без адреса не должен молчать.
        log::warn!("Прокси включён, но адрес или порт заданы неверно — запрос идёт напрямую");
        return None;
    }

    let scheme = if read_string(store.get(KEY_PROXY_KIND)) == "socks5" {
        "socks5"
    } else {
        "http"
    };

    Some((
        format!("{scheme}://{host}:{port}"),
        read_string(store.get(KEY_PROXY_LOGIN)),
        read_password(store.get(KEY_PROXY_PASSWORD)),
    ))
}

/// Своё представление: без него reqwest подписывается собой, и это уже давало
/// отказ 403 у стороннего API. Версия берётся из Cargo, другой в Rust нет.
fn user_agent() -> String {
    format!(
        "AniMori/{} (+https://github.com/foulnike/Animori-Desktop)",
        env!("CARGO_PKG_VERSION")
    )
}

/// Клиент на один запрос: прокси читается каждый раз, и смена настройки
/// действует сразу — в отличие от окна, где адрес живёт до перезапуска.
fn build_client(app: &AppHandle) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().timeout(Duration::from_secs(TIMEOUT_SECS));

    if let Some((url, login, password)) = read_proxy(app) {
        let mut proxy = reqwest::Proxy::all(&url)
            .map_err(|e| format!("network: адрес прокси не разбирается: {e}"))?;

        // Логин отдельно от адреса: пароль с ':' или '@' сломал бы склейку.
        if !login.is_empty() {
            proxy = proxy.basic_auth(&login, &password);
        }

        builder = builder.proxy(proxy);
    }

    builder
        .build()
        .map_err(|e| format!("network: клиент не собрался: {e}"))
}

fn client_key(proxy: &Option<(String, String, String)>) -> String {
    match proxy {
        Some((url, login, password)) => format!("{url}\u{0}{login}\u{0}{password}"),
        None => String::new(),
    }
}

fn cached_client(app: &AppHandle, state: &AniListClientState) -> Result<reqwest::Client, String> {
    let proxy = read_proxy(app);
    let key = client_key(&proxy);

    {
        let guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(cached) = guard.as_ref() {
            if cached.key == key {
                return Ok(cached.client.clone());
            }
        }
    }

    let client = build_client(app)?;
    let mut guard = state.0.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(cached) = guard.as_ref() {
        if cached.key == key {
            return Ok(cached.client.clone());
        }
    }
    *guard = Some(CachedClient {
        key,
        client: client.clone(),
    });
    Ok(client)
}

/// Вид сбоя префиксом в тексте ошибки: кода ответа тут нет, а мосту нужно
/// поднять свой класс сбоя. Второе место разбора — TauriAniList.ts.
fn classify(error: reqwest::Error) -> String {
    if error.is_timeout() {
        format!("timeout: {error}")
    } else {
        format!("network: {error}")
    }
}

/// Пункт 2.3: один запрос GraphQL к AniList. Тело собирает разметка, адрес и авторизация — наше
/// дело: иначе команда стала бы способом отправить пропуск куда угодно.
#[tauri::command]
pub async fn animori_anilist_query(
    app: AppHandle,
    state: tauri::State<'_, AniListClientState>,
    body: String,
    use_auth: bool,
) -> Result<AniListReply, String> {
    let token = if use_auth { read_token(&app) } else { None };

    if use_auth && token.is_none() {
        return Err("Вход в AniList не выполнен".to_string());
    }

    let client = cached_client(&app, &state)?;

    let mut request = client
        .post(GRAPHQL_URL)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .header(reqwest::header::ACCEPT, "application/json")
        .header(reqwest::header::USER_AGENT, user_agent())
        .body(body);

    if let Some(token) = token {
        request = request.bearer_auth(token);
    }

    let response = request.send().await.map_err(classify)?;

    let status = response.status().as_u16();

    // Имена к нижнему регистру, как в обеих реализациях моста: чтение
    // retry-after не должно зависеть от платформы.
    let mut headers: HashMap<String, String> = HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(text) = value.to_str() {
            headers.insert(name.as_str().to_ascii_lowercase(), text.to_string());
        }
    }

    let text = response.text().await.map_err(classify)?;

    Ok(AniListReply {
        status,
        headers,
        text,
    })
}
