# LlamaTalk — Privacy Policy

**Effective Date:** March 2, 2026
**Last Updated:** March 3, 2026 (rev. 3)

---

## Overview

The LlamaTalk suite consists of two applications: **LlamaTalk Desktop**, a desktop application for conversing with local and cloud AI models, and **LlamaTalkCLI**, a terminal companion that provides the same capability from any CMD or PowerShell window.

**The short version:** All your data stays on your computer. We don't collect, share, or transmit any information about you or your conversations — except when you explicitly choose to use a cloud AI provider, in which case only your messages are sent to that provider's servers as described below.

---

## Data We Collect and Store

### LlamaTalk Desktop

LlamaTalk Desktop stores the following data **locally on your device only**:

- **Profile credentials** — Your PIN hash and security question hashes are stored in the **Windows Credential Manager**, a secure OS-level keystore. Your username and non-sensitive settings are stored in the app's localStorage.
- **Conversations** — Full message history of all your chats, stored in localStorage. When a profile with a PIN is active, conversations are **encrypted at rest** using AES-256-GCM. The encryption key is stored in Windows Credential Manager — it never touches the filesystem.
- **Cloud API keys** — Stored in localStorage on this device only. Keys are sent exclusively to their respective AI provider over HTTPS and are never included in profile exports.
- **Export audit trail** — Timestamp of your most recent profile export (`lastExportTime`), displayed in Settings.
- **Settings** — Your preferences including:
  - Ollama server URL
  - Selected AI model and display name (nickname)
  - Theme (light/dark/system)
  - Text size and scroll speed
  - PIN frequency requirement
  - Per-model system prompts ("Base Prompts")
  - Tray behavior preference
  - Temperature setting
  - Hidden models list
  - Enabled cloud providers

**Deletion log:** When you clear your data via "Clear Data & Users," a one-line timestamped entry is appended to `LlamaTalk-deletion-log.txt` in your application data folder. This file exists solely to give you an audit record of your own deletions and is never transmitted anywhere.

### LlamaTalkCLI

LlamaTalkCLI stores the following data **locally on your device only**, in `%APPDATA%\LlamaTalkCLI\`:

- **Config** (`config.json`) — Your name, hashed PIN, Ollama URL, per-model system prompts, model nicknames, and session preferences. When a PIN is set, cloud API keys are **encrypted at rest** using AES-256-GCM with a key derived from your PIN. Without a PIN, API keys are stored in plaintext.
- **Conversation history** (`history.json`) — Messages from the current session, used for crash recovery only. When a PIN is set, history is **encrypted at rest** using the same AES-256-GCM key.

Both files are restricted to the current Windows user via file system permissions (`icacls`). Other users on the same machine cannot read them.

**Session history:** Conversation history is cleared automatically when you exit LlamaTalkCLI cleanly. If the application exits unexpectedly, the previous session's messages remain in `history.json` and are available on the next launch for recovery. Closing normally always starts a fresh session.

### Data Retention

- **Desktop conversations** — Retained until you delete them via the trash icon or "Clear Data & Users"
- **CLI conversation history** — Cleared on every clean exit; only persists between sessions in the event of a crash
- **Profile & Settings (Desktop)** — Retained until you click "Clear Data & Users"
- **Profile & Settings (CLI)** — Retained in `config.json` until you uninstall or manually delete the file
- **Exported profiles** — If you export your profile, the resulting JSON file is stored wherever you save it — you are responsible for managing that file

---

## Data We Do NOT Collect

The LlamaTalk suite **does not:**

- Collect any analytics, telemetry, or usage data
- Track your behavior or conversations
- Store data on any remote server
- Include tracking cookies or identifiers
- Phone home to report errors or crashes
- Collect information about your device, OS, or installed software
- Share your data with third parties

---

## Message and Prompt Privacy

### Local Ollama Models (Default)

When you send a message to a local Ollama model:

1. Your message is sent **only to your local Ollama server** (typically running at `http://localhost:11434`)
2. Your message is **not** sent to any cloud AI service
3. Your message is **not** logged, recorded, or shared externally
4. The response from Ollama is received locally and stored in your conversation history

