# LlamaTalk Desktop — Changelog

A running history of all features, fixes, and improvements made to LlamaTalk Desktop.
Last updated: 2026-03-05

---

## v0.14.1 — 2026-03-05

### Bug Fixes
- **macOS version display** — App now shows "macOS" or "Windows" suffix in version number
- **Update button for macOS** — Download button now pulls macOS DMG from GitHub releases
- **System Tray label** — Changed to "Dock" on macOS, "System Tray" on Windows
- **App doesn't close on macOS update** — Downloading DMG no longer exits the app

---

## v0.14.0 — 2026-03-05

### New Features
- **macOS support** — LlamaTalk Desktop now runs on macOS 12.0+ (Monterey and later). Supports both Apple Silicon (M1+) and Intel Macs. Includes all features from the Windows version except the Llama Assistant floating window (Windows only).

### Bug Fixes
- **Keychain integration** — Credentials now stored in macOS Keychain on Apple Silicon/Intel builds instead of Windows Credential Manager.

---

## v0.13.0 — 2026-03-04

### New Features
- **Multi-server support** — You can now connect to multiple local model servers simultaneously. Add additional servers in Settings under "Additional Local Servers" — models from all servers are aggregated into a single list. Each model is routed to the correct server automatically.
- **Running model detection** — Models currently loaded in memory on Ollama servers are shown with a 🟢 indicator in the model selector. Running status is polled every 10 seconds.

### Improvements
- **"Ollama" renamed to "Local Server" / "Local Models"** — All user-facing references to "Ollama" have been replaced with generic terms ("Local Server," "Local Models") to better reflect support for Ollama, llama.cpp, LM Studio, vLLM, and other backends.
- **Profile export/import includes additional servers** — The `localServers` list is now included in profile exports and restored on import.

---

## v0.12.1 — 2026-03-04

### Bug Fixes
- **Fixed inaccurate token counts for OpenAI-compatible backends** — When using llama.cpp, LM Studio, vLLM, or other OpenAI-compatible servers, the token counter was falling back to event-counted tokens instead of actual API-reported counts. The streaming request now includes `stream_options: { include_usage: true }`, so backends that support it return real usage data in the final chunk.

---

## v0.12.0 — 2026-03-04

### New Features
- **Real-time tokens per second (TK/S) display** — The token counter now shows live output token count and generation speed while the model is streaming a response (e.g. "156 tokens · 31.2 tk/s"). Updates every 250 ms during generation. After streaming finishes, the counter shows final stats using actual API-reported token counts when available, falling back to event-counted tokens otherwise.
- **Actual API token counts** — All five providers (Ollama, OpenAI-compatible, Anthropic, Google, OpenAI) now report real token usage data from their streaming responses. Ollama provides `eval_count`, `prompt_eval_count`, and `eval_duration`; Anthropic reports `input_tokens`/`output_tokens` via `message_start`/`message_delta` events; Google reports via `usageMetadata`; OpenAI uses `stream_options: { include_usage: true }` for final-chunk usage. The Rust backend extracts this data and emits a `chat-usage` event to the frontend before `chat-done`.
- **Accurate Ollama TK/S** — When using Ollama, tokens per second is calculated from the server-reported `eval_duration` (nanoseconds) rather than wall-clock time, giving a more accurate measure that excludes network latency.

---

## v0.11.2 — 2026-03-04

### Bug Fixes
- **Fixed llama.cpp responses not appearing in chat** — llama.cpp servers that serve both Ollama-compatible and OpenAI-compatible endpoints were misidentified as native Ollama, causing the streaming parser to silently discard all tokens. Backend detection now validates the response body and correctly identifies llama.cpp as OpenAI-compatible. Added fallback parsing so tokens are extracted regardless of stream format.

---

## v0.11.1 — 2026-03-04

### Bug Fixes
- **Fixed streaming responses showing blank text** — Streaming tokens from the Rust backend were emitted as window-level events, but the frontend listened for app-level events. Tokens now emit globally so all windows receive them correctly. Fixes blank responses when using llama.cpp and other backends.

