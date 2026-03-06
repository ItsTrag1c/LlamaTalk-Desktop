# LlamaTalk Desktop

> A private, local-first AI chat app for macOS and Windows.

LlamaTalk Desktop is a Tauri-based desktop app for chatting with [Ollama](https://ollama.com/) models and cloud AI providers — Anthropic Claude, Google Gemini, and OpenAI GPT. Your conversations and settings stay on your machine.

---

## Download

**[→ Latest Release](https://github.com/ItsTrag1c/LlamaTalk-Desktop/releases/latest)**

### macOS

| File | Description |
|------|-------------|
| `LlamaTalk Desktop_x.y.z_aarch64.dmg` | Apple Silicon installer (recommended) |
| `LlamaTalk Desktop_x.y.z_x64.dmg` | Intel installer |

### Windows

| File | Description |
|------|-------------|
| `LlamaTalk Desktop_x.y.z_x64-setup.exe` | Windows installer (recommended) |
| `checksums.txt` | SHA-256 checksums for verification |

---

## Features

- **Local models** — connects to any [Ollama](https://ollama.com/) server on your machine or network
- **OpenAI-compatible servers** — llama.cpp, LM Studio, vLLM, and other OpenAI-compatible backends auto-detected
- **Cloud models** — Anthropic Claude, Google Gemini, OpenAI GPT (API key required)
- **True streaming** — responses appear token-by-token in real time from all providers
- **Token counter** — live TK/S display during generation with actual API-reported token counts
- **PIN login** — optional, PBKDF2-hashed with security questions and Forgot PIN flow; credentials stored securely in macOS Keychain / Windows Credential Manager
- **Encrypted conversations** — AES-256-GCM encryption at rest when a PIN is set
- **Llama Assistant** — floating transparent desktop companion, always on top, draggable (Windows)
- **Per-model system prompts** — set a different base prompt for each model or provider
- **Conversation history** — full sidebar with rename, export to `.txt`, and delete
- **Automatic updates** — orange dot notification + one-click download from GitHub
- **System tray** — minimizes to tray; tray menu for quick assistant toggle
- **Temperature control** — slider for response creativity (0.0–1.0)
- **Theme** — System (auto), Dark, or Light
- **Zero telemetry** — no analytics, no tracking, no cloud sync of any kind

---

## Install

### macOS

1. Download the latest DMG from [Releases](https://github.com/ItsTrag1c/LlamaTalk-Desktop/releases/latest)
2. Open the DMG and drag **LlamaTalk Desktop** to Applications
3. Launch from Applications or Spotlight

**Requirements:** macOS 12.0 or later (Monterey or later). Apple Silicon (M1+) or Intel.

### Windows

1. Download the latest installer from [Releases](https://github.com/ItsTrag1c/LlamaTalk-Desktop/releases/latest)
2. Run the installer — a UAC prompt will appear (installs to `C:\Program Files\LlamaTalk Desktop\`)
3. Launch from the **Start Menu** or your desktop shortcut

**Requirements:** Windows 10 or later (x64). [Ollama](https://ollama.com/) is required for local models — cloud models work without it.

---

## Updating

When a newer version is available, a small orange dot (●) appears on the **Settings** tab inside the app. Open Settings and click **Download & Install →** — the installer downloads from GitHub and launches automatically. Your conversations and settings are preserved.

---

## Privacy

All data is stored locally on your device. Sensitive credentials — PIN hash, security question hashes, and cloud API keys — are stored in the macOS Keychain / Windows Credential Manager; all other settings live in `localStorage`. Nothing is collected, tracked, or synced to any server. API keys are never exported or transmitted except as part of direct API calls to your chosen provider.

See [PRIVACY_POLICY.md](PRIVACY_POLICY.md) for full details.

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

---

*Created by [ItsTrag1c](https://github.com/ItsTrag1c) — [MIT License](LICENSE)*
