use base64::{engine::general_purpose, Engine as _};
use futures_util::StreamExt;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{
    menu::{CheckMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager,
};

struct AssistantMenuState {
    item: Arc<Mutex<CheckMenuItem<tauri::Wry>>>,
}

fn has_path_traversal(path: &str) -> bool {
    std::path::Path::new(path)
        .components()
        .any(|c| c == std::path::Component::ParentDir)
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    if has_path_traversal(&path) { return Err("Path traversal not allowed.".to_string()); }
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file_text(path: String) -> Result<String, String> {
    if has_path_traversal(&path) { return Err("Path traversal not allowed.".to_string()); }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_file_base64(path: String) -> Result<String, String> {
    if has_path_traversal(&path) { return Err("Path traversal not allowed.".to_string()); }
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
    // Reject filenames containing path separators or traversal sequences
    if filename.contains('/') || filename.contains('\\') || filename.contains("..") {
        return Err("Invalid filename.".to_string());
    }
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string())?;
    let base = resource_dir.join("resources");
    let path = base.join(&filename);
    if !path.exists() {
        return Err(format!("File not found: {}", path.display()));
    }
    // Canonicalize both paths and confirm the file is inside the resources dir
    let canonical_path = path.canonicalize().map_err(|e| e.to_string())?;
    let canonical_base = base.canonicalize().map_err(|e| e.to_string())?;
    if !canonical_path.starts_with(&canonical_base) {
        return Err("Path traversal not allowed.".to_string());
    }
    std::process::Command::new("cmd")
        .args(["/c", "start", "", canonical_path.to_str().unwrap_or_default()])
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

const CRED_SERVICE: &str = "LlamaTalk Desktop";

#[tauri::command]
fn cred_store(key: String, value: String) -> Result<(), String> {
    keyring::Entry::new(CRED_SERVICE, &key)
        .map_err(|e| e.to_string())?
        .set_password(&value)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn cred_load(key: String) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(CRED_SERVICE, &key)
        .map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn cred_delete(key: String) -> Result<(), String> {
    let entry = keyring::Entry::new(CRED_SERVICE, &key)
        .map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
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

/// Destroy all WebView windows so the browser process flushes localStorage
/// to disk, then wait briefly before the caller terminates the process.
fn flush_and_exit(app: &tauri::AppHandle) {
    for (_, window) in app.webview_windows() {
        let _ = window.destroy();
    }
    std::thread::sleep(std::time::Duration::from_millis(300));
    std::process::exit(0);
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    flush_and_exit(&app);
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
async fn download_and_install(app: tauri::AppHandle, url: String, version: String, checksum_url: String) -> Result<(), String> {
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
    flush_and_exit(&app);
    Ok(())
}

#[tauri::command]
fn launch_installer(app: tauri::AppHandle, path: String) -> Result<(), String> {
    std::process::Command::new("cmd")
        .args(["/c", "start", "", &path])
        .spawn()
        .map_err(|e| e.to_string())?;
    flush_and_exit(&app);
    Ok(())
}

struct StreamCancellationState {
    flags: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

#[tauri::command]
async fn detect_backend(url: String) -> Result<String, String> {
    validate_ollama_url(&url)?;
    let base = url.trim_end_matches('/');
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;

    // Try Ollama endpoint first — validate body contains a "models" array
    // so llama.cpp servers that return 200 but non-Ollama payloads are not
    // misidentified as native Ollama.
    if let Ok(res) = client.get(format!("{}/api/tags", base)).send().await {
        if res.status().is_success() {
            if let Ok(body) = res.text().await {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(&body) {
                    if v.get("models").and_then(|m| m.as_array()).is_some() {
                        // Looks like genuine Ollama — but also probe /v1/models.
                        // If BOTH respond, prefer openai-compatible when the /api/chat
                        // streaming format is more likely SSE (llama.cpp pattern).
                        // A real Ollama server won't serve /v1/models, so this is safe.
                        if let Ok(oai_res) = client.get(format!("{}/v1/models", base)).send().await {
                            if oai_res.status().is_success() {
                                return Ok("openai-compatible".to_string());
                            }
                        }
                        return Ok("ollama".to_string());
                    }
                }
            }
        }
    }

    // Try OpenAI-compatible endpoint
    if let Ok(res) = client.get(format!("{}/v1/models", base)).send().await {
        if res.status().is_success() {
            return Ok("openai-compatible".to_string());
        }
    }

    Err("Could not detect backend type. Neither Ollama nor OpenAI-compatible API responded.".to_string())
}

#[derive(Clone, serde::Serialize)]
struct ChatTokenPayload {
    id: String,
    token: String,
}

#[derive(Clone, serde::Serialize)]
struct ChatDonePayload {
    id: String,
}

#[derive(Clone, serde::Serialize)]
struct ChatErrorPayload {
    id: String,
    error: String,
}

#[tauri::command]
async fn stream_chat(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, StreamCancellationState>,
    url: String,
    headers: String,
    body: String,
    provider_type: String,
    stream_id: String,
) -> Result<(), String> {
    // Validate URL for local providers
    if provider_type == "ollama" || provider_type == "openai-compatible" {
        validate_ollama_url(&url)?;
    }

    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut flags = state.flags.lock().unwrap();
        flags.insert(stream_id.clone(), cancel_flag.clone());
    }

    let result = stream_chat_inner(&window, &url, &headers, &body, &provider_type, &stream_id, &cancel_flag).await;

    // Cleanup cancellation flag
    {
        let mut flags = state.flags.lock().unwrap();
        flags.remove(&stream_id);
    }

    match result {
        Ok(()) => {
            let _ = window.app_handle().emit("chat-done", ChatDonePayload { id: stream_id });
            Ok(())
        }
        Err(e) => {
            if cancel_flag.load(Ordering::Relaxed) {
                let _ = window.app_handle().emit("chat-done", ChatDonePayload { id: stream_id });
                Ok(())
            } else {
                let _ = window.app_handle().emit("chat-error", ChatErrorPayload { id: stream_id.clone(), error: e.clone() });
                Err(e)
            }
        }
    }
}

async fn stream_chat_inner(
    window: &tauri::WebviewWindow,
    url: &str,
    headers: &str,
    body: &str,
    provider_type: &str,
    stream_id: &str,
    cancel_flag: &Arc<AtomicBool>,
) -> Result<(), String> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;

    let pairs: Vec<(String, String)> = serde_json::from_str(headers)
        .unwrap_or_default();
    let mut req = client.post(url).body(body.to_string());
    for (k, v) in pairs {
        req = req.header(k, v);
    }

    let res = req.send().await.map_err(|e| e.to_string())?;
    if !res.status().is_success() {
        let status = res.status();
        let text = res.text().await.unwrap_or_default();
        return Err(format!("HTTP {} — {}", status, text));
    }

    let mut stream = res.bytes_stream();
    let mut line_buf = String::new();

    while let Some(chunk) = stream.next().await {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err("cancelled".to_string());
        }
        let chunk = chunk.map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&chunk);
        line_buf.push_str(&text);

        // Process complete lines
        while let Some(pos) = line_buf.find('\n') {
            let line = line_buf[..pos].trim().to_string();
            line_buf = line_buf[pos + 1..].to_string();

            if line.is_empty() {
                continue;
            }

            if let Some(token) = extract_token(&line, provider_type) {
                if !token.is_empty() {
                    let _ = window.app_handle().emit("chat-token", ChatTokenPayload {
                        id: stream_id.to_string(),
                        token,
                    });
                }
            }

            // Check for stream end
            if is_stream_done(&line, provider_type) {
                return Ok(());
            }
        }
    }

    Ok(())
}

fn extract_token(line: &str, provider_type: &str) -> Option<String> {
    match provider_type {
        "ollama" => {
            // NDJSON: each line is a JSON object with message.content
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(s) = v["message"]["content"].as_str() {
                    return Some(s.to_string());
                }
            }
            // Fallback: llama.cpp may send SSE format (data: {...}) even on /api/chat
            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" { return None; }
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(s) = v["choices"][0]["delta"]["content"].as_str() {
                        return Some(s.to_string());
                    }
                    // Also try message.content inside SSE wrapper
                    if let Some(s) = v["message"]["content"].as_str() {
                        return Some(s.to_string());
                    }
                }
            }
            None
        }
        "openai-compatible" | "openai" => {
            // SSE: lines start with "data: "
            let data = line.strip_prefix("data: ")?;
            if data == "[DONE]" {
                return None;
            }
            let v: serde_json::Value = serde_json::from_str(data).ok()?;
            v["choices"][0]["delta"]["content"].as_str().map(|s| s.to_string())
        }
        "anthropic" => {
            // SSE format — look for data lines with content_block_delta
            let data = line.strip_prefix("data: ")?;
            let v: serde_json::Value = serde_json::from_str(data).ok()?;
            if v["type"].as_str() == Some("content_block_delta") {
                v["delta"]["text"].as_str().map(|s| s.to_string())
            } else {
                None
            }
        }
        "google" => {
            // SSE: data lines with candidates
            let data = line.strip_prefix("data: ")?;
            let v: serde_json::Value = serde_json::from_str(data).ok()?;
            v["candidates"][0]["content"]["parts"][0]["text"].as_str().map(|s| s.to_string())
        }
        _ => None,
    }
}

