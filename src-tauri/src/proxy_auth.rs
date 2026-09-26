// аргументом учётные данные движку не передать, а своего диалога у него нет: без обработчика запрос
// отменяется молча. Наши запросы к API идут мимо, через basicAuth в TauriBridge.ts.

use std::ffi::c_void;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use tauri::{AppHandle, WebviewWindow};
use webview2_com::BasicAuthenticationRequestedEventHandler;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2BasicAuthenticationRequestedEventArgs, ICoreWebView2Controller, ICoreWebView2_10,
};
use windows::core::{Interface, HSTRING, PCWSTR, PWSTR};
use windows::Win32::System::Com::CoTaskMemFree;

use crate::proxy::{self, WindowAuth};

/// Потолок против бесконечного круга при неверном пароле. При верном хватает
/// одной подстановки, остальное — запас на переподключения.
const MAX_ATTEMPTS: u32 = 5;

/// Сколько раз учётные данные подставлялись за сеанс. Сброса нет:
/// после пяти промахов подряд помогает перезапуск приложения.
static ATTEMPTS: AtomicU32 = AtomicU32::new(0);

/// Прокси вообще спрашивал авторизацию: без этого отчёту не в чем винить пароль.
static ASKED: AtomicBool = AtomicBool::new(false);

/// Повторный запрос после подстановки: прокси пару не принял.
static REJECTED: AtomicBool = AtomicBool::new(false);

/// Прокси хотя бы раз спросил учётные данные за этот сеанс.
pub fn was_asked() -> bool {
    ASKED.load(Ordering::Relaxed)
}

/// Признак косвенный: кода ошибки в событии нет.
pub fn was_rejected() -> bool {
    REJECTED.load(Ordering::Relaxed)
}

/// Хост без схемы, логина и порта. Разбор свой: тянуть разборщик адресов
/// ради одного поля незачем, а строка сюда приходит уже в нижнем регистре.
fn host_of(url: &str) -> &str {
    let rest = match url.find("://") {
        Some(i) => &url[i + 3..],
        None => url,
    };
    let end = rest.find('/').unwrap_or(rest.len());
    let authority = &rest[..end];
    let authority = match authority.rfind('@') {
        Some(i) => &authority[i + 1..],
        None => authority,
    };
    match authority.find(':') {
        Some(i) => &authority[..i],
        None => authority,
    }
}

/// Звёздочка и ведущая точка срезаются: *.local, .local и local — одно и то же.
fn is_bypassed(host: &str, rules: &[String]) -> bool {
    rules.iter().any(|raw| {
        let rule = raw
            .trim()
            .trim_start_matches('*')
            .trim_start_matches('.')
            .to_ascii_lowercase();

        if rule.is_empty() {
            return false;
        }

        // Целиком или как поддомен: через contains под «local» попал бы «evil-local.example».
        host == rule
            || (host.len() > rule.len()
                && host.ends_with(&rule)
                && host.as_bytes()[host.len() - rule.len() - 1] == b'.')
    })
}

/// Ошибка не валит приложение: без обработчика поведение окна прежнее.
pub fn install(app: &AppHandle, window: &WebviewWindow) {
    let Some(auth) = proxy::window_auth(app) else {
        return;
    };

    let outcome = window.with_webview(move |platform| {
        if let Err(e) = unsafe { attach(platform.controller(), auth) } {
            log::warn!("Авторизация у прокси не подключена: {e}");
        }
    });

    if let Err(e) = outcome {
        log::warn!("Не удалось добраться до движка окна для авторизации у прокси: {e}");
    }
}

unsafe fn attach(
    controller: ICoreWebView2Controller,
    auth: WindowAuth,
) -> windows::core::Result<()> {
    let core = controller.CoreWebView2()?;

    // Событие из десятой ревизии интерфейса: старый рантайм его не знает.
    let Ok(core10) = core.cast::<ICoreWebView2_10>() else {
        log::warn!("Старый рантайм WebView2: окно не сможет авторизоваться у прокси");
        return Ok(());
    };

    let handler =
        BasicAuthenticationRequestedEventHandler::create(Box::new(move |_sender, args| {
            let Some(args) = args else { return Ok(()) };
            // Ошибка на одном запросе не должна ломать всё окно: пропускаем его.
            if let Err(e) = unsafe { on_request(&auth, &args) } {
                log::warn!("Авторизация у прокси: запрос не разобран: {e}");
            }
            Ok(())
        }));

    // Имя типа токена руками писать нельзя: оно ездит между версиями привязок.
    let mut token = Default::default();
    core10.add_BasicAuthenticationRequested(&handler, &mut token)?;

    log::info!("Авторизация у прокси подключена к движку окна");
    Ok(())
}

/// Событие одно и на 407 от прокси, и на 401 от сайта, а в аргументах — адрес
/// ресурса: отсюда два предохранителя и запись каждой подстановки в журнал.
unsafe fn on_request(
    auth: &WindowAuth,
    args: &ICoreWebView2BasicAuthenticationRequestedEventArgs,
) -> windows::core::Result<()> {
    // COM-память освобождает вызывающий: строку отдал движок, снимать её нам.
    let mut raw = PWSTR::null();
    args.Uri(&mut raw)?;
    let uri = raw.to_string().unwrap_or_default();
    CoTaskMemFree(Some(raw.0 as *const c_void));

    let lowered = uri.to_ascii_lowercase();
    let host = host_of(&lowered);

    // Сюда трафик идёт мимо прокси, значит авторизацию спросил сам сайт.
    if is_bypassed(host, &auth.bypass) {
        log::warn!("Авторизация запрошена на {host} мимо прокси — учётные данные не подставлены");
        return Ok(());
    }

    ASKED.store(true, Ordering::Relaxed);

    let attempt = ATTEMPTS.fetch_add(1, Ordering::Relaxed) + 1;

    // Повтор после подстановки значит одно: предыдущую пару прокси не принял.
    if attempt > 1 {
        REJECTED.store(true, Ordering::Relaxed);
    }

    if attempt > MAX_ATTEMPTS {
        log::warn!(
            "Запрос авторизации повторился больше {MAX_ATTEMPTS} раз — учётные данные \
             больше не подставляются: прокси их не принимает"
        );
        return Ok(());
    }

    let response = args.Response()?;

    // HSTRING живёт до конца функции: указатель на временную строку был бы висячим.
    let login = HSTRING::from(auth.login.as_str());
    let password = HSTRING::from(auth.password.as_str());

    response.SetUserName(PCWSTR(login.as_ptr()))?;
    response.SetPassword(PCWSTR(password.as_ptr()))?;

    // Адрес в журнале обязателен: так видно, если учётные данные ушли не туда.
    log::info!("Учётные данные прокси подставлены для {host}, попытка {attempt}");

    Ok(())
}