---

## v0.11.0 — 2026-03-04

### New Features
- **True streaming responses** — Messages now appear token-by-token in real time instead of loading the full response first. Works with all providers: Ollama, Anthropic, Google, and OpenAI. The word delay setting now acts as a throttle on top of the stream (0 = instant display, >0 = buffered drain at interval).
- **llama.cpp / OpenAI-compatible server support** — LlamaTalk Desktop now auto-detects whether your local server is Ollama or an OpenAI-compatible API (llama.cpp, vLLM, etc.). Model discovery and chat automatically use the correct endpoints — no manual configuration needed.
- **Backend type shown on connection** — When you test your server URL in Settings, the detected backend type (Ollama or OpenAI-compatible) is identified and saved.
- **Stream cancellation** — The Stop button now immediately cancels the active stream on the server side rather than just hiding the response. Partial responses are preserved in the conversation.

---

## v0.10.0 — 2026-03-03

### Security
- **Conversation history encrypted at rest** — When a profile with a PIN exists, all conversations stored in localStorage are now encrypted using AES-256-GCM. A random 256-bit encryption key is generated at profile creation and stored in Windows Credential Manager (`convEncKey`). Conversations are decrypted in memory after the credential store loads and re-encrypted on every change. Users without a profile or PIN are unaffected — conversations remain as plaintext. Clearing your profile decrypts conversations back to plaintext and removes the key. Importing a profile with a PIN generates a fresh encryption key on the new device. Existing users with a PIN are migrated automatically on first launch.
- **API key security note in Settings** — A new informational note below the API Providers section confirms that API keys are stored locally, sent only to their respective provider over HTTPS, and never included in profile exports.

---

## v0.9.2 — 2026-03-03

### Fixes
- **Profile now persists after closing the app** — Fixed a bug where all profile data (name, PIN, security questions, settings) was lost every time the app was closed. The app was using an abrupt process termination that didn't give the browser engine time to save localStorage to disk. All exit paths now use a graceful shutdown so your data is reliably written before the process ends.

---

## v0.9.1 — 2026-03-03

### Housekeeping
- **MIT License added** — The project is now explicitly licensed under the MIT License.
- **README updated** — Download links are now version-agnostic, security features (Credential Manager, path traversal prevention) are highlighted, and the license is referenced.

---

## v0.9.0 — 2026-03-03

### Security
- **Windows Credential Manager for sensitive hashes** — The PIN hash and all three security question hashes are now stored in the Windows Credential Manager instead of localStorage. Existing accounts are migrated automatically on the next launch — no action required. The exported profile JSON still includes these hashes so profiles can be transferred between devices.
- **File path traversal prevention** — File read, write, and document-opening operations now reject any path that contains `..` components or attempts to escape the allowed directory. Crafted paths cannot access files outside the intended scope.

---

## v0.8.9 — 2026-03-03

### Updates
- **Improved update asset detection** — The GitHub release installer is now found correctly regardless of whether GitHub converts spaces to dots in the filename.

---

## v0.8.8 — 2026-03-03

### Updates
- **Automatic update notification** — The app now checks GitHub for a newer version at startup. When one is available, a small orange dot (●) appears on the Settings tab and a "Download & Install →" button appears in the Settings panel. Clicking it downloads the installer directly from GitHub and launches it — no manual file placement needed.
- **Checksum verification** — Downloaded installers are verified against a SHA-256 checksum before running, protecting against corrupted downloads.

### Setup
- **Installer installs to Program Files** — LlamaTalk Desktop now installs to `Program Files` (64-bit) by default, matching standard Windows app conventions. A UAC prompt will appear during installation.

---

## v0.8.7 — 2026-03-03

### Settings
- **Temperature slider** — New slider in Settings (between Available Models and API Providers) lets you set response temperature from 0.0 (precise) to 1.0 (creative) in 0.05 steps. Current value shown live next to the slider. Applies to Ollama, Anthropic, Google, and OpenAI.

---