### Cloud AI Providers (Optional)

LlamaTalk Desktop and LlamaTalkCLI both support optional cloud AI providers: **Anthropic (Claude)**, **Google (Gemini)**, and **OpenAI (GPT)**. These are **disabled by default** and must be explicitly enabled and configured with your own API key.

When you send a message to a cloud model:

1. Your message is transmitted to the selected provider's servers over HTTPS
2. The provider's own privacy policy and data handling practices apply to that message
3. LlamaTalk Desktop displays a notice in the chat area identifying which provider will receive your message, and updates that notice when you switch models
4. Your API keys are stored locally — they are **never** sent anywhere except directly to the API endpoint of the provider they belong to
5. API keys are **never** included in exported profile files

You remain in full control of which providers are enabled and can disable them at any time in Settings.

---

## File Operations

### Exporting Profiles and Conversations

- When you export a profile (JSON) or conversation (TXT), the files are saved to your local disk at the location you specify
- LlamaTalk does not automatically upload or transmit these files anywhere
- Exported profiles do **not** contain API keys or your plaintext PIN — only hashed values and non-sensitive settings

### Importing Profiles

- When you import a profile from a file, LlamaTalk validates the JSON structure and applies your data locally
- LlamaTalkCLI restricts imports to `.json` files only
- No data is sent to external servers during import

---

## Encryption & Security

### Data Encryption at Rest

- **Conversations (Desktop)** — When a profile with a PIN is active, all conversations are encrypted using AES-256-GCM before being written to storage. The encryption key is a random 256-bit key generated at profile creation and stored in Windows Credential Manager. Users without a PIN have their conversations stored as plaintext JSON.
- **API Keys (CLI)** — When a PIN is set, all cloud API keys are encrypted in `config.json` using AES-256-GCM with a key derived from your PIN via PBKDF2. Without a PIN, keys remain in plaintext.
- **Conversation History (CLI)** — When a PIN is set, `history.json` is encrypted with the same derived key. Changing your PIN re-encrypts all data with a new key. Removing your PIN decrypts all data back to plaintext.
- **File Permissions (CLI)** — After every write to `config.json` or `history.json`, file permissions are restricted to the current Windows user only, preventing other users on a shared system from reading your data.

### Authentication

- **PIN Hashing** — PINs in both apps are hashed with PBKDF2 (100,000 iterations, SHA-256, random 16-byte per-user salt). Your plaintext PIN is never stored. Legacy hashes from earlier versions are automatically migrated to PBKDF2.
- **PIN Minimum Length (CLI)** — PINs must be at least 4 characters. Both the setup wizard and the PIN change command enforce this minimum.
- **Timing-Safe PIN Comparison (CLI)** — PIN verification uses `crypto.timingSafeEqual` to prevent timing side-channel attacks.
- **Credential Storage (Desktop)** — PIN and security question hashes are stored in Windows Credential Manager, a secure OS-level keystore, rather than in the app's localStorage.
- **Security Questions (Desktop)** — Security question answers are hashed with SHA-256 and a unique salt before storage. Plaintext answers are never stored.
- **Session Inactivity Timeout (CLI)** — After a configurable period of inactivity (default: 30 minutes), the session locks and requires PIN re-entry before continuing. This prevents unattended terminals from remaining unlocked.

### Network & Application Security

- **HTTPS Enforcement** — All cloud API communication uses HTTPS. Endpoints are hardcoded and cannot be downgraded.
- **Ollama URL Validation** — The Ollama server URL is validated before every request. Non-HTTP/HTTPS schemes and link-local addresses (169.254.x.x) are rejected.
- **Request Timeouts** — All network calls have enforced timeouts to prevent indefinite hangs (Ollama: 120s, cloud providers: 60s, connection checks: 10–15s).
- **Content Security Policy (Desktop)** — Strict CSP prevents inline scripts, eval(), and unauthorized network connections.
- **Capability Scoping (Desktop)** — Tauri capabilities limit what file and system operations the app can perform to the minimum required.
- **Update Integrity** — Software updates downloaded from GitHub are verified against SHA-256 checksums before being applied.
- **Cancel Propagation (CLI)** — Pressing Esc during a response cancels the underlying network request via AbortController, ensuring no orphaned requests continue.
- **API Key Exclusion from Exports** — Cloud API keys are stripped from all exported profile files in both apps.
- **Import Validation** — Imported profiles are validated for type, format, and value constraints before being applied. The CLI restricts imports to `.json` files only.

