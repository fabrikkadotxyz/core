// Prevents a console window from appearing alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Fabrikka desktop app.
//!
//! Two jobs. It shows the instance's web app in its main window (M9), and it runs
//! the local host — the thing that runs your agents in folders you grant — as its
//! own child, with a tray icon and a Folders window (M34, ADR 0031).
//!
//! The host is the same `fabrikka.mjs` every instance serves, run by the Node
//! this app bundles. The Folders window reaches it through Rust and the child's
//! stdin/stdout: there is no network port. The main window shows a REMOTE page,
//! and no capability names a remote URL, so it can call none of the host
//! commands; only the bundled Folders window can.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde_json::{json, Value};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::path::BaseDirectory;
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Manager, RunEvent, Wry, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as _};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::oneshot;

/* ------------------------------------------------------------------ settings */

fn config_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

/// The configured server, if one has been chosen. `FABRIKKA_URL` wins, so a
/// managed deployment can pin it; the installer writes the file.
fn stored_url(app: &AppHandle) -> Option<String> {
    if let Ok(from_env) = std::env::var("FABRIKKA_URL") {
        if !from_env.trim().is_empty() {
            return Some(from_env.trim().to_string());
        }
    }
    let raw = fs::read_to_string(config_dir(app)?.join("server-url")).ok()?;
    let trimmed = raw.trim().to_string();
    (!trimmed.is_empty()).then_some(trimmed)
}

/// Only http(s): the webview would happily navigate to file:// or a custom scheme.
fn parse_server(url: &str) -> Result<url::Url, String> {
    let parsed = url::Url::parse(url.trim()).map_err(|_| "that is not a valid URL".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("the server URL must start with http:// or https://".into());
    }
    Ok(parsed)
}

/// Start at login is on unless the person turned it off (ADR 0031). Decided once:
/// on the first-run page, or — when the installer pre-set the server — at first launch.
fn settle_autostart(app: &AppHandle, wanted: Option<bool>) {
    let Some(dir) = config_dir(app) else { return };
    let marker = dir.join("autostart-decided");
    if wanted.is_none() && marker.exists() {
        return;
    }
    let on = wanted.unwrap_or(true);
    let launcher = app.autolaunch();
    let _ = if on { launcher.enable() } else { launcher.disable() };
    let _ = fs::write(marker, if on { "on" } else { "off" });
}

/* ---------------------------------------------------------------- the host */

#[derive(Default)]
struct Host {
    child: Mutex<Option<CommandChild>>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
    next_id: AtomicU64,
    /// Set on Quit: a host that exits then is not restarted.
    quitting: AtomicBool,
    /// Why the host isn't running, when it chose not to (another host holds the lock).
    blocked: Mutex<Option<String>>,
}

/// Start the host for the saved server, unless one is running already.
fn start_host(app: &AppHandle) {
    let Some(server) = stored_url(app) else { return };
    let state = app.state::<Host>();
    if state.child.lock().unwrap().is_some() {
        return;
    }
    let client = match app.path().resolve("fabrikka.mjs", BaseDirectory::Resource) {
        Ok(p) => p,
        Err(e) => {
            let why = format!("the bundled client is missing: {e}");
            eprintln!("[fabrikka app] {why}");
            *state.blocked.lock().unwrap() = Some(why);
            return;
        }
    };
    let spawned = app.shell().sidecar("node").and_then(|cmd| {
        cmd.args([client.to_string_lossy().as_ref(), "host", "--server", &server, "--control", "stdio"])
            .spawn()
    });
    let (mut events, child) = match spawned {
        Ok(pair) => pair,
        Err(e) => {
            let why = format!("couldn't start the host: {e}");
            eprintln!("[fabrikka app] {why}");
            *state.blocked.lock().unwrap() = Some(why);
            return;
        }
    };
    eprintln!("[fabrikka app] host started for {server}");
    *state.child.lock().unwrap() = Some(child);
    *state.blocked.lock().unwrap() = None;

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut buffer: Vec<u8> = Vec::new();
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => {
                    buffer.extend_from_slice(&bytes);
                    if !buffer.ends_with(b"\n") {
                        buffer.push(b'\n');
                    }
                    while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = buffer.drain(..=end).collect();
                        if let Ok(message) = serde_json::from_slice::<Value>(&line) {
                            on_host_message(&app, message);
                        }
                    }
                }
                // The host's own log: kept on stderr, never mixed into the protocol.
                CommandEvent::Stderr(bytes) => eprint!("{}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Terminated(status) => {
                    eprintln!("[fabrikka app] host exited (code {:?}, signal {:?})", status.code, status.signal);
                    let state = app.state::<Host>();
                    state.child.lock().unwrap().take();
                    state.pending.lock().unwrap().clear();
                    if status.code == Some(3) {
                        // The lock: another host (a terminal one) is running. Don't fight it.
                        *state.blocked.lock().unwrap() =
                            Some("another Fabrikka host is running on this computer".into());
                    } else if !state.quitting.load(Ordering::SeqCst) {
                        tokio::time::sleep(Duration::from_secs(2)).await;
                        start_host(&app);
                    }
                    break;
                }
                _ => {}
            }
        }
    });
}