## v0.8.6 — 2026-03-03

### Updates
- **Check for updates** — A "Check for updates" button in Settings detects when a newer installer is available in the install folder. Confirm to launch the installer — settings and conversations are preserved automatically.
- Sidebar now shows the correct app version.

---

## v0.8.5 — 2026-03-03

### Documentation
- **Goals and Privacy Policy updated** — Both bundled documents now cover the full LlamaTalk suite. The Privacy Policy accurately describes data storage for LlamaTalk Desktop (localStorage) and LlamaTalkCLI (%APPDATA%\LlamaTalkCLI\), and notes that the CLI's export command excludes API keys. The Goals document introduces LlamaTalkCLI alongside the Desktop app.

---

## v0.8.4 — 2026-03-03

### Branding
- App renamed to LlamaTalk Desktop in all system contexts (system tray, taskbar, task manager, installer, Start Menu, Add/Remove Programs, desktop notifications)
- In-app home page title remains "LlamaTalk"

---

## v0.8.3

### Changes
- **Taskbar title corrected** — The window title shown in the Windows taskbar hover preview now reads "LlamaTalk" instead of the old "Ollama Chat" placeholder.
- **Updated app icon** — The taskbar icon, desktop shortcut, and installer now use the new pixel-art llama design on a dark rounded background, consistent with the in-app logo.
- **Sidebar assistant button updated** — The Llama Assistant toggle button in the sidebar now shows the new pixel-art llama logo.

---

## v0.8.2

### Changes
- **Refreshed llama logo** — The pixelated llama mascot has been redrawn with cleaner proportions throughout the app: a longer, more distinct neck, a proper snout, and crisp pixel-art edges. The updated design appears on all screens that show the logo, in the running indicator during generation, and in the Llama Assistant widget.

---

## v0.8.1

### Changes
- **Llama Assistant personality** — The assistant now has a distinct personality that shapes how it responds: enthusiastic, witty, and a little irreverent. Responses feel more lively and characterful out of the box.
- **Cleaner assistant message display** — Assistant messages in the Llama Assistant widget no longer show a model name label above the response. The header already identifies the assistant, so the per-message label was redundant. User messages still show "You" as before.

---

## v0.8.0

### Security
- **PIN hashing upgraded to PBKDF2** — PINs are now hashed using PBKDF2 with a random per-user salt and 100,000 iterations instead of a single SHA-256 pass. This makes brute-force attacks against stored PIN hashes computationally expensive. Existing accounts are migrated automatically on first unlock with no action required.
- **Ollama URL validated in Rust** — The backend now parses and validates the Ollama server URL before making any request, rejecting non-HTTP/HTTPS schemes and link-local addresses. Closes a potential SSRF vector.

### Privacy
- **Prompt privacy notice in chat** — A small line below the token counter now tells you exactly where your messages are going: your local Ollama server, or the named cloud provider (Anthropic, Google, or OpenAI). The notice updates automatically when you switch models.
- **Profile export audit trail** — Settings now shows when your profile was last exported, or "Never exported" if it hasn't been. The timestamp updates immediately after each export.
- **Data deletion confirmation log** — Clearing profile data now requires two confirmations and shows a summary of what will be deleted (profile name and conversation count). A timestamped entry is written to `LlamaTalk-deletion-log.txt` in your Documents folder for audit purposes.

---

## v0.7.9

### Changes
- **Token counter scoped to current chat** — The context token counter now reflects only the messages in the active conversation plus what you're currently typing. The system prompt is no longer included in the count, so the counter starts at 0 for every new chat and shows the cost of that conversation specifically.

---

## v0.7.8

### Fixes
- **Token counter always shows live context size** — The context token counter now displays the actual token estimate at all times, including when the input box is empty. Previously it reset to 0 whenever no text was typed, hiding the cost of existing conversation history and system prompt.

---

## v0.7.7

### Fixes
- **Goals and Privacy Policy documents now open correctly** — Fixed the resource path used by the document-opening command to include the `resources` subdirectory where the NSIS installer places bundled files. PDFs now open in your default PDF viewer as intended.

