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
use std::sync::{Mutex, OnceLock};
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
/**
 * The PATH the host searches for agent tools (docs/operations.md, "Finding your
 * agent tools"). Opened from the Dock, the app gets only the system's PATH, so
 * ask the login shell for the one a terminal would have, once, and add the
 * usual install folders in case it doesn't answer in time. Finding, never
 * installing: the agent's runtime stays the person's.
 */
fn tool_path() -> &'static str {
    static PATH: OnceLock<String> = OnceLock::new();
    PATH.get_or_init(|| {
        let mut dirs: Vec<String> = Vec::new();
        let mut add = |list: &str| {
            for d in list.split(':').map(str::trim).filter(|d| !d.is_empty()) {
                if !dirs.iter().any(|x| x == d) {
                    dirs.push(d.to_string());
                }
            }
        };
        if let Some(p) = login_shell_path() {
            add(&p);
        }
        add(&std::env::var("PATH").unwrap_or_default());
        if let Ok(home) = std::env::var("HOME") {
            add(&format!("{home}/.local/bin"));
        }
        add("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin");
        dirs.join(":")
    })
}

/// `$SHELL -l -c 'printf %s "$PATH"'`, given 3 seconds; None on any failure.
fn login_shell_path() -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let shell = std::env::var("SHELL").ok().filter(|s| s.starts_with('/'))?;
    // Markers, so whatever a profile prints around it is ignored.
    let mut child = Command::new(shell)
        .args(["-l", "-c", "printf '__FABRIKKA_PATH__%s__FABRIKKA_PATH__' \"$PATH\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let started = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if started.elapsed() < Duration::from_secs(3) => std::thread::sleep(Duration::from_millis(25)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let path = out.split("__FABRIKKA_PATH__").nth(1)?.trim().to_string();
    (!path.is_empty()).then_some(path)
}

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
            .env("PATH", tool_path())
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
async fn host_add_folder(app: AppHandle, policy: String, org: Option<String>) -> Result<Value, String> {
    let picked = app.dialog().file().set_title("Choose a folder your agents may work in").blocking_pick_folder();
    let Some(picked) = picked else { return Ok(json!({ "cancelled": true })) };
    let path = picked.into_path().map_err(|e| e.to_string())?;
    // ADR 0043: which organization's rooms may use it; the host checks it's one of yours.
    ask(&app, json!({ "op": "grant", "path": path.to_string_lossy(), "policy": policy, "org": org })).await
}

#[tauri::command]
async fn host_policy(app: AppHandle, grant_id: String, policy: String) -> Result<Value, String> {
    ask(&app, json!({ "op": "policy", "grantId": grant_id, "policy": policy })).await
}

#[tauri::command]
async fn host_remove(app: AppHandle, grant_id: String) -> Result<Value, String> {
    ask(&app, json!({ "op": "remove", "grantId": grant_id })).await
}

/// M37: offer, or stop offering, an agent tool on this computer.
#[tauri::command]
async fn host_set_tool(app: AppHandle, tool: String, enabled: bool) -> Result<Value, String> {
    ask(&app, json!({ "op": "tool", "tool": tool, "enabled": enabled })).await
}

#[tauri::command]
async fn host_stop(app: AppHandle) -> Result<Value, String> {
    ask(&app, json!({ "op": "stop" })).await
}

/* ------------------------------------- command: the instance's own pages, only */

/// Open the Folders window. The ONE command the remote web app may call (its
/// "Add folders…" button): no argument, so it can't name a path or a policy —
/// the person chooses in the app's own window (ADR 0031).
#[tauri::command]
fn open_folders(app: AppHandle) -> Result<(), String> {
    show_folders(&app).map_err(|e| e.to_string())
}

/// Grant `open_folders`, and nothing else, to pages from the configured instance
/// — its exact origin, never any other site the window might reach.
fn let_instance_open_folders(app: &AppHandle, server: &url::Url) {
    let origin = server.origin().ascii_serialization();
    let capability = tauri::ipc::CapabilityBuilder::new("instance-opens-folders")
        .remote(format!("{origin}/*"))
        .window("main")
        .permission("allow-open-folders")
        // M42 (ADR 0037): notifications and the badge, each limited in Rust.
        .permission("allow-notify")
        .permission("allow-set-attention")
        // M49 (ADR 0045): a room's output in a window of its own, a path on the instance.
        .permission("allow-open-output");
    if let Err(e) = app.add_capability(capability) {
        eprintln!("[fabrikka app] couldn't let {origin} open the Folders window: {e}");
    }
}

/// A room's output in a window of its own (M49, ADR 0045). `path` must be on
/// the instance and shaped `/o/<owner>/s/<session>/output`; it is joined to the
/// configured server, never taken as a URL. One window per output.
#[tauri::command]
fn open_output(app: AppHandle, path: String) -> Result<(), String> {
    let path = instance_path(&path).ok_or("only a page on the instance")?;
    if !is_output_path(path) {
        return Err("only a room's output".into());
    }
    let server = stored_url(&app)
        .and_then(|u| parse_server(&u).ok())
        .ok_or("no instance configured")?;
    let url = server.join(path).map_err(|e| e.to_string())?;
    if url.origin() != server.origin() {
        return Err("only a page on the instance".into());
    }
    // One window per room's output; a document asked for (`?doc=`) is opened in it.
    let bare = path.split('?').next().unwrap_or(path);
    let label: String = format!(
        "output-{}",
        bare.trim_matches('/').chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect::<String>()
    );
    if let Some(window) = app.get_webview_window(&label) {
        if path.contains('?') {
            let _ = window.navigate(url);
        }
        let _ = window.show();
        return window.set_focus().map_err(|e| e.to_string());
    }
    instance_window(&app, &label, "Fabrikka — output", WebviewUrl::External(url), (980.0, 800.0), true)
        .map_err(|e| e.to_string())
}

/// `/o/<owner>/s/<session>/output`, with at most `?doc=<id>`, and nothing else.
fn is_output_path(path: &str) -> bool {
    let (path, query) = match path.split_once('?') {
        Some((p, q)) => (p, Some(q)),
        None => (path, None),
    };
    let segs: Vec<&str> = path.trim_end_matches('/').split('/').collect();
    let shape = segs.len() == 6
        && segs[0].is_empty()
        && segs[1] == "o"
        && segs[3] == "s"
        && segs[5] == "output"
        && !segs[2].is_empty()
        && !segs[4].is_empty();
    let query_ok = match query {
        None => true,
        Some(q) => q.strip_prefix("doc=").is_some_and(|id| {
            !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        }),
    };
    shape && query_ok
}

/* ------------------------------ commands: the instance's pages — needs you (M42) */

/// What the remote page may say in a notification, and how often (ADR 0037).
const NOTE_TITLE_MAX: usize = 120;
const NOTE_BODY_MAX: usize = 200;
const NOTE_PER_ROOM: Duration = Duration::from_secs(10);
const NOTE_PER_MINUTE: usize = 30;
/// A notification clicked within this long brings the app forward on its room.
const NOTE_CLICK_WINDOW: Duration = Duration::from_secs(30);

#[derive(Default)]
struct Notices {
    last_per_room: HashMap<String, std::time::Instant>,
    recent: std::collections::VecDeque<std::time::Instant>,
    /// The last room notified, so focusing the app from its notification opens it.
    pending: Option<(String, std::time::Instant)>,
}

#[derive(Default)]
struct Attention(Mutex<Notices>);

/// Only a path on the instance: starts with one `/`, no scheme, no host, no `..`.
fn instance_path(path: &str) -> Option<&str> {
    let ok = path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains('\\')
        && !path.contains("://")
        && !path.split('/').any(|seg| seg == "..")
        && path.len() <= 300;
    ok.then_some(path)
}

fn clip(text: &str, max: usize) -> String {
    let flat: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    if flat.chars().count() <= max {
        flat
    } else {
        flat.chars().take(max - 1).collect::<String>() + "…"
    }
}

/// Whether one more notification for `room` is allowed now; records it if so.
fn allow_notice(n: &mut Notices, room: &str, now: std::time::Instant) -> bool {
    while n.recent.front().is_some_and(|t| now.duration_since(*t) > Duration::from_secs(60)) {
        n.recent.pop_front();
    }
    if n.recent.len() >= NOTE_PER_MINUTE {
        return false;
    }
    if n.last_per_room.get(room).is_some_and(|t| now.duration_since(*t) < NOTE_PER_ROOM) {
        return false;
    }
    n.recent.push_back(now);
    n.last_per_room.insert(room.to_string(), now);
    true
}

/// A system notification for something that needs you. Text is capped, the
/// rate is limited, and its room must be a path on the instance (ADR 0037).
#[tauri::command]
fn notify(app: AppHandle, title: String, body: String, path: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    let path = instance_path(&path).ok_or("a notification can only open a page on the instance")?.to_string();
    let state = app.state::<Attention>();
    let mut n = state.0.lock().unwrap();
    let now = std::time::Instant::now();
    if !allow_notice(&mut n, &path, now) {
        return Ok(()); // quietly dropped: too many, too fast
    }
    n.pending = Some((path, now));
    drop(n);
    app.notification()
        .builder()
        .title(clip(&title, NOTE_TITLE_MAX))
        .body(clip(&body, NOTE_BODY_MAX))
        .show()
        .map_err(|e| e.to_string())
}

/// The total that needs you: the dock badge, and a dot beside the tray icon.
#[tauri::command]
fn set_attention(app: AppHandle, total: i64) -> Result<(), String> {
    let total = total.clamp(0, 999);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_badge_count(if total > 0 { Some(total) } else { None });
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_title(if total > 0 { Some("●") } else { None::<&str> });
    }
    Ok(())
}