fn on_host_message(app: &AppHandle, message: Value) {
    // Pairing: open the page in the main window, where the person is signed in.
    if message.get("event").and_then(Value::as_str) == Some("pair") {
        if let Some(url) = message.get("url").and_then(Value::as_str) {
            let _ = show_main(app, Some(url));
        }
        return;
    }
    if let Some(id) = message.get("id").and_then(Value::as_u64) {
        if let Some(reply) = app.state::<Host>().pending.lock().unwrap().remove(&id) {
            let _ = reply.send(message);
        }
    }
}

/// One request to the host, one reply. Errors are plain sentences for the page.
async fn ask(app: &AppHandle, mut request: Value) -> Result<Value, String> {
    let state = app.state::<Host>();
    if let Some(why) = state.blocked.lock().unwrap().clone() {
        return Err(why);
    }
    let id = state.next_id.fetch_add(1, Ordering::SeqCst) + 1;
    request["id"] = json!(id);
    let (tx, rx) = oneshot::channel();
    state.pending.lock().unwrap().insert(id, tx);
    {
        let mut child = state.child.lock().unwrap();
        let Some(child) = child.as_mut() else {
            state.pending.lock().unwrap().remove(&id);
            return Err("the host is starting — try again in a moment".into());
        };
        let mut line = request.to_string();
        line.push('\n');
        child.write(line.as_bytes()).map_err(|e| e.to_string())?;
    }
    let reply = tokio::time::timeout(Duration::from_secs(10), rx)
        .await
        .map_err(|_| "the host didn't answer".to_string())?
        .map_err(|_| "the host stopped".to_string())?;
    if reply.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(reply)
    } else {
        Err(reply.get("error").and_then(Value::as_str).unwrap_or("refused").to_string())
    }
}

/* ---------------------------------------------- commands: Folders window only */

#[tauri::command]
async fn host_state(app: AppHandle) -> Result<Value, String> {
    Ok(ask(&app, json!({ "op": "state" })).await?["state"].take())
}

/// The path comes from the native picker, here in Rust — never from a page.
#[tauri::command]
async fn host_add_folder(app: AppHandle, policy: String) -> Result<Value, String> {
    let picked = app.dialog().file().set_title("Choose a folder your agents may work in").blocking_pick_folder();
    let Some(picked) = picked else { return Ok(json!({ "cancelled": true })) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    ask(&app, json!({ "op": "grant", "path": path.to_string_lossy(), "policy": policy })).await
}

#[tauri::command]
async fn host_policy(app: AppHandle, grant_id: String, policy: String) -> Result<Value, String> {
    ask(&app, json!({ "op": "policy", "grantId": grant_id, "policy": policy })).await
}

#[tauri::command]
async fn host_remove(app: AppHandle, grant_id: String) -> Result<Value, String> {
    ask(&app, json!({ "op": "remove", "grantId": grant_id })).await
}

#[tauri::command]
async fn host_stop(app: AppHandle) -> Result<Value, String> {
    ask(&app, json!({ "op": "stop" })).await
}

/* ---------------------------------------------- commands: first-run page only */

/// Save the server and open it; start the host for it. Called once, from the first-run page.
#[tauri::command]
fn connect(app: AppHandle, url: String, start_at_login: Option<bool>) -> Result<(), String> {
    let parsed = parse_server(&url)?;
    if let Some(dir) = config_dir(&app) {
        fs::write(dir.join("server-url"), parsed.as_str()).map_err(|e| e.to_string())?;
    }
    settle_autostart(&app, Some(start_at_login.unwrap_or(true)));
    show_main(&app, None).map_err(|e| e.to_string())?;
    start_host(&app);
    Ok(())
}

/// Forget the saved server, so the next launch asks again.
#[tauri::command]
fn forget(app: AppHandle) -> Result<(), String> {
    if let Some(dir) = config_dir(&app) {
        let _ = fs::remove_file(dir.join("server-url"));
    }
    Ok(())
}

/* ----------------------------------------------------------------- windows */

/// Show the main window: the instance (or `at`, a page on it), or the first-run page.
fn show_main(app: &AppHandle, at: Option<&str>) -> tauri::Result<()> {
    let target = match at {
        Some(url) => parse_server(url).ok(),
        None => stored_url(app).and_then(|url| parse_server(&url).ok()),
    };
    if let Some(window) = app.get_webview_window("main") {
        if let (Some(url), Some(_)) = (&target, at) {
            let _ = window.navigate(url.clone());
        }
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }
    let (url, size, resizable) = match target {
        Some(url) => (WebviewUrl::External(url), (1200.0, 800.0), true),
        None => (WebviewUrl::App("index.html".into()), (520.0, 460.0), false),
    };
    WebviewWindowBuilder::new(app, "main", url)
        .title("Fabrikka")
        .inner_size(size.0, size.1)
        .min_inner_size(480.0, 420.0)
        .resizable(resizable)
        .build()?;
    Ok(())
}

fn show_folders(app: &AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window("folders") {
        window.show()?;
        return window.set_focus();
    }
    WebviewWindowBuilder::new(app, "folders", WebviewUrl::App("folders.html".into()))
        .title("Fabrikka — folders")
        .inner_size(640.0, 620.0)
        .min_inner_size(480.0, 400.0)
        .build()?;
    Ok(())
}

/* -------------------------------------------------------------------- tray */

fn build_tray(app: &AppHandle) -> tauri::Result<MenuItem<Wry>> {
    let status = MenuItem::with_id(app, "status", "Starting…", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Open Fabrikka", true, None::<&str>)?;
    let folders = MenuItem::with_id(app, "folders", "Folders…", true, None::<&str>)?;
    let stop = MenuItem::with_id(app, "stop", "Stop all runs", true, None::<&str>)?;
    let login_on = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(app, "login", "Start at login", true, login_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Fabrikka", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &status,
            &PredefinedMenuItem::separator(app)?,
            &open,
            &folders,
            &stop,
            &PredefinedMenuItem::separator(app)?,
            &login,
            &quit,
        ],
    )?;

    let login_item = login.clone();
    let mut tray = TrayIconBuilder::with_id("main")
        .menu(&menu)
        .tooltip("Fabrikka")
        .show_menu_on_left_click(true)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open" => {
                let _ = show_main(app, None);
            }
            "folders" => {
                let _ = show_folders(app);
            }
            "stop" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = ask(&app, json!({ "op": "stop" })).await;
                });
            }
            "login" => {
                let on = !app.autolaunch().is_enabled().unwrap_or(false);
                settle_autostart(app, Some(on));
                let _ = login_item.set_checked(on);
            }
            "quit" => {
                app.state::<Host>().quitting.store(true, Ordering::SeqCst);
                if let Some(child) = app.state::<Host>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
                app.exit(0);
            }
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(status)
}