---

## v0.7.6

### Fixes
- **Goals and Privacy Policy documents now open reliably** — Moved document-opening to a dedicated Rust command that resolves the bundled resource directory directly via the app handle, then uses the Windows shell to open the file with the default PDF viewer. This replaces the previous JavaScript-based approach that was silently failing.

---

## v0.7.5

### Fixes
- **Goals and Privacy Policy links now open correctly** — Fixed an incorrect resource path that caused the PDF documents bundled with the installer to not open. Both links ("Our Goals →" and "Privacy Policy →") in Settings now open their respective PDFs in your default PDF viewer.

---

## v0.7.4

### Changes
- **Bundled PDF documents** — "Our Goals" and "Privacy Policy" are now PDF documents bundled directly with the installer. Two links at the bottom of the Settings panel ("Our Goals →" and "Privacy Policy →") open each document in your default PDF viewer. Nothing is written to your Documents folder; the PDFs travel with the app.
- **Removed inline privacy section** — The Privacy section that previously showed checkmarks and a text summary has been removed from Settings. The goal and policy documents replace it with more complete information.
- **Separate Goals document** — The team's principles (local-first, zero data collection, honest cloud access, transparency) are now their own dedicated document, separate from the Privacy Policy.

---

## v0.7.3

### Changes
- **Privacy Policy link in Settings** — The Privacy section now includes a "View Privacy Policy →" link. Clicking it writes the latest policy to your Documents folder and opens it in your default text editor. The policy is always up to date with the installed version.
- **Updated privacy policy** — Rewritten to reflect the current state of the app: local-first by design, clear acknowledgment that cloud provider integrations (Anthropic, Google, OpenAI) send data directly to those providers, and an explicit note that LlamaTalk cannot control or guarantee what third-party providers do with that data. Links to each provider's own privacy policy are included.

---

## v0.7.2

### Fixes
- **Single tray instance** — Relaunching the app while it is minimized to the system tray no longer spawns a second icon or process. The existing instance is brought to the foreground instead. Uses the single-instance plugin to intercept duplicate launches at the OS level.

---

## v0.7.1

### Fixes
- **Connect button populates models immediately** — The "Check" button in Settings has been renamed "Connect." Clicking it now commits the server URL and fetches the available model list right away — no need to also click Save Settings. The status light still shows connection state as before.

---

## v0.7.0

### New Features
- **Cloud AI provider support** — LlamaTalk can now connect to Anthropic (Claude), Google (Gemini), and OpenAI alongside your local Ollama setup. The app remains entirely local — API keys are stored on your device and calls go directly from the app to the provider with no intermediate server.
- **API Providers section in Settings** — A new settings section lets you toggle each cloud provider on or off and paste your API key. Keys are saved with your other settings and never leave your machine except as part of the direct API call to that provider.
- **Cloud models in the model selector** — Once a provider is enabled and a key is saved, its models appear in the model dropdown under a labeled group (Anthropic, Google, or OpenAI) alongside your local Ollama models.
- **Privacy notice updates dynamically** — The privacy notice in Settings now reflects which providers are active. If only Ollama is in use, it confirms messages stay local. If cloud providers are enabled, it names them explicitly so you always know where messages are going.

### Changes
- **Send button works without Ollama** — If a cloud model is selected, the send button is active even when your local Ollama server is not running or reachable. Local Ollama models still require a live server connection.
- **Per-model base prompts include cloud models** — Cloud models appear in the Base Prompt model selector so you can set provider-specific system prompts.
- **Provider-specific error messages** — API errors from cloud providers (such as an invalid key or quota exceeded) now show the actual error message from the provider rather than a generic failure notice.

---

## v0.6.1

### New Features
- **Available Models panel in Settings** — A new section in Settings lists every model detected on your Ollama server. Each model has a Visible/Hidden toggle. Hidden models are removed from the main model selector so your dropdown stays clean. Hiding the currently active model automatically switches to the next available one. Visibility preferences persist across sessions.