fn is_stream_done(line: &str, provider_type: &str) -> bool {
    match provider_type {
        "ollama" => {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if v["done"].as_bool() == Some(true) {
                    return true;
                }
            }
            // Fallback: llama.cpp may send SSE-style [DONE] even on /api/chat
            if let Some(data) = line.strip_prefix("data: ") {
                return data == "[DONE]";
            }
            false
        }
        "openai-compatible" | "openai" => {
            line.strip_prefix("data: ").map(|d| d == "[DONE]").unwrap_or(false)
        }
        "anthropic" => {
            if let Some(data) = line.strip_prefix("data: ") {
                if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                    v["type"].as_str() == Some("message_stop")
                } else {
                    false
                }
            } else {
                false
            }
        }
        "google" => false, // Google SSE ends when the stream closes
        _ => false,
    }
}

#[tauri::command]
fn cancel_stream(
    state: tauri::State<'_, StreamCancellationState>,
    stream_id: String,
) {
    let flags = state.flags.lock().unwrap();
    if let Some(flag) = flags.get(&stream_id) {
        flag.store(true, Ordering::Relaxed);
    }
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

                app.manage(StreamCancellationState {
                    flags: Mutex::new(HashMap::new()),
                });

                TrayIconBuilder::new()
                    .icon(icon)
                    .tooltip("LlamaTalk Desktop")
                    .menu(&menu)
                    .on_menu_event(|app, event| {
                        match event.id.as_ref() {
                            "quit" => {
                                for (_, w) in app.webview_windows() {
                                    let _ = w.destroy();
                                }
                                std::thread::sleep(std::time::Duration::from_millis(300));
                                std::process::exit(0);
                            }
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
            launch_installer,
            cred_store,
            cred_load,
            cred_delete,
            detect_backend,
            stream_chat,
            cancel_stream
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
