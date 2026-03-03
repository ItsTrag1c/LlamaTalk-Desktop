use base64::{engine::general_purpose, Engine as _};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

struct AssistantMenuState {
    item: Arc<Mutex<CheckMenuItem<tauri::Wry>>>,
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file_text(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file_base64(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(general_purpose::STANDARD.encode(&bytes))
}

fn validate_ollama_url(url_str: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url_str)
        .map_err(|_| format!("Invalid URL: {}", url_str))?;
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("Only http and https URLs are allowed, got: {}", s)),
    }
    if let Some(host) = parsed.host_str() {
        // Reject link-local addresses (used by cloud metadata endpoints, e.g. 169.254.169.254)
        if host.starts_with("169.254.") {
            return Err("Link-local IP addresses are not allowed.".to_string());
        }
    }
    Ok(())
}

#[tauri::command]
async fn ollama_get(url: String) -> Result<String, String> {
    validate_ollama_url(&url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn ollama_post(url: String, body: String) -> Result<String, String> {
    validate_ollama_url(&url)?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("HTTP {}", res.status()));
    }
    res.text().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn external_api_post(
    url: String,
    headers: String,
    body: String,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs.unwrap_or(120)))
        .build()
        .map_err(|e| e.to_string())?;
    let pairs: Vec<(String, String)> = serde_json::from_str(&headers)
        .map_err(|e| e.to_string())?;
    let mut req = client.post(&url).body(body);
    for (k, v) in pairs {
        req = req.header(k, v);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(text);
    }
    Ok(text)
}

#[tauri::command]
fn open_bundled_doc(app: tauri::AppHandle, filename: String) -> Result<(), String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    // Tauri places bundled resources in a "resources" subdirectory alongside the exe
    let path = resource_dir.join("resources").join(&filename);
    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }
    // Open with the system default application (Windows shell)
    std::process::Command::new("cmd")
        .args(["/c", "start", "", path.to_str().unwrap_or_default()])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn open_new_window(app: tauri::AppHandle) -> Result<(), String> {
    let label = format!("llamachat-{}", std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis());
    tauri::WebviewWindowBuilder::new(
        &app,
        label,
        tauri::WebviewUrl::App("/".into()),
    )
    .title("LlamaTalk Desktop")
    .inner_size(1100.0, 740.0)
    .min_inner_size(720.0, 500.0)
    .center()
    .decorations(false)
    .skip_taskbar(false)
    .build()
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_documents_dir(app: tauri::AppHandle) -> Result<String, String> {
    app.path().document_dir()
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn exit_app() {
    std::process::exit(0);
}

#[tauri::command]
fn window_count(app: tauri::AppHandle) -> usize {
    app.webview_windows().len()
}

#[tauri::command]
fn show_assistant_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("llama-assistant") {
        w.show().map_err(|e| e.to_string())?;
        w.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn hide_assistant_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("llama-assistant") {
        w.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn set_assistant_checked(
    state: tauri::State<AssistantMenuState>,
    checked: bool,
) -> Result<(), String> {
    state.item.lock().unwrap().set_checked(checked).map_err(|e| e.to_string())
}

fn parse_semver(s: &str) -> Option<[u32; 3]> {
    let parts: Vec<&str> = s.split('.').collect();
    if parts.len() != 3 { return None; }
    let major = parts[0].parse::<u32>().ok()?;
    let minor = parts[1].parse::<u32>().ok()?;
    let patch = parts[2].parse::<u32>().ok()?;
    Some([major, minor, patch])
}

#[tauri::command]
fn check_for_update(current_version: String) -> Result<Option<String>, String> {
    // Scan the EXE's own directory for a pre-placed versioned installer
    let exe_path = std::env::current_exe().map_err(|e| e.to_string())?;
    let install_dir = exe_path.parent().ok_or_else(|| "Cannot determine install directory".to_string())?;
    let current = parse_semver(&current_version)
        .ok_or_else(|| "Invalid current version".to_string())?;
    let entries = std::fs::read_dir(install_dir).map_err(|e| e.to_string())?;
    let mut best: Option<([u32; 3], String, String)> = None;
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if let Some(rest) = name.strip_prefix("LlamaTalk Desktop_") {
            if let Some(ver_str) = rest.strip_suffix("_x64-setup.exe") {
                if let Some(ver) = parse_semver(ver_str) {
                    if ver > current {
                        let path = entry.path().to_string_lossy().to_string();
                        if best.is_none() || ver > best.as_ref().unwrap().0 {
                            best = Some((ver, ver_str.to_string(), path));
                        }
                    }
                }
            }
        }
    }
    Ok(best.map(|(_, ver_str, path)| format!("{}|{}", ver_str, path)))
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Sha256, Digest};
    let mut hasher = Sha256::new();
    hasher.update(data);
    hasher.finalize().iter().map(|b| format!("{:02x}", b)).collect()
}

#[tauri::command]
async fn check_for_update_remote(current_version: String) -> Option<String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .ok()?;
    let res = client
        .get("https://api.github.com/repos/ItsTrag1c/LlamaTalk-Desktop/releases/latest")
        .header("User-Agent", "LlamaTalk Desktop")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .ok()?;
    if !res.status().is_success() { return None; }
    let json: serde_json::Value = res.json().await.ok()?;
    let tag = json["tag_name"].as_str()?;
    let version = tag.trim_start_matches('v');
    let found = parse_semver(version)?;
    let current = parse_semver(&current_version)?;
    if found <= current { return None; }
    let assets = json["assets"].as_array()?;
    let installer = assets.iter().find(|a| {
        a["name"].as_str()
            .map(|n| (n.starts_with("LlamaTalk Desktop_") || n.starts_with("LlamaTalk.Desktop_")) && n.ends_with("_x64-setup.exe"))
            .unwrap_or(false)
    })?;
    let installer_url = installer["browser_download_url"].as_str()?;
    let checksum_url = assets.iter()
        .find(|a| a["name"].as_str() == Some("checksums.txt"))
        .and_then(|a| a["browser_download_url"].as_str())
        .unwrap_or("");
    Some(format!("{}|{}|{}", version, installer_url, checksum_url))
}

#[tauri::command]
async fn download_and_install(url: String, version: String, checksum_url: String) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let filename = format!("LlamaTalk Desktop_{}_x64-setup.exe", version);
    let dest = std::env::temp_dir().join(&filename);

    let res = client
        .get(&url)
        .header("User-Agent", "LlamaTalk Desktop")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        return Err(format!("Download failed: HTTP {}", res.status()));
    }
    let bytes = res.bytes().await.map_err(|e| e.to_string())?;

    // Verify checksum when available
    if !checksum_url.is_empty() {
        if let Ok(cs_res) = client
            .get(&checksum_url)
            .header("User-Agent", "LlamaTalk Desktop")
            .send()
            .await
        {
            if cs_res.status().is_success() {
                if let Ok(cs_text) = cs_res.text().await {
                    let actual_hash = sha256_hex(&bytes);
                    let expected = cs_text
                        .lines()
                        .find(|line| line.contains(&filename))
                        .and_then(|line| line.split_whitespace().next())
                        .map(|s| s.to_string());
                    if let Some(expected_hash) = expected {
                        if actual_hash != expected_hash {
                            return Err(
                                "Checksum mismatch — the download may be corrupted. Please try again."
                                    .to_string(),
                            );
                        }
                    }
                }
            }
        }
        // If checksum fetch fails, proceed anyway — TLS already secures the channel
    }

    std::fs::write(&dest, &bytes).map_err(|e| e.to_string())?;
    std::process::Command::new("cmd")
        .args(["/c", "start", "", dest.to_str().unwrap_or_default()])
        .spawn()
        .map_err(|e| e.to_string())?;
    std::process::exit(0);
}