### Fixes
- **Accurate error messages in chat** — When a model request fails (model not loaded, invalid model name, server error, etc.), the error shown in the chat now reflects the actual error from Ollama rather than always saying "Could not reach Ollama."
- **Model selection after refresh** — Refreshing the model list no longer loses your current selection if the model is still available on the server. If the previously selected model is gone, the app now correctly falls back to the first visible model.

---

## v0.6.0

### Changes
- **Token counter starts at zero** — The context token counter now shows 0 when the input box is empty. The count begins as soon as you start typing, reflecting the full context (conversation history, system prompt, and current message). Previously the counter showed a non-zero value at all times even before any input was entered.

---

## v0.5.9

### Changes
- **Llama Assistant responsive text** — Text in the Llama Assistant chat panel and input bar now scales proportionally as you resize the window. Dragging the window larger increases the font size smoothly; dragging it smaller reduces it. The drag handle and controls remain at a fixed size.

---

## v0.5.8

### Changes
- **Llama Assistant input placeholder** — The chat input in the Llama Assistant now always reads "Ask Llama Assistant…" instead of adapting to the model display name. Keeps the assistant's identity clear and consistent regardless of which model is selected.

---

## v0.5.7

### Changes
- **Llama Assistant reflects model display name** — The Llama Assistant window now shows the model display name (nickname) set in Settings, both in the input placeholder and in the conversation log. Previously the assistant always fell back to the raw model ID. Changes to the display name are reflected immediately after saving Settings, with no need to close and reopen the assistant.

---

## v0.5.6

### Changes
- **Privacy notice in Settings** — A new Privacy section in the Settings panel now shows three plain-language statements confirming that all data stays on your computer, messages are sent only to your local Ollama server, and there is no analytics, telemetry, or data sharing. Visible to all users every time they open Settings.
- **Privacy Policy document** — A comprehensive privacy policy is now available alongside the app, covering what data is stored, where it lives, how long it is retained, and explicit commitments to no telemetry or third-party sharing. Also includes GDPR and CCPA compliance notes.

---

## v0.5.5

### Changes
- **App renamed to LlamaTalk** — The app, installer, tray icon, window title, notifications, and all in-app text have been updated from llamaChat to LlamaTalk. The new name is reflected everywhere: the profile and lock screens, the system tray tooltip and quit menu item, desktop notifications, and the assistant placeholder text.

---

## v0.5.4