/// Clicking a notification activates the app. If one was shown moments ago,
/// open its room in the main window: the click's destination.
fn open_pending_room(app: &AppHandle) {
    let pending = app.state::<Attention>().0.lock().unwrap().pending.take();
    let Some((path, at)) = pending else { return };
    if at.elapsed() > NOTE_CLICK_WINDOW {
        return;
    }
    let server = stored_url(app).and_then(|u| parse_server(&u).ok());
    if let (Some(server), Some(window)) = (server, app.get_webview_window("main")) {
        if let Ok(url) = server.join(&path) {
            if url.origin() == server.origin() {
                let _ = window.navigate(url);
            }
        }
    }
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
    let_instance_open_folders(&app, &parsed);
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
    instance_window(app, "main", "Fabrikka", url, size, resizable)
}

/// A window showing the instance (or the app's own page), with the rules every
/// such window follows: other sites leave for the browser, and the vendor
/// sign-in handoff does too (ADR 0033).
fn instance_window(
    app: &AppHandle,
    label: &str,
    title: &str,
    url: WebviewUrl,
    size: (f64, f64),
    resizable: bool,
) -> tauri::Result<()> {
    let opener = app.clone();
    let handoff_opener = app.clone();
    let builder = WebviewWindowBuilder::new(app, label, url)
        .title(title)
        .inner_size(size.0, size.1)
        .min_inner_size(480.0, 420.0)
        .resizable(resizable)
        // A link to another site (the web app makes every such click a
        // new-window request) opens in the default browser, never in here.
        .on_new_window(move |url, _features| {
            if opens_in_browser(&url) {
                #[allow(deprecated)] // the shell plugin's `open`; no scope applies from Rust
                if let Err(e) = opener.shell().open(url.as_str(), None) {
                    eprintln!("[fabrikka app] couldn't open {url} in the browser: {e}");
                }
            }
            tauri::webview::NewWindowResponse::Deny
        })
        // Connecting a vendor: the instance's handoff link opens in the default
        // browser, where the sign-in happens (ADR 0033). One fixed path on the
        // configured origin, so the remote page gets nothing it could name.
        .on_navigation(move |url| {
            let server = stored_url(&handoff_opener).and_then(|u| parse_server(&u).ok());
            if !server.is_some_and(|s| is_handoff(url, &s)) {
                return true;
            }
            #[allow(deprecated)]
            if let Err(e) = handoff_opener.shell().open(url.as_str(), None) {
                eprintln!("[fabrikka app] couldn't open the sign-in in the browser: {e}");
            }
            false
        });
    // macOS: every window of the app shares one tabbing identifier, so a room's
    // output opens as a native tab of the main window, not a loose window (ADR
    // 0045). Other platforms have no such thing; there it stays a window.
    #[cfg(target_os = "macos")]
    let builder = builder.tabbing_identifier("fabrikka");
    builder.build()?;
    Ok(())
}