---

## Security Reviews

The LlamaTalk suite undergoes periodic internal security and dependency audits covering:

- Authentication controls (PIN hashing, encryption, and credential storage)
- Data-at-rest encryption (conversations, API keys, history files)
- Input validation across all user-supplied data
- Network security (URL validation, scheme enforcement, request timeouts)
- Dependency auditing for vulnerabilities, telemetry, or unexpected network behavior

Audit findings are documented internally. No critical vulnerabilities have been identified. Known low-severity items are tracked with risk ratings and remediation plans.

---

## Data You Control

You have full control over your data:

- **Access** — Export your profile and conversations at any time
- **Deletion (Desktop)** — Delete individual conversations via the trash icon, or clear all data via "Clear Data & Users"
- **Deletion (CLI)** — Delete `%APPDATA%\LlamaTalkCLI\config.json` and `history.json` to remove all stored data; or uninstall the application
- **Portability** — Your exported profile JSON can be imported into another LlamaTalk installation on another device
- **Encryption control (CLI)** — Set a PIN to enable encryption; remove your PIN to revert to plaintext storage

---

## Third-Party Dependencies

### LlamaTalk Desktop

- **React** (UI framework)
- **Tauri** (desktop framework)
- **Vite** (build tool)
- **Ollama API** (local AI integration)

### LlamaTalkCLI

- No runtime dependencies — built on Node.js built-in modules only

None of these libraries collect personal data from your usage of LlamaTalk. All dependencies are reviewed periodically for privacy and security compliance.

---

## Updates and Changes

When you update LlamaTalk:

- Your existing profiles, conversations, and settings are preserved
- Encrypted data is migrated automatically — no action required on your part
- Update notes in the changelog disclose any changes to how data is handled
- You are not automatically opted into any new data collection or telemetry

---

## Contact & Transparency

Created by **ItsTrag1c**. For questions, visit the project repository.

---

## Legal Compliance

LlamaTalk is designed with privacy-by-default principles consistent with:

- **GDPR** — Right to access (export), right to deletion (clear data), data minimization (no unnecessary collection), storage limitation (CLI auto-clears history)
- **CCPA** — Right to know, right to delete, right to opt-out of sale (LlamaTalk doesn't sell data)
- **General Privacy Best Practices** — Transparency, user control, encryption at rest, secure credential storage

---

## Changelog

- **2026-03-02** — Initial privacy policy created. Baseline privacy practices documented.
- **2026-03-03** — Updated to cover LlamaTalkCLI. Corrected PIN hashing details (Desktop upgraded to PBKDF2 in v0.8.0). Added cloud provider privacy section. Added deletion log disclosure. Added export audit trail. Documented CLI session history clearing behavior.
- **2026-03-03 (rev. 2)** — Corrected CLI PIN hashing (upgraded to PBKDF2 in v0.3.6; legacy migration noted). Added Security Reviews section. Added cancel propagation note. Added dependency audit reference in Third-Party Dependencies section.
- **2026-03-03 (rev. 3)** — Major update for Desktop v0.10.0 and CLI v0.6.0. Added conversation encryption at rest (Desktop: AES-256-GCM, key in Credential Manager). Added API key and history encryption (CLI: AES-256-GCM, PIN-derived key). Documented Windows Credential Manager usage for Desktop credentials. Added CLI session inactivity timeout. Added CLI PIN minimum length. Added CLI file permissions (icacls). Added CLI `.json`-only import restriction. Reorganized Security Measures into Encryption & Security with subsections. Updated Data You Control with encryption control. Updated Legal Compliance with encryption and storage limitation references.

---

**If you have read and understood this privacy policy, you may proceed with using LlamaTalk.**