/// Keep the tray's first line true: connected or not, and what's running.
fn watch_status(app: AppHandle, status: MenuItem<Wry>) {
    tauri::async_runtime::spawn(async move {
        loop {
            let text = if stored_url(&app).is_none() {
                "Not set up yet".to_string()
            } else {
                match ask(&app, json!({ "op": "state" })).await {
                    Ok(reply) => {
                        let s = &reply["state"];
                        let running = s["agents"].as_array().map(|a| a.iter().filter(|x| x["running"] == true).count()).unwrap_or(0);
                        let server = s["server"].as_str().unwrap_or("");
                        match (s["connected"].as_bool().unwrap_or(false), running) {
                            (false, _) => "Connecting…".to_string(),
                            (true, 0) => format!("Connected to {}", server.trim_start_matches("https://").trim_start_matches("http://")),
                            (true, n) => format!("Running {n} agent{}", if n == 1 { "" } else { "s" }),
                        }
                    }
                    Err(why) => why,
                }
            };
            let _ = status.set_text(&text);
            if let Some(tray) = app.tray_by_id("main") {
                let _ = tray.set_tooltip(Some(format!("Fabrikka — {text}")));
            }
            tokio::time::sleep(Duration::from_secs(3)).await;
        }
    });
}

/* -------------------------------------------------------------------- main */

fn main() {
    tauri::Builder::default()
        // First: a second launch focuses this one instead of starting a second host.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let _ = show_main(app, None);
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, None))
        .manage(Host::default())
        .invoke_handler(tauri::generate_handler![
            connect,
            forget,
            host_state,
            host_add_folder,
            host_policy,
            host_remove,
            host_stop
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            show_main(&handle, None)?;
            if stored_url(&handle).is_some() {
                // The installer may have chosen the server: settle start-at-login now.
                settle_autostart(&handle, None);
                start_host(&handle);
            }
            let status = build_tray(&handle)?;
            watch_status(handle, status);
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Fabrikka")
        .run(|app, event| match event {
            // Closing the windows keeps the app — and your agents — in the tray.
            // Only Quit (an explicit exit code) ends it.
            RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            RunEvent::Exit => {
                app.state::<Host>().quitting.store(true, Ordering::SeqCst);
                if let Some(child) = app.state::<Host>().child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
            _ => {}
        });
}

#[cfg(test)]
mod tests {
    use super::parse_server;

    #[test]
    fn rejects_non_http_schemes() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "ftp://x"] {
            assert!(parse_server(bad).is_err());
        }
        assert!(parse_server("https://app.example.com").is_ok());
    }
}