/// The instance's handoff page (ADR 0033), and only on the instance itself.
fn is_handoff(url: &url::Url, server: &url::Url) -> bool {
    url.origin() == server.origin() && url.path() == "/api/connections/oauth/handoff"
}

/// Only web pages go to the browser: a page could ask for `file://` or an app's
/// custom scheme, and the system would happily open those too.
fn opens_in_browser(url: &url::Url) -> bool {
    url.scheme() == "http" || url.scheme() == "https"
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
    // The bare mark, as a template image: macOS tints it to match the menu bar.
    if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
        tray = tray.icon(icon).icon_as_template(true);
    } else if let Some(icon) = app.default_window_icon() {
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
        .plugin(tauri_plugin_notification::init())
        .manage(Host::default())
        .manage(Attention::default())
        // M42: the app coming forward right after a notification opens its room.
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Focused(true)) {
                open_pending_room(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            forget,
            host_state,
            host_add_folder,
            host_policy,
            host_remove,
            host_stop,
            host_set_tool,
            open_folders,
            open_output,
            notify,
            set_attention
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            if let Some(server) = stored_url(&handle).and_then(|u| parse_server(&u).ok()) {
                let_instance_open_folders(&handle, &server);
            }
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
    use super::{allow_notice, clip, instance_path, is_handoff, opens_in_browser, parse_server, Notices};

    #[test]
    fn a_notification_opens_only_the_instance() {
        assert_eq!(instance_path("/o/fede/s/abc"), Some("/o/fede/s/abc"));
        for bad in ["https://evil.example/x", "//evil.example/x", "o/fede", "/o/../../etc", "/a\\b", "javascript:alert(1)"] {
            assert_eq!(instance_path(bad), None, "{bad}");
        }
    }

    #[test]
    fn notifications_are_rate_limited() {
        let mut n = Notices::default();
        let t = std::time::Instant::now();
        assert!(allow_notice(&mut n, "/o/a/s/1", t));
        assert!(!allow_notice(&mut n, "/o/a/s/1", t), "same room within 10 s");
        let mut allowed = 1;
        for i in 0..40 {
            if allow_notice(&mut n, &format!("/o/a/s/r{i}"), t) {
                allowed += 1;
            }
        }
        assert_eq!(allowed, 30, "30 a minute in all");
    }

    #[test]
    fn notification_text_is_capped_and_flat() {
        assert_eq!(clip("a\nb", 10), "a b");
        assert_eq!(clip(&"x".repeat(300), 120).chars().count(), 120);
    }

    #[test]
    fn rejects_non_http_schemes() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "ftp://x"] {
            assert!(parse_server(bad).is_err());
        }
        assert!(parse_server("https://app.example.com").is_ok());
    }

    #[test]
    fn only_the_instances_own_handoff_leaves_the_window() {
        let server = url::Url::parse("https://app.example.com").unwrap();
        let at = |s: &str| is_handoff(&url::Url::parse(s).unwrap(), &server);
        assert!(at("https://app.example.com/api/connections/oauth/handoff?t=abc"));
        assert!(!at("https://evil.example/api/connections/oauth/handoff?t=abc"));
        assert!(!at("http://app.example.com/api/connections/oauth/handoff?t=abc"));
        assert!(!at("https://app.example.com/integrations"));
    }

    #[test]
    fn only_web_pages_open_in_the_browser() {
        for good in ["https://github.com/x/y/pull/1", "http://localhost:3000/"] {
            assert!(opens_in_browser(&url::Url::parse(good).unwrap()));
        }
        for bad in ["file:///etc/passwd", "vscode://open", "mailto:a@b.c"] {
            assert!(!opens_in_browser(&url::Url::parse(bad).unwrap()));
        }
    }
}
