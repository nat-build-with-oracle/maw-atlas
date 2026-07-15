// Backfill Tauri — cookbook technique: web UI + Tauri native shell (the exact
// Bifröst pattern Nat pointed at). The webview loads the SAME panel the browser
// shows (localhost:47710); the shell spawns the bun server when it's down and
// leaves servers it merely attached to untouched.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const REPO: &str = "/opt/Code/github.com/Soul-Brews-Studio/atlas-discord-backfill-oracle";
const PANEL: &str = "http://localhost:47710/";

struct SpawnedServer(Mutex<Option<Child>>);

fn server_up() -> bool {
    ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(1))
        .build()
        .get("http://localhost:47710/api/stats")
        .call()
        .is_ok()
}

fn spawn_server() -> Option<Child> {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = format!(
        "/opt/homebrew/bin:{}/.bun/bin:{}",
        home,
        std::env::var("PATH").unwrap_or_default()
    );
    Command::new("/usr/bin/env")
        .args(["bun", &format!("{REPO}/app/server.ts")])
        .env("PATH", path)
        .env("BACKFILL_SPAWNED_BY_APP", "1") // server self-exits if we vanish
        .spawn()
        .ok()
}

fn main() {
    tauri::Builder::default()
        .manage(SpawnedServer(Mutex::new(None)))
        .setup(|app| {
            if !server_up() {
                let child = spawn_server();
                *app.state::<SpawnedServer>().0.lock().unwrap() = child;
                for _ in 0..40 {
                    if server_up() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(500));
                }
            }
            WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::External(PANEL.parse().unwrap()),
            )
            .title("Backfill Tauri 🌊📜")
            .inner_size(1180.0, 800.0)
            .min_inner_size(900.0, 600.0)
            .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                // kill only a server WE spawned; attached servers stay up
                if let Some(mut c) = window
                    .app_handle()
                    .state::<SpawnedServer>()
                    .0
                    .lock()
                    .unwrap()
                    .take()
                {
                    let _ = c.kill();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running Backfill Tauri");
}
