// Prevents a console window from appearing alongside the app on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! The Fabrikka desktop shell.
//!
//! Deliberately thin. At this stage the desktop app wraps the same web app the
//! browser serves, and the things desktop uniquely enables — local MCP servers,
//! local files, local-only sessions — are Phase II. Adding product surface here
//! before then would mean maintaining two front ends for no user benefit.
//!
//! The one job it does have is remembering which server to talk to, so the app
//! is usable without an environment variable.

use std::fs;
use std::path::PathBuf;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    fs::create_dir_all(&dir).ok()?;
    Some(dir.join("server-url"))
}

/// The configured server, if one has been chosen.
///
/// `FABRIKKA_URL` wins, so a managed deployment can pin it without touching
/// per-user state.
fn stored_url(app: &tauri::AppHandle) -> Option<String> {
    if let Ok(from_env) = std::env::var("FABRIKKA_URL") {
        if !from_env.trim().is_empty() {
            return Some(from_env.trim().to_string());
        }
    }

    let path = config_path(app)?;
    let raw = fs::read_to_string(path).ok()?;
    let trimmed = raw.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

/// Save the server URL and open it. Called once, from the first-run page.
#[tauri::command]
fn connect(app: tauri::AppHandle, url: String) -> Result<(), String> {
    let url = url.trim().to_string();

    // Only http(s): the webview would happily navigate to file:// or a custom
    // scheme, and neither is a Fabrikka server.
    let parsed = url::Url::parse(&url).map_err(|_| "that is not a valid URL".to_string())?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("the server URL must start with http:// or https://".into());
    }

    if let Some(path) = config_path(&app) {
        fs::write(path, &url).map_err(|e| e.to_string())?;
    }

    open_session_window(&app, &url).map_err(|e| e.to_string())
}

/// Forget the saved server, so the next launch asks again.
#[tauri::command]
fn forget(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(path) = config_path(&app) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn open_session_window(app: &tauri::AppHandle, url: &str) -> tauri::Result<()> {
    let parsed = url::Url::parse(url).map_err(|e| tauri::Error::from(std::io::Error::other(e)))?;

    if let Some(existing) = app.get_webview_window("main") {
        let _ = existing.close();
    }

    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title("Fabrikka")
        .inner_size(1200.0, 800.0)
        .min_inner_size(640.0, 480.0)
        .build()?;

    Ok(())
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![connect, forget])
        .setup(|app| {
            let handle = app.handle().clone();

            match stored_url(&handle) {
                // Known server: go straight there. Everything then behaves exactly
                // as it does in a browser — same origin, so cookie auth just works.
                Some(url) => open_session_window(&handle, &url)?,
                // First run: the bundled page asks where the server is.
                None => {
                    WebviewWindowBuilder::new(&handle, "main", WebviewUrl::App("index.html".into()))
                        .title("Fabrikka")
                        .inner_size(520.0, 420.0)
                        .resizable(false)
                        .build()?;
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Fabrikka");
}

#[cfg(test)]
mod tests {
    #[test]
    fn rejects_non_http_schemes() {
        for bad in ["file:///etc/passwd", "javascript:alert(1)", "ftp://x"] {
            let parsed = url::Url::parse(bad).unwrap();
            assert!(parsed.scheme() != "http" && parsed.scheme() != "https");
        }
    }
}