#[tauri::command]
fn launch_installer(path: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    std::process::exit(0);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // A second instance was launched — bring the existing window to front
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            if let Some(icon) = app.default_window_icon().cloned() {
                let assistant_item = CheckMenuItem::with_id(
                    app,
                    "toggle-assistant",
                    "Llama Assistant",
                    true,
                    false,
                    None::<&str>,
                )?;
                let quit_item = MenuItem::with_id(app, "quit", "Quit LlamaTalk Desktop", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&assistant_item, &quit_item])?;

                // Store reference so set_assistant_checked command can update it
                app.manage(AssistantMenuState {
                    item: Arc::new(Mutex::new(assistant_item)),
                });

                TrayIconBuilder::new()
                    .icon(icon)
                    .tooltip("LlamaTalk Desktop")
                    .menu(&menu)
                    .on_menu_event(|app, event| {
                        match event.id.as_ref() {
                            "quit" => std::process::exit(0),
                            "toggle-assistant" => {
                                if let Some(w) = app.get_webview_window("llama-assistant") {
                                    let visible = w.is_visible().unwrap_or(false);
                                    if visible {
                                        let _ = w.hide();
                                    } else {
                                        let _ = w.show();
                                        let _ = w.set_focus();
                                    }
                                    // Sync CheckMenuItem checkmark
                                    if let Some(state) = app.try_state::<AssistantMenuState>() {
                                        let _ = state.item.lock().unwrap().set_checked(!visible);
                                    }
                                    // Sync localStorage and fire synthetic storage event in main window
                                    let val = if !visible { "true" } else { "false" };
                                    if let Some(main) = app.get_webview_window("main") {
                                        let _ = main.eval(&format!(
                                            "localStorage.setItem('showAssistant','{}');window.dispatchEvent(new StorageEvent('storage',{{key:'showAssistant',newValue:'{}'}}));",
                                            val, val
                                        ));
                                    }
                                }
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            if let Some(window) = tray.app_handle().get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .build(app)?;
            }

            // Create assistant window hidden at startup
            tauri::WebviewWindowBuilder::new(
                app,
                "llama-assistant",
                tauri::WebviewUrl::App("/".into()),
            )
            .title("Llama Assistant")
            .inner_size(360.0, 280.0)
            .decorations(false)
            .transparent(true)
            .always_on_top(true)
            .skip_taskbar(true)
            .visible(false)
            .build()
            .map_err(|e| e.to_string())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            write_text_file,
            read_file_text,
            read_file_base64,
            ollama_get,
            ollama_post,
            external_api_post,
            open_bundled_doc,
            open_new_window,
            get_documents_dir,
            exit_app,
            window_count,
            show_assistant_window,
            hide_assistant_window,
            set_assistant_checked,
            check_for_update,
            check_for_update_remote,
            download_and_install,
            launch_installer
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