### Changes
- **Llama Assistant conversation log** — The assistant now shows a full scrollable conversation history instead of a single speech bubble. All messages (yours and the model's) remain visible in a frosted-glass panel until you click Clear. A thin scrollbar appears on the right side as the conversation grows.
- **Assistant syncs to main app chat log** — Every completed exchange in the Llama Assistant is recorded as a conversation in the main app's sidebar, titled with the first message. The conversation is marked with a small orange "via Llama Assistant" badge in the chat header so you always know where it came from. Clearing the assistant starts a fresh entry on the next message.

---

## v0.5.3

### Changes
- **Chat display clear button** — A "Clear" button now appears in the chat header whenever a conversation has messages. Clicking it hides all currently displayed messages from view without deleting the conversation or its history. Messages are only ever permanently deleted via the trash icon in the chat list.
- **Per-message delete** — Hovering over any message (sent or received) reveals a ⋮ menu button. Clicking it shows a "Delete message" option that removes that individual message from the conversation history permanently.
- **Llama Assistant clear** — The Llama Assistant drag handle now includes a "Clear" button when there is an active conversation or bubble. Clicking it resets the assistant's conversation context and clears the speech bubble.
- **Build version label** — The current app version is now shown in small text at the bottom-left of the sidebar.

---

## v0.5.2

### Changes
- **Llama Assistant thinking indicator** — While waiting for the model to respond, three animated orange dots now pulse inside the speech bubble so you know it's working.
- **Persistent response bubble** — The speech bubble now stays visible after the model finishes speaking. A small × button appears in the top corner of the bubble to dismiss it manually. The bubble clears automatically when a new message is sent.

---

## v0.5.1

### Changes
- **Llama Assistant button label** — The sidebar assistant button now has an orange "LLAMA ASSISTANT" label above it so users know what it does at a glance. A small "+" badge on the top-right of the icon reinforces that it opens the companion.

---

## v0.5.0

### Changes
- **Llama Assistant sidebar toggle** — A small llama icon button in the sidebar header now controls the Llama Assistant. Click to show it, click again to hide it. The icon highlights in the accent color when the assistant is active. This replaces the previous checkbox in Settings — the toggle is now instant with no Save required.

---

## v0.4.9

### New Features
- **Llama Assistant** — A transparent floating desktop companion. A pixel-art llama character sits directly on your desktop with no window frame or background — just the character. Ask it anything via the single-line input beneath it. While the model responds, a frosted-glass speech bubble appears next to the llama's face and fills word-by-word in sync with the reply. The mouth opens and closes with each word and the eyebrow reacts while thinking. When the response finishes, the bubble disappears. A slim frosted-glass handle bar at the top of the widget can be dragged to move it anywhere on screen and includes a visible × button to hide it. The input placeholder reflects the model display name set in Settings.
- **Llama Assistant tray toggle** — The system tray right-click menu now includes a "Llama Assistant" checkable item to show or hide the assistant without opening the main app.

---

## v0.4.8

### Security
- **Profile JSON import validation** — Added `validateProfileJson()` which runs before any field is written to localStorage on import. Validates type, format, and allowed values for every field: `pinHash`/`sqHash1-3` must be 64-char hex strings, `ollamaUrl` must be a valid http/https URL (link-local IPs rejected), `theme`/`chatTextSize`/`pinFrequency` must be known enum values, `sqIndex1-3` must be integers 0–8, string fields have length caps. Rejects the entire file and shows specific errors if anything is invalid.

---

## v0.4.7

### Security
- **Content Security Policy enabled** — Replaced `null` CSP with a restrictive policy: scripts locked to `'self'` only (no inline scripts, no eval), styles allow `'unsafe-inline'` for Tailwind compatibility, connections restricted to Tauri IPC. Blocks script injection via Ollama responses or crafted content.
- **Capabilities cleanup** — Removed leftover `llamachat-*` window entry from capabilities after multi-window feature was removed in v0.4.6.

---

## v0.4.6

### Changes
- **Removed new window button** — The + button that opened additional LlamaTalk windows has been removed. The close button handler is restored to its original simple form.

---

## v0.4.5

### Fixes & Improvements
- **Multi-window X button fix (second attempt)** — Rewrote close handling with a two-pass flag approach: all user-initiated closes are intercepted first, window count is checked via Rust, and if multiple windows are open a programmatic `close()` is issued with a flag set so the second trigger passes through without prevention. This reliably closes just the target window regardless of Tauri version behavior.

---

## v0.4.4

### Fixes & Improvements
- **Multi-window X button fix** — Closing a window when multiple are open now works correctly. Previous v0.4.3 fix used a JS API (`getAllWindows`) that silently failed; replaced with a direct Rust `window_count` command that reliably returns the open window count, so X correctly closes just that window.

---

## v0.4.3

### Fixes & Improvements
- **Multi-window close behavior** — Closing a window when multiple windows are open now closes only that window instead of hiding all to tray or killing the entire app. Tray/exit behavior is only applied when closing the last remaining window.
- **Secondary windows visible in taskbar** — Extra windows opened via the + button now explicitly appear as separate entries in the Windows taskbar.

---

## v0.4.2

### New Features
- **Export Profile & Settings button in Settings tab** — A dedicated "Export Profile & Settings" button now appears at the bottom of the Settings panel, making it easy to export without opening the avatar dropdown.

### Fixes & Improvements
- "Export Profile" renamed to "Export Profile & Settings" in the avatar dropdown to better reflect that all settings (URL, theme, prompts, PIN frequency, security questions, tray behavior, etc.) are included in the export file

---

## v0.4.1

### New Features
- **Import Profile on splash screen** — The initial "Create Your Profile" screen now has an "Import Existing Profile" button. Selecting a profile JSON file immediately restores all profile data (name, PIN, security questions, settings) and bypasses the rest of setup — no need to go through profile creation or the Ollama URL onboarding screen.

### Fixes & Improvements
- Security questions (`sqIndex1-3`, `sqHash1-3`) were missing from Export/Import Profile — now included so a fully restored profile also restores the Forgot PIN flow
- `doImportProfile` now explicitly clears `showOllamaSetup` so importing during onboarding goes straight to the home screen

---

## v0.4.0

### New Features
- **Ollama URL setup onboarding** — After completing profile creation, a new "Connect to Ollama" screen appears with a URL input, Check Connection button with status light, and a Skip button. On successful connection, automatically transitions to the home screen.
- **PIN frequency setting** — New dropdown in Settings under "PIN Requirement":
  - *Every login (app startup)* — always requires PIN on launch (default)
  - *Every 30 days* — skips PIN if unlocked within the last 30 days
  - *Don't require PIN on this device* — never locks on startup (Sign Out still locks manually)
- **Per-model Base Prompts** — Base Prompt in Settings now has a model selector dropdown. You can set a unique system prompt for each Ollama model individually, or set a "Default (all models)" fallback. The dropdown syncs to the currently active chat model and is fully independent — you can edit one model's prompt while chatting with another.
- **Attachment security restrictions** — The attachment button now enforces a strict whitelist:
  - *Allowed:* Images (png, jpg, jpeg, gif, bmp, webp, tiff, ico, svg), Videos (mp4, avi, mov, mkv, webm, m4v, flv, wmv), PDFs, Text documents (txt, md, log, csv, rtf)
  - *Blocked:* Executables, scripts, and code files (exe, msi, bat, cmd, ps1, sh, py, js, ts, jar, and more)
- **Attachment to model** — Files are sent to the model on Send:
  - Images → sent as base64 for vision models (e.g. LLaVA)
  - Text documents → content injected inline into the message
  - PDFs → reference note shown (binary extraction not yet supported)
  - Videos → reference note shown (Ollama cannot process video)
- **Actual app termination** — When "Close button minimizes to tray" is OFF and the X button (or Alt+F4) is pressed, the app process fully exits instead of staying alive in the background. Uses a new `exit_app` Rust command (`std::process::exit(0)`).
- **Save Settings covers all settings** — PIN frequency and per-model prompts are now included in the Save Settings button along with all other settings.
- **Export/Import Profile updated** — Profile export/import now includes `modelPrompts` (per-model prompts) and `pinFrequency`.

### Fixes & Improvements
- `lastUnlockTime` is saved to localStorage on every successful PIN unlock (used by the 30-day frequency check)
- Clear Data & Users also removes `pinFrequency` and `lastUnlockTime`
- Avatar dropdown hidden during Ollama setup screen (`!showOllamaSetup` condition)
- `onCloseRequested` handler always intercepts close events and routes to either hide-to-tray or full exit based on the setting

---

## v0.3.0

### New Features
- **Profile + PIN login system** — On first launch, users create a profile with a name and a 4–8 digit numeric PIN. The app locks on startup and requires the PIN to access.
- **Security questions** — Profile creation includes a second step: choose 3 security questions and answers (hashed with SHA-256 + salt). Used to reset a forgotten PIN.
- **Forgot PIN flow** — Lock screen includes a "Forgot your PIN?" link. Shows a random security question, with a refresh button to cycle to another. On correct answer, allows setting a new PIN.
- **User avatar dropdown (top-right titlebar)** — Circular avatar button with the first letter of the username. Opens a dropdown with:
  - Username + large avatar (static header)
  - Lock App
  - Change PIN (inline expandable form — no page navigation)
  - Export Profile
  - Import Profile
  - Sign Out (locks app, keeps credentials)
  - Clear Data & Users (danger — shows confirmation prompt, removes all profile/PIN/security data)
  - For users without a profile: Set Up Profile, Import Profile
- **Export Profile / Import Profile** — Profile data (name, PIN hash, security question hashes, settings) can be exported to a JSON file and imported on another device.
- **Sign Out vs Clear Data separation** — Sign Out now only locks the app (credentials remain for the next login). Clear Data & Users permanently removes all profile data from the device with a confirmation dialog.
- **System tray right-click menu** — Tray icon now has a right-click menu with "Quit LlamaTalk" that fully exits the process.
- **Draft-based settings** — All settings are staged as drafts and only applied when the Save Settings button is clicked. Includes: URL, model nickname, theme, scroll speed, text size, tray behavior.

### Fixes & Improvements
- Removed profile section from the Settings panel (all profile management moved to the avatar dropdown)
- Settings panel now starts cleanly with Theme
- Click-outside detection closes the avatar dropdown and cancels PIN change mode
- PIN change auto-closes the dropdown 2 seconds after a successful change

---

## v0.2.0

### New Features
- **System tray minimize** — Close button hides the app to the system tray instead of exiting. App can be restored by clicking the tray icon.
- **LlamaTalk logo** — Custom SVG llama logo added to the sidebar header and profile screens.
- **Animated llama** — A running llama animation plays in the chat while the model is generating a response.
- **New window button** — Plus (+) button in the sidebar header opens a new independent LlamaTalk window.
- **Escape key stops generation** — Pressing Escape cancels the current model response mid-stream.
- **Desktop notifications** — When a response completes while the app is not focused, a system notification is sent.
- **Token counter** — Displays a live estimate of context tokens used (≈ 4 chars per token) in the input area.
- **Chat text size setting** — Three sizes: Small (13px), Medium (15px, default), Large (18px).
- **Text scroll speed setting** — Slider (Fast → Slow) controls the word-by-word response animation delay.
- **Version management** — Version numbers tracked across `tauri.conf.json`, `Cargo.toml`, and `package.json`.

---

## v0.1.0 — Initial Release

### Core Features
- **Ollama integration** — Connects to a local Ollama server (`http://localhost:11434` by default). Fetches available models and sends chat messages via the Ollama `/api/chat` endpoint.
- **Conversation sidebar** — List of all conversations with rename (inline edit), delete, and export to `.txt` buttons. Clicking a conversation loads its message history.
- **New Chat button** — Creates a new empty conversation.
- **Model selector** — Dropdown to switch between installed Ollama models with a live connection status dot and refresh button.
- **Streaming response simulation** — Responses are displayed word-by-word with a configurable delay for a typing effect.
- **System / Base Prompt** — Text area in Settings to set a global system prompt sent with every message.
- **Server URL setting** — Input to change the Ollama server URL with a Check Connection button and status indicator.
- **Model Display Name** — Optional nickname for the active model shown in the chat instead of the raw model ID.
- **Theme setting** — System (auto), Dark, Light.
- **Custom titlebar** — Frameless window with custom minimize, maximize, and close buttons.
- **Chat export** — Export individual conversations to a `.txt` file with a save dialog.
- **Error banner** — Shown in the main area when Ollama cannot be reached, with a Retry button.
- **Stop generation** — Stop button (or Escape key) cancels the active response.

---

*This document is updated with each new version of LlamaTalk Desktop.*

*Last updated: 2026-03-04 (v0.13.0)*

---

## Upcoming — Planned Changes & Features

*This section reflects areas of active development and longer-term goals. Details and order of delivery may change.*

---

### Near-Term Features

- **Project website** — A dedicated web presence for LlamaTalk with download links, a changelog, project goals, and contact information
- **Cross-platform builds** — macOS and Linux versions of LlamaTalk in development

---

### Long-Term Goals

- **Image generation** — Generate and view images directly within LlamaTalk
- **Dialogue mode** — A unique character-driven chat interface with a distinct visual style separate from the main chat view

---

*Planned features are subject to change and do not represent a committed release schedule.*
