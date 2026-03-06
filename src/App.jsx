import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { save, open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { sendNotification, isPermissionGranted, requestPermission } from "@tauri-apps/plugin-notification";
import { openPath } from "@tauri-apps/plugin-opener";

const APP_VERSION = "0.14.1";
let IS_MACOS = false;
let IS_WINDOWS = false;
const DEFAULT_URL = "http://localhost:11434";

const CLOUD_MODELS = {
  anthropic: ["claude-opus-4-5", "claude-sonnet-4-5", "claude-3-5-haiku-20241022"],
  google:    ["gemini-2.0-flash", "gemini-2.0-flash-lite", "gemini-1.5-pro", "gemini-1.5-flash"],
  openai:    ["gpt-4o", "gpt-4o-mini", "o1", "o3-mini"],
};


function normalizeUrl(url) {
  let u = (url || "").trim().replace(/\/+$/, "");
  if (u && !/^https?:\/\//i.test(u)) u = "http://" + u;
  return u;
}

function validateProfileJson(p) {
  if (typeof p !== "object" || p === null || Array.isArray(p)) {
    throw new Error("Invalid profile: not an object.");
  }
  const SHA256 = /^[a-f0-9]{64}$/;
  const errors = [];

  const PBKDF2_HASH = /^pbkdf2v1:[a-f0-9]{32}:[a-f0-9]{64}$/;
  if (p.pinHash !== undefined && !SHA256.test(p.pinHash) && !PBKDF2_HASH.test(p.pinHash))
    errors.push("pinHash is not a valid hash.");

  if (p.profileName !== undefined && (typeof p.profileName !== "string" || p.profileName.length > 100))
    errors.push("profileName must be a string up to 100 characters.");

  if (p.systemPrompt !== undefined && (typeof p.systemPrompt !== "string" || p.systemPrompt.length > 10000))
    errors.push("systemPrompt must be a string up to 10,000 characters.");

  if (p.ollamaUrl !== undefined) {
    let ok = false;
    try {
      const u = new URL(p.ollamaUrl);
      if ((u.protocol === "http:" || u.protocol === "https:") && !/^169\.254\./i.test(u.hostname)) ok = true;
    } catch { /* ok stays false */ }
    if (!ok) errors.push("ollamaUrl must be a valid http or https URL.");
  }

  if (p.modelName !== undefined && (typeof p.modelName !== "string" || p.modelName.length > 100))
    errors.push("modelName must be a string up to 100 characters.");

  if (p.theme !== undefined && !["system", "dark", "light"].includes(p.theme))
    errors.push("theme must be 'system', 'dark', or 'light'.");

  if (p.wordDelay !== undefined) {
    const d = Number(p.wordDelay);
    if (!Number.isFinite(d) || d < 0 || d > 500) errors.push("wordDelay must be a number between 0 and 500.");
  }

  if (p.chatTextSize !== undefined && !["small", "medium", "large"].includes(p.chatTextSize))
    errors.push("chatTextSize must be 'small', 'medium', or 'large'.");

  if (p.pinFrequency !== undefined && !["always", "30days", "never"].includes(p.pinFrequency))
    errors.push("pinFrequency must be 'always', '30days', or 'never'.");

  for (const k of ["sqIndex1", "sqIndex2", "sqIndex3"]) {
    if (p[k] !== undefined) {
      const idx = Number(p[k]);
      if (!Number.isInteger(idx) || idx < 0 || idx > 8)
        errors.push(`${k} must be an integer between 0 and 8.`);
    }
  }

  for (const k of ["sqHash1", "sqHash2", "sqHash3"]) {
    if (p[k] && !SHA256.test(p[k]))
      errors.push(`${k} must be a 64-character hex string.`);
  }

  if (p.modelPrompts !== undefined) {
    let mp = p.modelPrompts;
    if (typeof mp === "string") {
      try { mp = JSON.parse(mp); } catch { errors.push("modelPrompts is not valid JSON."); mp = null; }
    }
    if (mp !== null) {
      if (typeof mp !== "object" || Array.isArray(mp)) {
        errors.push("modelPrompts must be an object.");
      } else {
        for (const v of Object.values(mp)) {
          if (typeof v !== "string" || v.length > 10000) {
            errors.push("modelPrompts values must be strings up to 10,000 characters.");
            break;
          }
        }
      }
    }
  }

  if (errors.length > 0) throw new Error("Invalid profile file:\n• " + errors.join("\n• "));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function loadConversations() {
  try {
    const raw = localStorage.getItem("conversations") || "[]";
    if (isEncryptedConvPayload(raw)) return []; // decrypted async after credential load
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// Legacy SHA-256 hash — used only for migrating existing accounts
async function hashPinLegacy(pin) {
  const encoder = new TextEncoder();
  const data = encoder.encode(pin + "||llamaChat_pin_v1||");
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// PBKDF2 hash with per-user random salt. saltHex is optional; omit to generate a new salt.
// Returns "pbkdf2v1:{saltHex}:{hashHex}"
async function hashPin(pin, saltHex) {
  const encoder = new TextEncoder();
  const saltBytes = saltHex
    ? new Uint8Array(saltHex.match(/.{2}/g).map((b) => parseInt(b, 16)))
    : crypto.getRandomValues(new Uint8Array(16));
  const saltHexOut = Array.from(saltBytes).map((b) => b.toString(16).padStart(2, "0")).join("");
  const keyMaterial = await crypto.subtle.importKey("raw", encoder.encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations: 100000 },
    keyMaterial,
    256
  );
  const hashHex = Array.from(new Uint8Array(bits)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2v1:${saltHexOut}:${hashHex}`;
}

// Verify a PIN against a stored hash. Handles both legacy SHA-256 and PBKDF2 formats.
// Returns { verified, needsMigration, newHash } — newHash is set if migration needed.
async function verifyPin(pin, stored) {
  if (!stored) return { verified: false, needsMigration: false };
  if (stored.startsWith("pbkdf2v1:")) {
    const parts = stored.split(":");
    if (parts.length !== 3) return { verified: false, needsMigration: false };
    const derived = await hashPin(pin, parts[1]);
    return { verified: derived === stored, needsMigration: false };
  }
  // Legacy SHA-256
  const legacyHash = await hashPinLegacy(pin);
  if (legacyHash !== stored) return { verified: false, needsMigration: false };
  const newHash = await hashPin(pin);
  return { verified: true, needsMigration: true, newHash };
}

async function hashAnswer(answer) {
  const encoder = new TextEncoder();
  const data = encoder.encode(answer.toLowerCase().trim() + "||llamaChat_sq_v1||");
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// --- Conversation encryption helpers (AES-256-GCM, key in Windows Credential Manager) ---

async function generateConvKey() {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const raw = await crypto.subtle.exportKey("raw", key);
  return Array.from(new Uint8Array(raw)).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function importConvKey(hex) {
  const bytes = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function encryptConversations(jsonStr, cryptoKey) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(jsonStr);
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, encoded);
  const ivHex = Array.from(iv).map(b => b.toString(16).padStart(2, "0")).join("");
  const ctHex = Array.from(new Uint8Array(cipherBuf)).map(b => b.toString(16).padStart(2, "0")).join("");
  return `enc_v1:${ivHex}:${ctHex}`;
}

async function decryptConversations(payload, cryptoKey) {
  const [, ivHex, ctHex] = payload.split(":");
  const iv = new Uint8Array(ivHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const ct = new Uint8Array(ctHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
  return new TextDecoder().decode(plainBuf);
}

function isEncryptedConvPayload(str) {
  return typeof str === "string" && str.startsWith("enc_v1:");
}

const SECURITY_QUESTIONS = [
  "What was the name of your first pet?",
  "What city were you born in?",
  "What was your childhood nickname?",
  "What is your mother's maiden name?",
  "What was the make of your first car?",
  "What street did you grow up on?",
  "What was the name of your childhood best friend?",
  "What was your high school mascot?",
  "What is your oldest sibling's middle name?",
];

// Icons
function IconPlus() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function IconSend() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}
function IconStop() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  );
}
function IconRefresh() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <polyline points="23 4 23 10 17 10" /><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
    </svg>
  );
}
function IconTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14H6L5 6" /><path d="M10 11v6M14 11v6" />
    </svg>
  );
}
function IconEdit() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}
function IconDownload() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}
function IconMinimize() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
      <rect x="0" y="4.5" width="10" height="1" />
    </svg>
  );
}
function IconMaximize() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1">
      <rect x="0.5" y="0.5" width="9" height="9" />
    </svg>
  );
}
function IconClose() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <line x1="1" y1="1" x2="9" y2="9" /><line x1="9" y1="1" x2="1" y2="9" />
    </svg>
  );
}
function IconPaperclip() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </svg>
  );
}
function IconCoin() {
  return (
    <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
      <circle cx="6.5" cy="6.5" r="6" fill="#f5c518" stroke="#d4a800" strokeWidth="0.6" />
      <ellipse cx="5.2" cy="4.4" rx="1.4" ry="0.7" fill="#ffe66d" opacity="0.7" transform="rotate(-30 5.2 4.4)" />
      <text x="6.5" y="9" textAnchor="middle" fontSize="6.5" fontWeight="bold" fill="#a07800" fontFamily="sans-serif">T</text>
    </svg>
  );
}
function LogoLlama() {
  return (
    <svg viewBox="0 0 36 28" width="28" height="22" fill="#f97316" shapeRendering="crispEdges">
      {/* Ear */}
      <rect x="28" y="0" width="3" height="6" />
      {/* Head */}
      <rect x="23" y="4" width="10" height="7" />
      {/* Snout */}
      <rect x="33" y="6" width="3" height="4" />
      {/* Neck — long, distinct from body */}
      <rect x="17" y="9" width="9" height="8" />
      {/* Body */}
      <rect x="1" y="15" width="23" height="8" />
      {/* Tail */}
      <rect x="0" y="15" width="3" height="5" />
      {/* Legs */}
      <rect x="16" y="23" width="3" height="5" />
      <rect x="11" y="23" width="3" height="5" />
      <rect x="6" y="23" width="3" height="5" />
      <rect x="1" y="23" width="3" height="5" />
      {/* Eye */}
      <rect x="30" y="6" width="2" height="2" fill="#1a1a1a" />
    </svg>
  );
}
function LlamaRunning() {
  return (
    <span className="llama-run-wrap">
      <svg className="llama-run-svg" viewBox="0 0 36 28" width="36" height="28" fill="#f97316" shapeRendering="crispEdges" style={{ overflow: "visible" }}>
        {/* Ear */}
        <rect x="28" y="0" width="3" height="6" />
        {/* Head */}
        <rect x="23" y="4" width="10" height="7" />
        {/* Snout */}
        <rect x="33" y="6" width="3" height="4" />
        {/* Neck — long, distinct from body */}
        <rect x="17" y="9" width="9" height="8" />
        {/* Body */}
        <rect x="1" y="15" width="23" height="8" />
        {/* Tail */}
        <rect x="0" y="15" width="3" height="5" />
        {/* Front near leg */}
        <rect className="llama-leg llama-leg-a" x="16" y="23" width="3" height="5" />
        {/* Front far leg */}
        <rect className="llama-leg llama-leg-b" x="11" y="23" width="3" height="5" />
        {/* Back near leg */}
        <rect className="llama-leg llama-leg-b" x="6" y="23" width="3" height="5" />
        {/* Back far leg */}
        <rect className="llama-leg llama-leg-a" x="1" y="23" width="3" height="5" />
      </svg>
    </span>
  );
}

const appWindow = getCurrentWindow();

export default function App() {
  const [conversations, setConversations] = useState(loadConversations);
  const [currentConvId, setCurrentConvId] = useState(null);
  const [displayFrom, setDisplayFrom] = useState(0);
  const [openMenuMsgId, setOpenMenuMsgId] = useState(null);
  const [models, setModels] = useState([]);
  const [selectedModel, setSelectedModel] = useState(
    () => localStorage.getItem("selectedModel") || ""
  );
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState("checking");
  const [modelPrompts, setModelPrompts] = useState(() => {
    try {
      const existing = JSON.parse(localStorage.getItem("modelPrompts") || "{}");
      // Migrate legacy systemPrompt to _default on first run
      if (Object.keys(existing).length === 0) {
        const legacy = localStorage.getItem("systemPrompt") || "";
        if (legacy) return { "_default": legacy };
      }
      return existing;
    } catch { return {}; }
  });
  const [systemPrompt, setSystemPrompt] = useState(() => {
    try {
      const prompts = JSON.parse(localStorage.getItem("modelPrompts") || "{}");
      return prompts["_default"] || localStorage.getItem("systemPrompt") || "";
    } catch { return localStorage.getItem("systemPrompt") || ""; }
  });
  const [draftPrompt, setDraftPrompt] = useState(() => {
    try {
      const prompts = JSON.parse(localStorage.getItem("modelPrompts") || "{}");
      return prompts["_default"] || localStorage.getItem("systemPrompt") || "";
    } catch { return localStorage.getItem("systemPrompt") || ""; }
  });
  const [ollamaUrl, setOllamaUrl] = useState(() => localStorage.getItem("ollamaUrl") || DEFAULT_URL);
  const [draftOllamaUrl, setDraftOllamaUrl] = useState(() => localStorage.getItem("ollamaUrl") || DEFAULT_URL);
  const [modelName, setModelName] = useState(() => localStorage.getItem("modelName") || "");
  const [draftModelName, setDraftModelName] = useState(() => localStorage.getItem("modelName") || "");
  const [hiddenModels, setHiddenModels] = useState(() => JSON.parse(localStorage.getItem("hiddenModels") || "[]"));
  const [apiKeys, setApiKeys] = useState(() => ({
    anthropic: localStorage.getItem("apiKey_anthropic") || "",
    google:    localStorage.getItem("apiKey_google")    || "",
    openai:    localStorage.getItem("apiKey_openai")    || "",
  }));
  const [draftApiKeys, setDraftApiKeys] = useState(() => ({
    anthropic: localStorage.getItem("apiKey_anthropic") || "",
    google:    localStorage.getItem("apiKey_google")    || "",
    openai:    localStorage.getItem("apiKey_openai")    || "",
  }));
  const [enabledProviders, setEnabledProviders] = useState(() =>
    JSON.parse(localStorage.getItem("enabledProviders") || "{}"));
  const [draftEnabledProviders, setDraftEnabledProviders] = useState(() =>
    JSON.parse(localStorage.getItem("enabledProviders") || "{}"));
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [urlCheckStatus, setUrlCheckStatus] = useState("idle");
  const [activeTab, setActiveTab] = useState("chats");
  const [theme, setTheme] = useState(() => localStorage.getItem("theme") || "system");
  const [draftTheme, setDraftTheme] = useState(() => localStorage.getItem("theme") || "system");
  const [wordDelay, setWordDelay] = useState(() => Number(localStorage.getItem("wordDelay") ?? 20));
  const [draftWordDelay, setDraftWordDelay] = useState(() => Number(localStorage.getItem("wordDelay") ?? 20));
  const [temperature, setTemperature] = useState(() => Number(localStorage.getItem("temperature") ?? 0.7));
  const [draftTemperature, setDraftTemperature] = useState(() => Number(localStorage.getItem("temperature") ?? 0.7));
  const [chatTextSize, setChatTextSize] = useState(() => localStorage.getItem("chatTextSize") || "medium");
  const [draftChatTextSize, setDraftChatTextSize] = useState(() => localStorage.getItem("chatTextSize") || "medium");

  const [closeMinimiesToTray, setCloseMinimiesToTray] = useState(() => localStorage.getItem("closeMinimiesToTray") !== "false");
  const [draftCloseMinimiesToTray, setDraftCloseMinimiesToTray] = useState(() => localStorage.getItem("closeMinimiesToTray") !== "false");

  const [showAssistant, setShowAssistant] = useState(() => localStorage.getItem("showAssistant") === "true");

  const [updateStatus, setUpdateStatus] = useState(null); // null | "checking" | "up-to-date" | {version, path}
  const [confirmingUpdate, setConfirmingUpdate] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(null); // null | { version, url, checksumUrl }
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const [backendType, setBackendType] = useState(() => localStorage.getItem("backendType") || "ollama");
  const [localServers, setLocalServers] = useState(() => JSON.parse(localStorage.getItem("localServers") || "[]"));
  const [runningModels, setRunningModels] = useState(new Set());
  const [modelServerMap, setModelServerMap] = useState({});
  const [serverBackendMap, setServerBackendMap] = useState({});
  const [draftNewServerUrl, setDraftNewServerUrl] = useState("");
  const [newServerCheckStatus, setNewServerCheckStatus] = useState("idle"); // idle | checking | ok | error

  // Profile / PIN — initial values overridden by credential store startup effect
  const [isLocked, setIsLocked] = useState(false);
  const [showProfileSetup, setShowProfileSetup] = useState(false);
  const [profileName, setProfileName] = useState(() => localStorage.getItem("profileName") || "");
  const [setupName, setSetupName] = useState("");
  const [setupPin, setSetupPin] = useState("");
  const [setupPinConfirm, setSetupPinConfirm] = useState("");
  const [setupError, setSetupError] = useState("");
  const [lockPin, setLockPin] = useState("");
  const [lockError, setLockError] = useState("");
  const [changePinMode, setChangePinMode] = useState(false);
  const [cpOld, setCpOld] = useState("");
  const [cpNew, setCpNew] = useState("");
  const [cpConfirm, setCpConfirm] = useState("");
  const [cpError, setCpError] = useState("");
  const [cpSaved, setCpSaved] = useState(false);

  // Security questions (setup step 2)
  const [setupStep, setSetupStep] = useState(1);
  const [sq1, setSq1] = useState(0);
  const [sq2, setSq2] = useState(1);
  const [sq3, setSq3] = useState(2);
  const [sa1, setSa1] = useState("");
  const [sa2, setSa2] = useState("");
  const [sa3, setSa3] = useState("");
  const [sqError, setSqError] = useState("");

  // Forgot PIN flow
  const [forgotPinMode, setForgotPinMode] = useState(false);
  const [fpQuestionIndex, setFpQuestionIndex] = useState(0); // 0, 1, or 2 — which of the 3 saved questions
  const [fpa1, setFpa1] = useState("");
  const [fpError, setFpError] = useState("");
  const [fpResetMode, setFpResetMode] = useState(false);
  const [fpNewPin, setFpNewPin] = useState("");
  const [fpNewPinConfirm, setFpNewPinConfirm] = useState("");

  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);

  // Credential store: loaded from Windows Credential Manager at startup
  const [credStoreLoaded, setCredStoreLoaded] = useState(false);
  const [convCryptoKey, setConvCryptoKey] = useState(null);
  const [storedPinHash, setStoredPinHash] = useState(null);
  const [storedSqHash1, setStoredSqHash1] = useState(null);
  const [storedSqHash2, setStoredSqHash2] = useState(null);
  const [storedSqHash3, setStoredSqHash3] = useState(null);

  // Onboarding: Ollama URL setup after profile creation
  const [showOllamaSetup, setShowOllamaSetup] = useState(false);
  const [onboardUrl, setOnboardUrl] = useState(() => localStorage.getItem("ollamaUrl") || DEFAULT_URL);
  const [onboardCheckStatus, setOnboardCheckStatus] = useState("idle");

  // PIN frequency
  const [pinFrequency, setPinFrequency] = useState(() => localStorage.getItem("pinFrequency") || "always");
  const [draftPinFrequency, setDraftPinFrequency] = useState(() => localStorage.getItem("pinFrequency") || "always");

  // Export audit trail
  const [lastExportTime, setLastExportTime] = useState(() => localStorage.getItem("lastExportTime") || "");

  // Which model's prompt is shown in the settings textarea
  const [promptModelKey, setPromptModelKey] = useState("_default");

  const [editingConvId, setEditingConvId] = useState(null);
  const [editingTitle, setEditingTitle] = useState("");

  const [attachedFile, setAttachedFile] = useState(null);

  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);
  const abortRef = useRef(null);
  const streamIdRef = useRef(null);
  const streamTokenCountRef = useRef(0);
  const streamStartRef = useRef(null);
  const [streamStats, setStreamStats] = useState(null);
  const closeMinimiesToTrayRef = useRef(closeMinimiesToTray);
  const profileDropdownRef = useRef(null);

  // Apply chat text size
  useEffect(() => {
    const sizes = { small: "13px", medium: "15px", large: "18px" };
    document.documentElement.style.setProperty("--chat-font-size", sizes[chatTextSize] || "15px");
  }, [chatTextSize]);

  // Apply theme
  useEffect(() => {
    function applyTheme(t) {
      const resolved = t === "system"
        ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
        : t;
      document.documentElement.setAttribute("data-theme", resolved);
    }
    applyTheme(theme);
    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyTheme("system");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [theme]);

  // Keep ref in sync so the close handler always reads the latest value
  useEffect(() => {
    closeMinimiesToTrayRef.current = closeMinimiesToTray;
  }, [closeMinimiesToTray]);

  // Persist selected model so the Llama Assistant can read it
  useEffect(() => {
    if (selectedModel) localStorage.setItem("selectedModel", selectedModel);
  }, [selectedModel]);

  // Sync showAssistant state when tray menu toggles it via main.eval()
  // Also merge in assistant conversations when the assistant syncs a new exchange
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === "showAssistant") {
        const val = e.newValue === "true";
        setShowAssistant(val);
      }
      if (e.key === "assistantSyncedConv") {
        try {
          const conv = JSON.parse(e.newValue || "null");
          if (!conv) return;
          setConversations((prev) => {
            const exists = prev.find((c) => c.id === conv.id);
            if (exists) {
              return prev.map((c) => (c.id === conv.id ? conv : c));
            }
            return [conv, ...prev];
          });
        } catch {}
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Intercept window close → hide to tray OR fully exit (registered once, reads from ref)
  useEffect(() => {
    let unlisten;
    appWindow.onCloseRequested((event) => {
      event.preventDefault();
      if (closeMinimiesToTrayRef.current) {
        appWindow.hide();
      } else {
        invoke("exit_app").catch(() => {});
      }
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, []);

  // Escape key stops generation
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key === "Escape") stopStreaming();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Close profile dropdown on outside click
  useEffect(() => {
    if (!profileDropdownOpen) return;
    function handleOutside(e) {
      if (profileDropdownRef.current && !profileDropdownRef.current.contains(e.target)) {
        setProfileDropdownOpen(false);
        setChangePinMode(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [profileDropdownOpen]);

  // Persist conversations (encrypted if key available)
  useEffect(() => {
    if (convCryptoKey) {
      encryptConversations(JSON.stringify(conversations), convCryptoKey)
        .then(encrypted => localStorage.setItem("conversations", encrypted))
        .catch(() => {}); // don't corrupt data on error
    } else {
      localStorage.setItem("conversations", JSON.stringify(conversations));
    }
  }, [conversations, convCryptoKey]);

  // Load PIN/SQ hashes from Windows Credential Manager at startup; migrate from localStorage if needed
  useEffect(() => {
    async function loadCredentials() {
      try {
        const [ph, sh1, sh2, sh3, cek] = await Promise.all([
          invoke("cred_load", { key: "pinHash" }),
          invoke("cred_load", { key: "sqHash1" }),
          invoke("cred_load", { key: "sqHash2" }),
          invoke("cred_load", { key: "sqHash3" }),
          invoke("cred_load", { key: "convEncKey" }),
        ]);
        const lsPh  = localStorage.getItem("pinHash");
        const lsSh1 = localStorage.getItem("sqHash1");
        const lsSh2 = localStorage.getItem("sqHash2");
        const lsSh3 = localStorage.getItem("sqHash3");
        let finalPh = ph, finalSh1 = sh1, finalSh2 = sh2, finalSh3 = sh3;
        // Migrate from localStorage → cred store for any key not yet migrated
        if (!ph && lsPh) {
          await invoke("cred_store", { key: "pinHash", value: lsPh });
          localStorage.removeItem("pinHash");
          finalPh = lsPh;
        }
        if (!sh1 && lsSh1) {
          await invoke("cred_store", { key: "sqHash1", value: lsSh1 });
          localStorage.removeItem("sqHash1");
          finalSh1 = lsSh1;
        }
        if (!sh2 && lsSh2) {
          await invoke("cred_store", { key: "sqHash2", value: lsSh2 });
          localStorage.removeItem("sqHash2");
          finalSh2 = lsSh2;
        }
        if (!sh3 && lsSh3) {
          await invoke("cred_store", { key: "sqHash3", value: lsSh3 });
          localStorage.removeItem("sqHash3");
          finalSh3 = lsSh3;
        }
        // Clean up orphaned cred store entries when no profile exists
        if (!localStorage.getItem("profileName")) {
          await Promise.all([
            invoke("cred_delete", { key: "pinHash" }),
            invoke("cred_delete", { key: "sqHash1" }),
            invoke("cred_delete", { key: "sqHash2" }),
            invoke("cred_delete", { key: "sqHash3" }),
            invoke("cred_delete", { key: "convEncKey" }),
          ]);
          finalPh = null; finalSh1 = null; finalSh2 = null; finalSh3 = null;
        }
        // Conversation encryption key — migrate existing users, decrypt conversations
        let finalCek = cek;
        if (!localStorage.getItem("profileName")) {
          finalCek = null;
        } else if (finalPh && !finalCek) {
          // Existing user with PIN but no conv key — generate one (migration)
          const hex = await generateConvKey();
          await invoke("cred_store", { key: "convEncKey", value: hex });
          finalCek = hex;
        }
        if (finalCek) {
          try {
            const key = await importConvKey(finalCek);
            setConvCryptoKey(key);
            const raw = localStorage.getItem("conversations") || "[]";
            if (isEncryptedConvPayload(raw)) {
              const json = await decryptConversations(raw, key);
              setConversations(JSON.parse(json));
            }
          } catch { /* decryption failed — conversations stay as loaded */ }
        }
        setStoredPinHash(finalPh);
        setStoredSqHash1(finalSh1);
        setStoredSqHash2(finalSh2);
        setStoredSqHash3(finalSh3);
        // Determine initial lock/setup state now that hashes are known
        const skipped = localStorage.getItem("profileSkipped") === "true";
        if (!finalPh || skipped) {
          setIsLocked(false);
          setShowProfileSetup(!finalPh && !skipped);
        } else {
          const freq = localStorage.getItem("pinFrequency") || "always";
          if (freq === "never") {
            setIsLocked(false);
          } else if (freq === "30days") {
            const lastUnlock = Number(localStorage.getItem("lastUnlockTime") || 0);
            setIsLocked(Date.now() - lastUnlock > 30 * 24 * 60 * 60 * 1000);
          } else {
            setIsLocked(true);
          }
          setShowProfileSetup(false);
        }
      } catch (e) {
        console.error("Credential store load failed:", e);
      }
      setCredStoreLoaded(true);
    }
    loadCredentials();
  }, []);

  // Detect platform on startup
  useEffect(() => {
    invoke("get_platform").then((platform) => {
      IS_MACOS = platform === "macos";
      IS_WINDOWS = platform === "windows";
    }).catch(() => {
      // Fallback to navigator
      const ua = navigator.userAgent;
      IS_MACOS = ua.includes("Mac");
      IS_WINDOWS = ua.includes("Windows");
    });
  }, []);

  // Remote update check — fires once at startup, non-blocking
  useEffect(() => {
    invoke("check_for_update_remote", { currentVersion: APP_VERSION })
      .then((result) => {
        if (result) {
          const parts = result.split("|");
          setUpdateAvailable({
            version: parts[0],
            url: parts[1],
            checksumUrl: parts[2] ?? "",
          });
        }
      })
      .catch(() => {}); // silent on network failure
  }, []);

  async function checkForUpdate() {
    setUpdateStatus("checking");
    try {
      const result = await invoke("check_for_update", { currentVersion: APP_VERSION });
      if (!result) {
        setUpdateStatus("up-to-date");
      } else {
        const [version, path] = result.split("|");
        setUpdateStatus({ version, path });
      }
    } catch (e) {
      console.error("Update check failed:", e);
      setUpdateStatus("up-to-date");
    }
  }

  function applyUpdate(path) {
    invoke("launch_installer", { path }).catch((e) => console.error("Launch installer failed:", e));
  }

  async function downloadAndInstall() {
    if (!updateAvailable || downloading) return;
    setDownloading(true);
    setDownloadError("");
    try {
      await invoke("download_and_install", {
        url: updateAvailable.url,
        version: updateAvailable.version,
        checksumUrl: updateAvailable.checksumUrl ?? "",
      });
      // Normally the app exits inside the Rust command; if we reach here something went wrong
      setDownloading(false);
    } catch (e) {
      setDownloading(false);
      setDownloadError(typeof e === "string" ? e : "Download failed. Please try again.");
    }
  }

  async function openDoc(resourceName) {
    try {
      await invoke("open_bundled_doc", { filename: resourceName });
    } catch (e) {
      console.error("Could not open document:", e);
    }
  }

  function saveSettings() {
    const cleanUrl = normalizeUrl(draftOllamaUrl);
    setOllamaUrl(cleanUrl);
    setDraftOllamaUrl(cleanUrl);
    setSystemPrompt(draftPrompt);
    setModelName(draftModelName);
    setTheme(draftTheme);
    setWordDelay(draftWordDelay);
    setTemperature(draftTemperature);
    setChatTextSize(draftChatTextSize);
    setCloseMinimiesToTray(draftCloseMinimiesToTray);
    closeMinimiesToTrayRef.current = draftCloseMinimiesToTray;
    setPinFrequency(draftPinFrequency);
    // Save per-model prompt (keyed by the settings dropdown selection)
    const updatedPrompts = { ...modelPrompts, [promptModelKey]: draftPrompt };
    setModelPrompts(updatedPrompts);
    localStorage.setItem("modelPrompts", JSON.stringify(updatedPrompts));
    // Recalculate systemPrompt for the active chat model
    const activePrompt = updatedPrompts[selectedModel] ?? updatedPrompts["_default"] ?? "";
    setSystemPrompt(activePrompt);
    localStorage.setItem("systemPrompt", activePrompt);
    localStorage.setItem("ollamaUrl", cleanUrl);
    localStorage.setItem("modelName", draftModelName);
    localStorage.setItem("theme", draftTheme);
    localStorage.setItem("wordDelay", draftWordDelay);
    localStorage.setItem("temperature", draftTemperature);
    localStorage.setItem("chatTextSize", draftChatTextSize);
    localStorage.setItem("closeMinimiesToTray", draftCloseMinimiesToTray);
    localStorage.setItem("pinFrequency", draftPinFrequency);
    // Save API provider keys and enabled state
    localStorage.setItem("apiKey_anthropic", draftApiKeys.anthropic);
    localStorage.setItem("apiKey_google",    draftApiKeys.google);
    localStorage.setItem("apiKey_openai",    draftApiKeys.openai);
    localStorage.setItem("enabledProviders", JSON.stringify(draftEnabledProviders));
    setApiKeys(draftApiKeys);
    setEnabledProviders(draftEnabledProviders);
    // If selected model is no longer in the combined model list, switch to first visible
    const newCloudList = Object.entries(CLOUD_MODELS)
      .filter(([p]) => draftEnabledProviders[p] && draftApiKeys[p])
      .flatMap(([, list]) => list);
    const newAll = [...models, ...newCloudList];
    if (selectedModel && !newAll.includes(selectedModel)) {
      const newVisible = newAll.filter((m) => !hiddenModels.includes(m));
      setSelectedModel(newVisible[0] || newAll[0] || "");
    }
    fetchModels(cleanUrl);
    setSettingsSaved(true);
    setTimeout(() => setSettingsSaved(false), 2000);
  }

  // Scroll to bottom when messages change
  const currentConv = conversations.find((c) => c.id === currentConvId);
  const messages = currentConv?.messages || [];

  // Cloud models that are enabled and have a key configured
  const activeCloudModels = useMemo(() => {
    const result = {};
    Object.entries(CLOUD_MODELS).forEach(([provider, list]) => {
      if (enabledProviders[provider] && apiKeys[provider]) result[provider] = list;
    });
    return result;
  }, [enabledProviders, apiKeys]);

  // All models: local + active cloud
  const allModels = useMemo(() => {
    return [...models, ...Object.values(activeCloudModels).flat()];
  }, [models, activeCloudModels]);

  // Models visible in the selector (all minus user-hidden ones)
  const visibleModels = useMemo(
    () => allModels.filter((m) => !hiddenModels.includes(m)),
    [allModels, hiddenModels]
  );

  // Estimate context token usage (≈4 chars per token), per chat only
  const contextTokens = useMemo(() => {
    const tok = (s) => Math.ceil((s || "").length / 4);
    let total = 0;
    for (const m of messages) total += tok(m.content) + 4;
    total += tok(input);
    return total;
  }, [messages, input]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Reset displayFrom, open menu, and stream stats when switching conversations
  useEffect(() => {
    setDisplayFrom(0);
    setOpenMenuMsgId(null);
    setStreamStats(null);
  }, [currentConvId]);

  // Reset URL check status when draft URL changes
  useEffect(() => {
    setUrlCheckStatus("idle");
  }, [draftOllamaUrl]);

  // When selected chat model changes → update systemPrompt used in API calls
  // and sync the settings prompt editor to that model
  useEffect(() => {
    if (!selectedModel) return;
    const prompt = modelPrompts[selectedModel] ?? modelPrompts["_default"] ?? "";
    setSystemPrompt(prompt);
    setPromptModelKey(selectedModel);
  }, [selectedModel]);

  // When the settings prompt-model dropdown changes → load that model's saved prompt
  useEffect(() => {
    const prompt = modelPrompts[promptModelKey] ?? "";
    setDraftPrompt(prompt);
  }, [promptModelKey]);

  // Load models on mount
  useEffect(() => {
    fetchModels();
  }, []);

  // Poll running models every 10 seconds (Ollama-type servers only)
  useEffect(() => {
    const poll = async () => {
      const servers = [normalizeUrl(ollamaUrl), ...localServers.map(normalizeUrl)];
      const newRunning = new Set();
      for (const target of servers) {
        const bt = serverBackendMap[target];
        if (bt !== "ollama" && bt !== undefined) continue; // skip non-Ollama
        try {
          const text = await invoke("ollama_get", { url: `${target}/api/ps` });
          const data = JSON.parse(text);
          for (const rm of (data.models || [])) newRunning.add(rm.name);
        } catch { /* ignore */ }
      }
      setRunningModels(newRunning);
    };
    const timer = setInterval(poll, 10000);
    return () => clearInterval(timer);
  }, [ollamaUrl, localServers, serverBackendMap]);

  async function checkConnection() {
    setUrlCheckStatus("checking");
    const url = normalizeUrl(draftOllamaUrl);
    try {
      const detected = await invoke("detect_backend", { url });
      setBackendType(detected);
      localStorage.setItem("backendType", detected);
      setUrlCheckStatus("ok");
      // Commit the URL immediately — populate models without needing Save Settings
      setOllamaUrl(url);
      setDraftOllamaUrl(url);
      localStorage.setItem("ollamaUrl", url);
      fetchModels(url, detected);
    } catch {
      setUrlCheckStatus("error");
    }
  }

  async function addServer() {
    const url = normalizeUrl(draftNewServerUrl);
    if (!url || localServers.includes(url) || url === normalizeUrl(ollamaUrl)) {
      setNewServerCheckStatus("error");
      return;
    }
    setNewServerCheckStatus("checking");
    try {
      const detected = await invoke("detect_backend", { url });
      if (detected === "unknown") throw new Error("no compatible API");
      const updated = [...localServers, url];
      setLocalServers(updated);
      localStorage.setItem("localServers", JSON.stringify(updated));
      setDraftNewServerUrl("");
      setNewServerCheckStatus("ok");
      fetchModels();
    } catch {
      setNewServerCheckStatus("error");
    }
  }

  async function attachFile() {
    const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "bmp", "webp", "tiff", "ico", "svg"];
    const VIDEO_EXTS = ["mp4", "avi", "mov", "mkv", "webm", "m4v", "flv", "wmv"];
    const TEXT_EXTS = ["txt", "md", "log", "csv", "rtf"];
    const BLOCKED_EXTS = new Set([
      "exe", "msi", "bat", "cmd", "com", "scr", "pif",
      "vbs", "vbe", "vba", "js", "ts", "jsx", "tsx", "mjs",
      "ps1", "ps2", "psm1", "psd1", "sh", "bash", "zsh", "fish",
      "py", "rb", "pl", "php", "lua", "go", "rs", "c", "cpp",
      "cs", "java", "swift", "kt", "r", "jar", "dmg", "pkg",
      "deb", "rpm", "reg", "inf",
    ]);
    try {
      const path = await open({
        multiple: false,
        filters: [
          { name: "Images", extensions: IMAGE_EXTS },
          { name: "Videos", extensions: VIDEO_EXTS },
          { name: "PDF", extensions: ["pdf"] },
          { name: "Text Documents", extensions: TEXT_EXTS },
          { name: "All Allowed", extensions: [...IMAGE_EXTS, ...VIDEO_EXTS, "pdf", ...TEXT_EXTS] },
        ],
      });
      if (!path || typeof path !== "string") return;
      const name = path.replace(/\\/g, "/").split("/").pop();
      const ext = (name.split(".").pop() || "").toLowerCase();
      if (BLOCKED_EXTS.has(ext)) {
        alert(`Cannot attach "${name}".\nExecutables and scripts are not allowed for security.`);
        return;
      }
      if (IMAGE_EXTS.includes(ext)) {
        const content = await invoke("read_file_base64", { path });
        setAttachedFile({ name, type: "image", content });
      } else if (VIDEO_EXTS.includes(ext)) {
        setAttachedFile({ name, type: "video", content: null });
      } else if (ext === "pdf") {
        setAttachedFile({ name, type: "pdf", content: null });
      } else {
        const content = await invoke("read_file_text", { path });
        setAttachedFile({ name, type: "text", content });
      }
    } catch (err) {
      console.error("Attach file failed:", err);
    }
  }

  async function fetchModels(url, detectedBackend) {
    const servers = [normalizeUrl(url ?? ollamaUrl), ...localServers.map(normalizeUrl)];
    setOllamaStatus("checking");

    const allList = [];
    const newModelServerMap = {};
    const newServerBackendMap = {};
    const newRunning = new Set();
    const seen = new Set();
    let anyConnected = false;

    for (const target of servers) {
      let bt = (target === normalizeUrl(url ?? ollamaUrl) && detectedBackend) ? detectedBackend : null;

      // Auto-detect backend
      if (!bt) {
        try {
          bt = await invoke("detect_backend", { url: target });
        } catch {
          continue;
        }
        if (bt === "unknown") continue;
      }

      newServerBackendMap[target] = bt;
      anyConnected = true;

      // Fetch models
      try {
        let list;
        if (bt === "openai-compatible") {
          const text = await invoke("ollama_get", { url: `${target}/v1/models` });
          const data = JSON.parse(text);
          list = (data.data || []).map((m) => m.id);
        } else {
          const text = await invoke("ollama_get", { url: `${target}/api/tags` });
          const data = JSON.parse(text);
          list = (data.models || []).map((m) => m.name);
        }

        for (const m of list) {
          if (!seen.has(m)) {
            seen.add(m);
            allList.push(m);
            newModelServerMap[m] = target;
          }
        }

        // Fetch running models (Ollama-type only)
        if (bt === "ollama") {
          try {
            const psText = await invoke("ollama_get", { url: `${target}/api/ps` });
            const psData = JSON.parse(psText);
            for (const rm of (psData.models || [])) {
              newRunning.add(rm.name);
            }
          } catch { /* ignore */ }
        }
      } catch { /* server responded to detect but model list failed */ }
    }

    if (anyConnected) {
      // Update primary backend type from first server
      const primaryTarget = normalizeUrl(url ?? ollamaUrl);
      if (newServerBackendMap[primaryTarget]) {
        setBackendType(newServerBackendMap[primaryTarget]);
        localStorage.setItem("backendType", newServerBackendMap[primaryTarget]);
      }

      setModels(allList);
      setModelServerMap(newModelServerMap);
      setServerBackendMap(newServerBackendMap);
      setRunningModels(newRunning);
      localStorage.setItem("modelServerMap", JSON.stringify(newModelServerMap));
      setSelectedModel((prev) => {
        if (prev && allList.includes(prev)) return prev;
        const hidden = JSON.parse(localStorage.getItem("hiddenModels") || "[]");
        const visible = allList.filter((m) => !hidden.includes(m));
        return visible[0] || allList[0] || "";
      });
      setOllamaStatus("connected");
    } else {
      setOllamaStatus("error");
    }
  }


  function toggleModelVisibility(modelName) {
    setHiddenModels((prev) => {
      const isHiding = !prev.includes(modelName);
      const updated = isHiding
        ? [...prev, modelName]
        : prev.filter((m) => m !== modelName);
      localStorage.setItem("hiddenModels", JSON.stringify(updated));
      // If we just hid the currently selected model, switch to first visible
      if (isHiding) {
        setSelectedModel((sel) => {
          if (sel === modelName) {
            const newVisible = models.filter((m) => !updated.includes(m));
            return newVisible[0] || "";
          }
          return sel;
        });
      }
      return updated;
    });
  }

  function newConversation() {
    const conv = { id: genId(), title: "New Chat", createdAt: Date.now(), messages: [] };
    setConversations((prev) => [conv, ...prev]);
    setCurrentConvId(conv.id);
    setInput("");
    textareaRef.current?.focus();
  }

  function toggleAssistant() {
    const next = !showAssistant;
    setShowAssistant(next);
    localStorage.setItem("showAssistant", next);
    if (next) {
      invoke("show_assistant_window").catch(() => {});
    } else {
      invoke("hide_assistant_window").catch(() => {});
    }
    invoke("set_assistant_checked", { checked: next }).catch(() => {});
  }

  function deleteConversation(id, e) {
    e.stopPropagation();
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (currentConvId === id) setCurrentConvId(null);
  }

  function deleteMessage(msgId) {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === currentConvId
          ? { ...c, messages: c.messages.filter((m) => m.id !== msgId) }
          : c
      )
    );
    setOpenMenuMsgId(null);
  }

  function startEditing(c, e) {
    e.stopPropagation();
    setEditingConvId(c.id);
    setEditingTitle(c.title);
  }

  function commitEdit() {
    if (!editingConvId) return;
    const trimmed = editingTitle.trim();
    if (trimmed) {
      setConversations((prev) =>
        prev.map((c) => c.id === editingConvId ? { ...c, title: trimmed } : c)
      );
    }
    setEditingConvId(null);
  }

  function handleEditKeyDown(e) {
    if (e.key === "Enter") { e.preventDefault(); commitEdit(); }
    else if (e.key === "Escape") { setEditingConvId(null); }
  }

  async function exportChat(conv) {
    const lines = [];
    lines.push(`Title: ${conv.title}`);
    lines.push(`Date: ${new Date(conv.createdAt).toLocaleString()}`);
    lines.push("");
    lines.push("=".repeat(50));
    lines.push("");
    for (const msg of conv.messages) {
      lines.push(msg.role === "user" ? "You:" : `${modelName || selectedModel}:`);
      lines.push(msg.content);
      lines.push("");
    }
    const text = lines.join("\n");
    const filename = conv.title.replace(/[^a-z0-9]/gi, "_").slice(0, 60) + ".txt";
    try {
      const path = await save({
        defaultPath: filename,
        filters: [{ name: "Text", extensions: ["txt"] }],
      });
      if (path) {
        await invoke("write_text_file", { path, content: text });
      }
    } catch (err) {
      console.error("Export failed:", err);
    }
  }

  function stopStreaming() {
    abortRef.current?.abort();
    if (streamIdRef.current) {
      invoke("cancel_stream", { streamId: streamIdRef.current }).catch(() => {});
    }
    setIsStreaming(false);
  }


  function advanceSetup() {
    setSetupError("");
    if (!setupName.trim()) { setSetupError("Please enter a name."); return; }
    if (setupPin.length < 4) { setSetupError("PIN must be at least 4 digits."); return; }
    if (!/^\d+$/.test(setupPin)) { setSetupError("PIN must contain only numbers."); return; }
    if (setupPin !== setupPinConfirm) { setSetupError("PINs do not match."); return; }
    setSqError("");
    setSetupStep(2);
  }

  async function doCreateProfile() {
    setSqError("");
    if (!sa1.trim() || !sa2.trim() || !sa3.trim()) { setSqError("Please answer all 3 questions."); return; }
    if (sq1 === sq2 || sq1 === sq3 || sq2 === sq3) { setSqError("Please select 3 different questions."); return; }
    const hash = await hashPin(setupPin);
    const ah1 = await hashAnswer(sa1);
    const ah2 = await hashAnswer(sa2);
    const ah3 = await hashAnswer(sa3);
    await Promise.all([
      invoke("cred_store", { key: "pinHash", value: hash }),
      invoke("cred_store", { key: "sqHash1", value: ah1 }),
      invoke("cred_store", { key: "sqHash2", value: ah2 }),
      invoke("cred_store", { key: "sqHash3", value: ah3 }),
    ]);
    localStorage.setItem("profileName", setupName.trim());
    localStorage.setItem("profileSkipped", "false");
    localStorage.setItem("sqIndex1", String(sq1));
    localStorage.setItem("sqIndex2", String(sq2));
    localStorage.setItem("sqIndex3", String(sq3));
    setStoredPinHash(hash);
    setStoredSqHash1(ah1);
    setStoredSqHash2(ah2);
    setStoredSqHash3(ah3);
    // Generate conversation encryption key
    const convKeyHex = await generateConvKey();
    await invoke("cred_store", { key: "convEncKey", value: convKeyHex });
    const convKey = await importConvKey(convKeyHex);
    setConvCryptoKey(convKey);
    setProfileName(setupName.trim());
    setSetupName(""); setSetupPin(""); setSetupPinConfirm("");
    setSa1(""); setSa2(""); setSa3("");
    setSetupStep(1);
    setShowProfileSetup(false);
    setIsLocked(false);
    setShowOllamaSetup(true); // Show Ollama URL setup next
  }

  async function onboardCheckConnection() {
    setOnboardCheckStatus("checking");
    const url = normalizeUrl(onboardUrl);
    try {
      await invoke("ollama_get", { url: `${url}/api/tags` });
      setOnboardCheckStatus("ok");
      setTimeout(() => {
        const cleanUrl = normalizeUrl(onboardUrl);
        setOllamaUrl(cleanUrl);
        setDraftOllamaUrl(cleanUrl);
        localStorage.setItem("ollamaUrl", cleanUrl);
        fetchModels(cleanUrl);
        setShowOllamaSetup(false);
      }, 1200);
    } catch {
      setOnboardCheckStatus("error");
    }
  }

  function skipOllamaSetup() {
    setShowOllamaSetup(false);
  }

  function skipProfileSetup() {
    localStorage.setItem("profileSkipped", "true");
    setSetupStep(1);
    setSetupName(""); setSetupPin(""); setSetupPinConfirm("");
    setShowProfileSetup(false);
    setIsLocked(false);
  }

  async function doUnlock() {
    setLockError("");
    if (!lockPin) { setLockError("Please enter your PIN."); return; }
    const stored = storedPinHash;
    const { verified, needsMigration, newHash } = await verifyPin(lockPin, stored);
    if (verified) {
      if (needsMigration) {
        await invoke("cred_store", { key: "pinHash", value: newHash });
        setStoredPinHash(newHash);
      }
      localStorage.setItem("lastUnlockTime", Date.now().toString());
      setIsLocked(false);
      setLockPin("");
    } else {
      setLockError("Incorrect PIN.");
      setLockPin("");
    }
  }

  function doLockApp() {
    if (storedPinHash) {
      setForgotPinMode(false);
      setFpResetMode(false);
      setFpa1("");
      setFpError("");
      setIsLocked(true);
    }
  }

  async function doVerifyForgotPin() {
    setFpError("");
    if (!fpa1.trim()) { setFpError("Please enter your answer."); return; }
    const ah = await hashAnswer(fpa1);
    const stored = [storedSqHash1, storedSqHash2, storedSqHash3][fpQuestionIndex];
    if (ah !== stored) {
      setFpError("Incorrect answer. Try refreshing for a different question.");
      return;
    }
    setFpResetMode(true);
  }

  function refreshForgotQuestion() {
    const options = [0, 1, 2].filter((i) => i !== fpQuestionIndex);
    setFpQuestionIndex(options[Math.floor(Math.random() * options.length)]);
    setFpa1("");
    setFpError("");
  }

  async function doResetPin() {
    setFpError("");
    if (fpNewPin.length < 4) { setFpError("PIN must be at least 4 digits."); return; }
    if (!/^\d+$/.test(fpNewPin)) { setFpError("PIN must contain only numbers."); return; }
    if (fpNewPin !== fpNewPinConfirm) { setFpError("PINs do not match."); return; }
    const hash = await hashPin(fpNewPin);
    await invoke("cred_store", { key: "pinHash", value: hash });
    setStoredPinHash(hash);
    setForgotPinMode(false);
    setFpResetMode(false);
    setFpa1("");
    setFpNewPin(""); setFpNewPinConfirm("");
    setLockError("PIN reset! Please log in with your new PIN.");
    setLockPin("");
  }

  async function doExportProfile() {
    const profile = {
      profileName: localStorage.getItem("profileName") || "",
      pinHash: storedPinHash || "",
      systemPrompt: localStorage.getItem("systemPrompt") || "",
      modelPrompts: localStorage.getItem("modelPrompts") || "{}",
      ollamaUrl: localStorage.getItem("ollamaUrl") || DEFAULT_URL,
      localServers: JSON.parse(localStorage.getItem("localServers") || "[]"),
      modelName: localStorage.getItem("modelName") || "",
      theme: localStorage.getItem("theme") || "system",
      wordDelay: localStorage.getItem("wordDelay") || "20",
      chatTextSize: localStorage.getItem("chatTextSize") || "medium",
      closeMinimiesToTray: localStorage.getItem("closeMinimiesToTray") ?? "true",
      pinFrequency: localStorage.getItem("pinFrequency") || "always",
      sqIndex1: localStorage.getItem("sqIndex1") || "0",
      sqIndex2: localStorage.getItem("sqIndex2") || "1",
      sqIndex3: localStorage.getItem("sqIndex3") || "2",
      sqHash1: storedSqHash1 || "",
      sqHash2: storedSqHash2 || "",
      sqHash3: storedSqHash3 || "",
    };
    try {
      const path = await save({
        defaultPath: "LlamaTalk-profile.json",
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (path) {
        await invoke("write_text_file", { path, content: JSON.stringify(profile, null, 2) });
        const ts = Date.now().toString();
        localStorage.setItem("lastExportTime", ts);
        setLastExportTime(ts);
      }
    } catch (err) { console.error("Export profile failed:", err); }
  }

  async function doImportProfile() {
    try {
      const path = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (!path || typeof path !== "string") return;
      const text = await invoke("read_file_text", { path });
      const p = JSON.parse(text);
      validateProfileJson(p);
      if (p.pinHash) { await invoke("cred_store", { key: "pinHash", value: p.pinHash }); setStoredPinHash(p.pinHash); }
      if (p.profileName) { localStorage.setItem("profileName", p.profileName); setProfileName(p.profileName); }
      if (p.systemPrompt !== undefined) { localStorage.setItem("systemPrompt", p.systemPrompt); setSystemPrompt(p.systemPrompt); setDraftPrompt(p.systemPrompt); }
      if (p.ollamaUrl) { localStorage.setItem("ollamaUrl", p.ollamaUrl); setOllamaUrl(p.ollamaUrl); }
      if (Array.isArray(p.localServers)) {
        const validServers = p.localServers.filter((s) => typeof s === "string" && /^https?:\/\/.+/.test(s));
        localStorage.setItem("localServers", JSON.stringify(validServers));
        setLocalServers(validServers);
      }
      if (p.modelName !== undefined) { localStorage.setItem("modelName", p.modelName); setModelName(p.modelName); setDraftModelName(p.modelName); }
      if (p.theme) { localStorage.setItem("theme", p.theme); setTheme(p.theme); setDraftTheme(p.theme); }
      if (p.wordDelay !== undefined) { localStorage.setItem("wordDelay", p.wordDelay); setWordDelay(Number(p.wordDelay)); setDraftWordDelay(Number(p.wordDelay)); }
      if (p.chatTextSize) { localStorage.setItem("chatTextSize", p.chatTextSize); setChatTextSize(p.chatTextSize); setDraftChatTextSize(p.chatTextSize); }
      if (p.closeMinimiesToTray !== undefined) {
        localStorage.setItem("closeMinimiesToTray", p.closeMinimiesToTray);
        const val = p.closeMinimiesToTray !== "false";
        setCloseMinimiesToTray(val); setDraftCloseMinimiesToTray(val);
      }
      if (p.modelPrompts) {
        try {
          const mp = typeof p.modelPrompts === "string" ? JSON.parse(p.modelPrompts) : p.modelPrompts;
          localStorage.setItem("modelPrompts", JSON.stringify(mp));
          setModelPrompts(mp);
        } catch {}
      }
      if (p.pinFrequency) {
        localStorage.setItem("pinFrequency", p.pinFrequency);
        setPinFrequency(p.pinFrequency); setDraftPinFrequency(p.pinFrequency);
      }
      if (p.sqIndex1 !== undefined) localStorage.setItem("sqIndex1", p.sqIndex1);
      if (p.sqIndex2 !== undefined) localStorage.setItem("sqIndex2", p.sqIndex2);
      if (p.sqIndex3 !== undefined) localStorage.setItem("sqIndex3", p.sqIndex3);
      if (p.sqHash1) { await invoke("cred_store", { key: "sqHash1", value: p.sqHash1 }); setStoredSqHash1(p.sqHash1); }
      if (p.sqHash2) { await invoke("cred_store", { key: "sqHash2", value: p.sqHash2 }); setStoredSqHash2(p.sqHash2); }
      if (p.sqHash3) { await invoke("cred_store", { key: "sqHash3", value: p.sqHash3 }); setStoredSqHash3(p.sqHash3); }
      localStorage.setItem("profileSkipped", "false");
      // Generate new conv encryption key for imported profile with PIN
      if (p.pinHash) {
        const convKeyHex = await generateConvKey();
        await invoke("cred_store", { key: "convEncKey", value: convKeyHex });
        const key = await importConvKey(convKeyHex);
        setConvCryptoKey(key);
      }
      setShowProfileSetup(false);
      setShowOllamaSetup(false);
      alert("Profile imported successfully!");
    } catch (err) { console.error("Import profile failed:", err); alert("Failed to import profile."); }
  }

  async function doChangePin() {
    setCpError(""); setCpSaved(false);
    if (!cpOld) { setCpError("Enter your current PIN."); return; }
    const stored = storedPinHash;
    const { verified } = await verifyPin(cpOld, stored);
    if (!verified) { setCpError("Current PIN is incorrect."); return; }
    if (cpNew.length < 4) { setCpError("New PIN must be at least 4 digits."); return; }
    if (!/^\d+$/.test(cpNew)) { setCpError("PIN must contain only numbers."); return; }
    if (cpNew !== cpConfirm) { setCpError("New PINs do not match."); return; }
    const newHash = await hashPin(cpNew);
    await invoke("cred_store", { key: "pinHash", value: newHash });
    setStoredPinHash(newHash);
    setCpOld(""); setCpNew(""); setCpConfirm("");
    setCpSaved(true);
    setTimeout(() => { setCpSaved(false); setChangePinMode(false); setProfileDropdownOpen(false); }, 2000);
  }

  function doSignOut() {
    setIsLocked(true);
  }

  async function doClearData() {
    const convCount = conversations.length;
    const name = profileName || "Unknown";
    if (!window.confirm(
      `This will permanently delete the profile "${name}" from this device.\n\n` +
      `Your ${convCount} conversation${convCount !== 1 ? "s" : ""} will remain but will no longer be protected by a PIN.\n\n` +
      `This cannot be undone. Continue?`
    )) return;
    if (!window.confirm("Are you absolutely sure? The profile and all credentials will be erased.")) return;
    try {
      const docsDir = await invoke("get_documents_dir");
      const logPath = docsDir + "\\LlamaTalk-deletion-log.txt";
      const entry = `[${new Date().toISOString()}] Profile "${name}" deleted. ${convCount} conversation${convCount !== 1 ? "s" : ""} retained.\n`;
      let existing = "";
      try { existing = await invoke("read_file_text", { path: logPath }); } catch { existing = ""; }
      await invoke("write_text_file", { path: logPath, content: existing + entry });
    } catch { /* silently ignore log errors */ }
    await Promise.all([
      invoke("cred_delete", { key: "pinHash" }),
      invoke("cred_delete", { key: "sqHash1" }),
      invoke("cred_delete", { key: "sqHash2" }),
      invoke("cred_delete", { key: "sqHash3" }),
      invoke("cred_delete", { key: "convEncKey" }),
    ]);
    setConvCryptoKey(null);
    localStorage.setItem("conversations", JSON.stringify(conversations)); // plaintext
    setStoredPinHash(null);
    setStoredSqHash1(null); setStoredSqHash2(null); setStoredSqHash3(null);
    localStorage.removeItem("profileName");
    localStorage.removeItem("sqIndex1"); localStorage.removeItem("sqIndex2"); localStorage.removeItem("sqIndex3");
    localStorage.removeItem("pinFrequency");
    localStorage.removeItem("lastUnlockTime");
    localStorage.removeItem("lastExportTime");
    setLastExportTime("");
    localStorage.setItem("profileSkipped", "false");
    setProfileName("");
    setChangePinMode(false);
    setSetupStep(1);
    setSq1(0); setSq2(1); setSq3(2);
    setSa1(""); setSa2(""); setSa3("");
    setPinFrequency("always"); setDraftPinFrequency("always");
    setShowProfileSetup(true);
    setIsLocked(false);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function handleTextareaChange(e) {
    setInput(e.target.value);
    const ta = textareaRef.current;
    if (ta) {
      ta.style.height = "auto";
      ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
    }
  }

  function getProvider(modelName) {
    if ((activeCloudModels.anthropic || []).includes(modelName)) return "anthropic";
    if ((activeCloudModels.google    || []).includes(modelName)) return "google";
    if ((activeCloudModels.openai    || []).includes(modelName)) return "openai";
    return "ollama";
  }

  async function callAnthropicApi(apiMessages, model, systemText, apiKey) {
    const msgs = apiMessages.filter((m) => m.role !== "system");
    const body = JSON.stringify({
      model,
      max_tokens: 8096,
      ...(systemText.trim() ? { system: systemText.trim() } : {}),
      messages: msgs,
      temperature,
    });
    const headers = JSON.stringify([
      ["x-api-key", apiKey],
      ["anthropic-version", "2023-06-01"],
      ["content-type", "application/json"],
    ]);
    const text = await invoke("external_api_post", {
      url: "https://api.anthropic.com/v1/messages", headers, body, timeoutSecs: 120,
    });
    const data = JSON.parse(text);
    return data.content[0].text;
  }

  async function callGeminiApi(apiMessages, model, systemText, apiKey) {
    const contents = apiMessages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    const body = JSON.stringify({
      ...(systemText.trim() ? { systemInstruction: { parts: [{ text: systemText.trim() }] } } : {}),
      contents,
      generationConfig: { temperature },
    });
    const headers = JSON.stringify([["content-type", "application/json"]]);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const text = await invoke("external_api_post", { url, headers, body, timeoutSecs: 120 });
    const data = JSON.parse(text);
    return data.candidates[0].content.parts[0].text;
  }

  async function callOpenAiApi(apiMessages, model, apiKey) {
    const body = JSON.stringify({ model, messages: apiMessages, temperature });
    const headers = JSON.stringify([
      ["Authorization", `Bearer ${apiKey}`],
      ["content-type", "application/json"],
    ]);
    const text = await invoke("external_api_post", {
      url: "https://api.openai.com/v1/chat/completions", headers, body, timeoutSecs: 120,
    });
    const data = JSON.parse(text);
    return data.choices[0].message.content;
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || isStreaming || !selectedModel) return;

    const capturedFile = attachedFile;
    const userMsg = {
      id: genId(), role: "user", content: text, ts: Date.now(),
      ...(capturedFile ? { attachment: { name: capturedFile.name, type: capturedFile.type } } : {}),
    };
    const asstId = genId();
    const asstMsg = { id: asstId, role: "assistant", content: "", ts: Date.now() };

    let convId = currentConvId;
    let updatedConvs;

    if (!convId) {
      const newConv = {
        id: genId(),
        title: text.slice(0, 42),
        createdAt: Date.now(),
        messages: [userMsg, asstMsg],
      };
      convId = newConv.id;
      updatedConvs = [newConv, ...conversations];
    } else {
      updatedConvs = conversations.map((c) =>
        c.id === convId
          ? {
              ...c,
              title: c.messages.length === 0 ? text.slice(0, 42) : c.title,
              messages: [...c.messages, userMsg, asstMsg],
            }
          : c
      );
    }

    setConversations(updatedConvs);
    setCurrentConvId(convId);
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setIsStreaming(true);
    setAttachedFile(null);

    // Build messages for API using only this conversation's prior messages + new user message
    const existingMessages = conversations.find((c) => c.id === convId)?.messages ?? [];
    const history = [...existingMessages, userMsg]
      .map((m) => ({ role: m.role, content: m.content }));

    // Inject file into the last (current) user message
    if (capturedFile && history.length > 0) {
      const last = history[history.length - 1];
      if (capturedFile.type === "image") {
        last.images = [capturedFile.content];
      } else if (capturedFile.type === "text") {
        last.content = `[File: ${capturedFile.name}]\n\`\`\`\n${capturedFile.content}\n\`\`\`\n\n${last.content}`;
      } else if (capturedFile.type === "pdf") {
        last.content = `[Attached PDF: ${capturedFile.name}]\n(PDF text extraction is not yet supported — please describe the content you want to discuss.)\n\n${last.content}`;
      } else if (capturedFile.type === "video") {
        last.content = `[Attached Video: ${capturedFile.name}]\n(Video files cannot be sent to the model — please describe what you want to discuss about the video.)\n\n${last.content}`;
      }
    }

    const apiMessages = [
      ...(systemPrompt.trim() ? [{ role: "system", content: systemPrompt.trim() }] : []),
      ...history,
    ];

    try {
      abortRef.current = new AbortController();
      const provider = getProvider(selectedModel);
      const streamId = genId();
      streamIdRef.current = streamId;

      // Build streaming request params based on provider
      let streamUrl, streamHeaders, streamBody, providerType;
      const baseUrl = normalizeUrl(modelServerMap[selectedModel] || ollamaUrl);
      const effectiveBackend = serverBackendMap[baseUrl] || backendType;

      if (provider === "ollama") {
        if (effectiveBackend === "openai-compatible") {
          providerType = "openai-compatible";
          streamUrl = `${baseUrl}/v1/chat/completions`;
          streamHeaders = JSON.stringify([["content-type", "application/json"]]);
          streamBody = JSON.stringify({ model: selectedModel, messages: apiMessages, stream: true, temperature, stream_options: { include_usage: true } });
        } else {
          providerType = "ollama";
          streamUrl = `${baseUrl}/api/chat`;
          streamHeaders = JSON.stringify([["content-type", "application/json"]]);
          streamBody = JSON.stringify({ model: selectedModel, messages: apiMessages, stream: true, options: { temperature } });
        }
      } else if (provider === "anthropic") {
        providerType = "anthropic";
        streamUrl = "https://api.anthropic.com/v1/messages";
        const msgs = apiMessages.filter((m) => m.role !== "system");
        streamHeaders = JSON.stringify([
          ["x-api-key", apiKeys.anthropic],
          ["anthropic-version", "2023-06-01"],
          ["content-type", "application/json"],
        ]);
        streamBody = JSON.stringify({
          model: selectedModel, max_tokens: 8096, messages: msgs, temperature, stream: true,
          ...(systemPrompt.trim() ? { system: systemPrompt.trim() } : {}),
        });
      } else if (provider === "google") {
        providerType = "google";
        streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${selectedModel}:streamGenerateContent?alt=sse&key=${apiKeys.google}`;
        const contents = apiMessages.filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
        streamHeaders = JSON.stringify([["content-type", "application/json"]]);
        streamBody = JSON.stringify({
          contents, generationConfig: { temperature },
          ...(systemPrompt.trim() ? { systemInstruction: { parts: [{ text: systemPrompt.trim() }] } } : {}),
        });
      } else if (provider === "openai") {
        providerType = "openai";
        streamUrl = "https://api.openai.com/v1/chat/completions";
        streamHeaders = JSON.stringify([
          ["Authorization", `Bearer ${apiKeys.openai}`],
          ["content-type", "application/json"],
        ]);
        streamBody = JSON.stringify({ model: selectedModel, messages: apiMessages, temperature, stream: true, stream_options: { include_usage: true } });
      }

      // Reset stream stats
      streamTokenCountRef.current = 0;
      streamStartRef.current = Date.now();
      setStreamStats(null);

      // Token buffer for wordDelay throttling
      let fullContent = "";
      let tokenQueue = [];
      let drainTimer = null;

      const updateContent = (newContent) => {
        setConversations((prev) =>
          prev.map((c) =>
            c.id === convId
              ? { ...c, messages: c.messages.map((m) => m.id === asstId ? { ...m, content: newContent } : m) }
              : c
          )
        );
      };

      // Listen for streaming events
      const unlistenToken = await listen("chat-token", (event) => {
        if (event.payload.id !== streamId) return;
        streamTokenCountRef.current++;
        const token = event.payload.token;
        if (wordDelay > 0) {
          tokenQueue.push(token);
          if (!drainTimer) {
            drainTimer = setInterval(() => {
              if (tokenQueue.length > 0) {
                fullContent += tokenQueue.shift();
                updateContent(fullContent);
              } else {
                clearInterval(drainTimer);
                drainTimer = null;
              }
            }, wordDelay);
          }
        } else {
          fullContent += token;
          updateContent(fullContent);
        }
      });

      const streamDone = new Promise((resolve, reject) => {
        let unDone, unErr;
        const cleanup = () => { unDone?.then?.(u => u()); unErr?.then?.(u => u()); };
        unDone = listen("chat-done", (event) => {
          if (event.payload.id !== streamId) return;
          cleanup();
          resolve();
        });
        unErr = listen("chat-error", (event) => {
          if (event.payload.id !== streamId) return;
          cleanup();
          reject(new Error(event.payload.error));
        });
      });

      // Listen for usage data from Rust
      let usageData = null;
      const unlistenUsage = await listen("chat-usage", (event) => {
        if (event.payload.id !== streamId) return;
        usageData = event.payload;
      });

      // Real-time TK/S update interval
      const tksInterval = setInterval(() => {
        const count = streamTokenCountRef.current;
        const elapsed = (Date.now() - streamStartRef.current) / 1000;
        if (count > 0 && elapsed > 0) {
          setStreamStats({ tokens: count, tks: (count / elapsed).toFixed(1) });
        }
      }, 250);

      // Fire the streaming request (runs in background on Rust side)
      invoke("stream_chat", {
        url: streamUrl, headers: streamHeaders, body: streamBody,
        providerType, streamId,
      }).catch(() => {}); // errors come through chat-error event

      // Wait for stream to finish
      try {
        await streamDone;
      } catch (err) {
        if (!abortRef.current.signal.aborted) throw err;
      }

      clearInterval(tksInterval);

      // Flush any remaining buffered tokens
      if (drainTimer) clearInterval(drainTimer);
      while (tokenQueue.length > 0) {
        fullContent += tokenQueue.shift();
      }
      updateContent(fullContent);

      unlistenToken();
      unlistenUsage();
      streamIdRef.current = null;

      // Compute final stats using actual API data when available
      if (usageData) {
        const outputTokens = usageData.output_tokens;
        let tks;
        if (usageData.eval_duration_ns && usageData.eval_duration_ns > 0) {
          tks = (outputTokens / (usageData.eval_duration_ns / 1e9)).toFixed(1);
        } else {
          const elapsed = (Date.now() - streamStartRef.current) / 1000;
          tks = elapsed > 0 ? (outputTokens / elapsed).toFixed(1) : "0.0";
        }
        setStreamStats({ tokens: outputTokens, tks });
      } else {
        // Fallback to event-counted tokens
        const count = streamTokenCountRef.current;
        const elapsed = (Date.now() - streamStartRef.current) / 1000;
        if (count > 0 && elapsed > 0) {
          setStreamStats({ tokens: count, tks: (count / elapsed).toFixed(1) });
        }
      }

      if (fullContent) {
        try {
          let granted = await isPermissionGranted();
          if (!granted) {
            const permission = await requestPermission();
            granted = permission === "granted";
          }
          if (granted) {
            const focused = await appWindow.isFocused().catch(() => true);
            if (!focused) {
              sendNotification({ title: "LlamaTalk Desktop", body: `${modelName || selectedModel} Responded!` });
            }
          }
        } catch {
          // Notifications not available, silently ignore
        }
      }
    } catch (err) {
      const errMsg = typeof err === "string" ? err : (err?.message || String(err));
      // Try to parse provider error body for a meaningful error message
      let displayErr = errMsg;
      try {
        const parsed = JSON.parse(errMsg);
        displayErr = parsed?.error?.message || parsed?.message || errMsg;
      } catch { /* not JSON */ }
      const errText = `Error: ${displayErr}`;
      setConversations((prev) =>
        prev.map((c) =>
          c.id === convId
            ? {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === asstId ? { ...m, content: errText } : m
                ),
              }
            : c
        )
      );
    } finally {
      setIsStreaming(false);
    }
  }

  const isCloudModel = selectedModel && getProvider(selectedModel) !== "ollama";
  const canSend = input.trim().length > 0 && !!selectedModel && !isStreaming &&
    (isCloudModel || ollamaStatus === "connected");

  // Show blank screen while credential store is loading to avoid flash of wrong state
  if (!credStoreLoaded) {
    return <div style={{ background: "var(--bg-base)", height: "100vh" }} />;
  }

  return (
    <div className="app-root">
      <div className="titlebar" data-tauri-drag-region>
        <div className="titlebar-right">
          {!showProfileSetup && !showOllamaSetup && !isLocked && (
            <div className="user-avatar-wrap" ref={profileDropdownRef}>
              <button
                className="user-avatar-btn"
                onClick={() => { setProfileDropdownOpen((v) => !v); if (profileDropdownOpen) setChangePinMode(false); }}
                title={profileName || "Profile"}
              >
                {profileName ? profileName[0].toUpperCase() : "?"}
              </button>
              {profileDropdownOpen && (
                <div className="user-dropdown">
                  <div className="user-dropdown-header">
                    <div className="user-dropdown-avatar-lg">
                      {profileName ? profileName[0].toUpperCase() : "?"}
                    </div>
                    <span className="user-dropdown-username">{profileName || "No profile"}</span>
                  </div>
                  <div className="user-dropdown-divider" />
                  {profileName ? (
                    <>
                      <button className="user-dropdown-item" onClick={() => { doLockApp(); setProfileDropdownOpen(false); }}>
                        Lock App
                      </button>
                      <button className="user-dropdown-item" onClick={() => setChangePinMode((v) => !v)}>
                        {changePinMode ? "Cancel PIN Change" : "Change PIN"}
                      </button>
                      {changePinMode && (
                        <div className="user-dropdown-pin-form">
                          <input className="profile-input profile-input-sm" type="password" inputMode="numeric" placeholder="Current PIN" value={cpOld} onChange={(e) => setCpOld(e.target.value.replace(/\D/g, ""))} maxLength={8} />
                          <input className="profile-input profile-input-sm" type="password" inputMode="numeric" placeholder="New PIN (4+ digits)" value={cpNew} onChange={(e) => setCpNew(e.target.value.replace(/\D/g, ""))} maxLength={8} />
                          <input className="profile-input profile-input-sm" type="password" inputMode="numeric" placeholder="Confirm New PIN" value={cpConfirm} onChange={(e) => setCpConfirm(e.target.value.replace(/\D/g, ""))} maxLength={8} onKeyDown={(e) => { if (e.key === "Enter") doChangePin(); }} />
                          {cpError && <div className="profile-error profile-error-sm">{cpError}</div>}
                          {cpSaved && <div className="profile-saved">PIN changed!</div>}
                          <button className="profile-settings-btn profile-settings-btn-accent" onClick={doChangePin}>Save New PIN</button>
                        </div>
                      )}
                      <button className="user-dropdown-item" onClick={() => { doExportProfile(); setProfileDropdownOpen(false); }}>
                        Export Profile &amp; Settings
                      </button>
                      <button className="user-dropdown-item" onClick={() => { doImportProfile(); setProfileDropdownOpen(false); }}>
                        Import Profile
                      </button>
                      <div className="user-dropdown-divider" />
                      <button className="user-dropdown-item" onClick={() => { doSignOut(); setProfileDropdownOpen(false); }}>
                        Sign Out
                      </button>
                      <button className="user-dropdown-item user-dropdown-item-danger" onClick={doClearData}>
                        Clear Data &amp; Users
                      </button>
                    </>
                  ) : (
                    <>
                      <button className="user-dropdown-item" onClick={() => { setShowProfileSetup(true); setProfileDropdownOpen(false); }}>
                        Set Up Profile
                      </button>
                      <button className="user-dropdown-item" onClick={() => { doImportProfile(); setProfileDropdownOpen(false); }}>
                        Import Profile
                      </button>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          <div className="titlebar-controls">
            <button className="titlebar-btn titlebar-minimize" onClick={() => appWindow.minimize()} title="Minimize">
              <IconMinimize />
            </button>
            <button className="titlebar-btn titlebar-maximize" onClick={() => appWindow.toggleMaximize()} title="Maximize">
              <IconMaximize />
            </button>
            <button className="titlebar-btn titlebar-close" onClick={() => appWindow.close()} title="Close">
              <IconClose />
            </button>
          </div>
        </div>
      </div>
    {showProfileSetup ? (
      <div className="profile-screen">
        {setupStep === 1 ? (
          <div className="profile-card">
            <div className="profile-logo-row"><LogoLlama /></div>
            <div className="profile-app-name">LlamaTalk</div>
            <div className="profile-title">Create Your Profile</div>
            <div className="profile-hint">Step 1 of 2 · Set your name and PIN</div>
            <input className="profile-input" placeholder="Your name" value={setupName} onChange={(e) => setSetupName(e.target.value)} autoFocus />
            <input className="profile-input" type="password" inputMode="numeric" placeholder="Create PIN (4+ digits)" value={setupPin} onChange={(e) => setSetupPin(e.target.value.replace(/\D/g, ""))} maxLength={8} />
            <input className="profile-input" type="password" inputMode="numeric" placeholder="Confirm PIN" value={setupPinConfirm} onChange={(e) => setSetupPinConfirm(e.target.value.replace(/\D/g, ""))} maxLength={8} onKeyDown={(e) => { if (e.key === "Enter") advanceSetup(); }} />
            {setupError && <div className="profile-error">{setupError}</div>}
            <button className="profile-btn" onClick={advanceSetup}>Continue →</button>
            <button className="profile-btn-secondary" onClick={doImportProfile}>Import Existing Profile</button>
            <button className="profile-btn-secondary" onClick={skipProfileSetup}>Skip for now</button>
          </div>
        ) : (
          <div className="profile-card profile-card-wide">
            <div className="profile-app-name">LlamaTalk</div>
            <div className="profile-title">Security Questions</div>
            <div className="profile-hint">Step 2 of 2 · These let you reset your PIN if forgotten</div>
            <div className="profile-sq-group">
              <select className="profile-sq-select" value={sq1} onChange={(e) => setSq1(Number(e.target.value))}>
                {SECURITY_QUESTIONS.map((q, i) => <option key={i} value={i}>{q}</option>)}
              </select>
              <input className="profile-input profile-input-sm" placeholder="Your answer" value={sa1} onChange={(e) => setSa1(e.target.value)} />
            </div>
            <div className="profile-sq-group">
              <select className="profile-sq-select" value={sq2} onChange={(e) => setSq2(Number(e.target.value))}>
                {SECURITY_QUESTIONS.map((q, i) => <option key={i} value={i}>{q}</option>)}
              </select>
              <input className="profile-input profile-input-sm" placeholder="Your answer" value={sa2} onChange={(e) => setSa2(e.target.value)} />
            </div>
            <div className="profile-sq-group">
              <select className="profile-sq-select" value={sq3} onChange={(e) => setSq3(Number(e.target.value))}>
                {SECURITY_QUESTIONS.map((q, i) => <option key={i} value={i}>{q}</option>)}
              </select>
              <input className="profile-input profile-input-sm" placeholder="Your answer" value={sa3} onChange={(e) => setSa3(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") doCreateProfile(); }} />
            </div>
            {sqError && <div className="profile-error">{sqError}</div>}
            <button className="profile-btn" onClick={doCreateProfile}>Create Profile</button>
            <button className="profile-btn-secondary" onClick={() => { setSetupStep(1); setSqError(""); }}>← Back</button>
          </div>
        )}
      </div>
    ) : showOllamaSetup ? (
      <div className="profile-screen">
        <div className="profile-card">
          <div className="profile-logo-row"><LogoLlama /></div>
          <div className="profile-app-name">LlamaTalk</div>
          <div className="profile-title">Connect to Local Server</div>
          <div className="profile-hint">Enter your local model server URL to get started</div>
          <div className="onboard-url-row">
            <input
              className="profile-input"
              value={onboardUrl}
              onChange={(e) => { setOnboardUrl(e.target.value); setOnboardCheckStatus("idle"); }}
              placeholder="http://localhost:11434"
              spellCheck={false}
              onKeyDown={(e) => { if (e.key === "Enter") onboardCheckConnection(); }}
              autoFocus
            />
            <div className="onboard-check-row">
              <button
                className="profile-btn"
                onClick={onboardCheckConnection}
                disabled={onboardCheckStatus === "checking"}
                style={{ marginBottom: 0 }}
              >
                {onboardCheckStatus === "checking" ? "Checking..." : "Check Connection"}
              </button>
              {onboardCheckStatus !== "idle" && (
                <span
                  className={`status-dot ${onboardCheckStatus === "ok" ? "connected" : onboardCheckStatus}`}
                  title={onboardCheckStatus === "ok" ? "Connected" : onboardCheckStatus === "error" ? "Cannot connect" : "Checking..."}
                />
              )}
            </div>
          </div>
          {onboardCheckStatus === "error" && (
            <div className="profile-error">Cannot connect. Make sure your local model server is running.</div>
          )}
          {onboardCheckStatus === "ok" && (
            <div className="profile-saved">Connected! Opening app...</div>
          )}
          <button className="profile-btn-secondary" onClick={skipOllamaSetup} style={{ marginTop: "6px" }}>
            Skip for now
          </button>
        </div>
      </div>
    ) : isLocked ? (
      <div className="profile-screen">
        {!forgotPinMode ? (
          <div className="profile-card">
            <div className="profile-logo-row"><LogoLlama /></div>
            <div className="profile-app-name">LlamaTalk</div>
            {profileName && <div className="profile-title">Welcome back, {profileName}</div>}
            <div className="profile-hint">Enter your PIN to continue</div>
            <input className="profile-input" type="password" inputMode="numeric" placeholder="PIN" value={lockPin} onChange={(e) => setLockPin(e.target.value.replace(/\D/g, ""))} maxLength={8} autoFocus onKeyDown={(e) => { if (e.key === "Enter") doUnlock(); }} />
            {lockError && <div className="profile-error">{lockError}</div>}
            <button className="profile-btn" onClick={doUnlock}>Unlock</button>
            {storedSqHash1 && (
              <button className="profile-btn-link" onClick={() => {
                setFpQuestionIndex(Math.floor(Math.random() * 3));
                setFpa1(""); setFpError("");
                setForgotPinMode(true); setLockError(""); setLockPin("");
              }}>Forgot your PIN?</button>
            )}
          </div>
        ) : !fpResetMode ? (
          <div className="profile-card">
            <div className="profile-app-name">LlamaTalk</div>
            <div className="profile-title">Reset PIN</div>
            <div className="profile-hint">Answer the security question below to reset your PIN</div>
            <div className="profile-sq-question-row">
              <div className="profile-sq-label">{SECURITY_QUESTIONS[Number(localStorage.getItem(`sqIndex${fpQuestionIndex + 1}`) ?? fpQuestionIndex)]}</div>
              <button className="fp-refresh-btn" onClick={refreshForgotQuestion} title="Try a different question"><IconRefresh /></button>
            </div>
            <input className="profile-input profile-input-sm" placeholder="Your answer" value={fpa1} onChange={(e) => setFpa1(e.target.value)} autoFocus onKeyDown={(e) => { if (e.key === "Enter") doVerifyForgotPin(); }} />
            {fpError && <div className="profile-error">{fpError}</div>}
            <button className="profile-btn" onClick={doVerifyForgotPin}>Verify Answer</button>
            <button className="profile-btn-secondary" onClick={() => { setForgotPinMode(false); setFpa1(""); setFpError(""); }}>← Back</button>
          </div>
        ) : (
          <div className="profile-card">
            <div className="profile-app-name">LlamaTalk</div>
            <div className="profile-title">New PIN</div>
            <div className="profile-hint">Create your new PIN</div>
            <input className="profile-input" type="password" inputMode="numeric" placeholder="New PIN (4+ digits)" value={fpNewPin} onChange={(e) => setFpNewPin(e.target.value.replace(/\D/g, ""))} maxLength={8} autoFocus />
            <input className="profile-input" type="password" inputMode="numeric" placeholder="Confirm new PIN" value={fpNewPinConfirm} onChange={(e) => setFpNewPinConfirm(e.target.value.replace(/\D/g, ""))} maxLength={8} onKeyDown={(e) => { if (e.key === "Enter") doResetPin(); }} />
            {fpError && <div className="profile-error">{fpError}</div>}
            <button className="profile-btn" onClick={doResetPin}>Set New PIN</button>
          </div>
        )}
      </div>
    ) : (
    <div className="layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <LogoLlama />
          <div className="sidebar-assistant-wrap">
            <span className="sidebar-assistant-label">Llama Assistant</span>
            <button
              className={`sidebar-assistant-btn${showAssistant ? " active" : ""}`}
              onClick={toggleAssistant}
              title={showAssistant ? "Hide Llama Assistant" : "Show Llama Assistant"}
            >
              <div className="sidebar-assistant-icon-wrap">
                <svg viewBox="0 0 36 28" width="22" height="17" fill="currentColor" shapeRendering="crispEdges">
                  <rect x="28" y="0" width="3" height="6" />
                  <rect x="23" y="4" width="10" height="7" />
                  <rect x="33" y="6" width="3" height="4" />
                  <rect x="17" y="9" width="9" height="8" />
                  <rect x="1" y="15" width="23" height="8" />
                  <rect x="0" y="15" width="3" height="5" />
                  <rect x="16" y="23" width="3" height="5" />
                  <rect x="11" y="23" width="3" height="5" />
                  <rect x="6" y="23" width="3" height="5" />
                  <rect x="1" y="23" width="3" height="5" />
                </svg>
                <span className="sidebar-assistant-plus">+</span>
              </div>
            </button>
          </div>
        </div>

        <div className="sidebar-tabs">
          <button
            className={`sidebar-tab ${activeTab === "chats" ? "active" : ""}`}
            onClick={() => setActiveTab("chats")}
          >
            Chats
          </button>
          <button
            className={`sidebar-tab ${activeTab === "settings" ? "active" : ""}`}
            onClick={() => setActiveTab("settings")}
          >
            Settings{updateAvailable && <span className="settings-update-badge">●</span>}
          </button>
        </div>

        {activeTab === "chats" ? (
          <>
            <button className="new-chat-btn" onClick={newConversation}>
              <IconPlus />
              New Chat
            </button>

            <div className="model-section">
              <div className="model-label">Model</div>
              <div className="model-select-row">
                <select
                  className="model-select"
                  value={selectedModel}
                  onChange={(e) => setSelectedModel(e.target.value)}
                  disabled={visibleModels.length === 0}
                >
                  {visibleModels.length === 0 && <option>No models found</option>}
                  {/* Local models */}
                  {models.filter((m) => !hiddenModels.includes(m)).length > 0 && (
                    <optgroup label="Local Models">
                      {models.filter((m) => !hiddenModels.includes(m)).map((m) => (
                        <option key={m} value={m}>{runningModels.has(m) ? `🟢 ${m}` : m}</option>
                      ))}
                    </optgroup>
                  )}
                  {/* Cloud models grouped by provider */}
                  {Object.entries(activeCloudModels).map(([provider, list]) => (
                    <optgroup key={provider} label={
                      provider === "anthropic" ? "Anthropic" :
                      provider === "google"    ? "Google"    : "OpenAI"
                    }>
                      {list.map((m) => <option key={m} value={m}>{m}</option>)}
                    </optgroup>
                  ))}
                </select>
                <span
                  className={`status-dot ${ollamaStatus}`}
                  title={
                    ollamaStatus === "connected"
                      ? "Local server connected"
                      : ollamaStatus === "error"
                      ? "Cannot reach local server"
                      : "Checking..."
                  }
                />
                <button className="refresh-btn" onClick={() => fetchModels()} title="Refresh models">
                  <IconRefresh />
                </button>
              </div>
            </div>

            {conversations.length > 0 && (
              <div className="conv-section-label">Chats</div>
            )}

            <div className="conv-list">
              {conversations.map((c) => (
                <div
                  key={c.id}
                  className={`conv-item ${c.id === currentConvId ? "active" : ""}`}
                  onClick={() => { if (editingConvId !== c.id) { setCurrentConvId(c.id); setInput(""); if (textareaRef.current) textareaRef.current.style.height = "auto"; } }}
                >
                  {editingConvId === c.id ? (
                    <input
                      className="conv-title-edit"
                      value={editingTitle}
                      onChange={(e) => setEditingTitle(e.target.value)}
                      onKeyDown={handleEditKeyDown}
                      onBlur={commitEdit}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                    />
                  ) : (
                    <>
                      <span className="conv-title">{c.title}</span>
                      <button
                        className="conv-edit"
                        onClick={(e) => startEditing(c, e)}
                        title="Rename"
                      >
                        <IconEdit />
                      </button>
                      <button
                        className="conv-export"
                        onClick={(e) => { e.stopPropagation(); exportChat(c); }}
                        title="Export"
                      >
                        <IconDownload />
                      </button>
                      <button
                        className="conv-delete"
                        onClick={(e) => deleteConversation(c.id, e)}
                        title="Delete"
                      >
                        <IconTrash />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          </>
        ) : (
          <div className="settings-panel">
            <div className="settings-label">Theme</div>
            <select
              className="settings-select"
              value={draftTheme}
              onChange={(e) => setDraftTheme(e.target.value)}
            >
              <option value="system">System</option>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
            </select>

            <div className="settings-divider" />

            <div className="settings-label">Server URL</div>
            <div className="settings-url-row">
              <input
                className="settings-input"
                value={draftOllamaUrl}
                onChange={(e) => setDraftOllamaUrl(e.target.value)}
                placeholder="http://localhost:11434"
                spellCheck={false}
              />
              <button
                className="check-btn"
                onClick={checkConnection}
                disabled={urlCheckStatus === "checking"}
              >
                {urlCheckStatus === "checking" ? "..." : "Connect"}
              </button>
              {urlCheckStatus !== "idle" && (
                <span
                  className={`status-dot ${urlCheckStatus === "ok" ? "connected" : urlCheckStatus}`}
                  title={
                    urlCheckStatus === "ok" ? "Connected"
                    : urlCheckStatus === "error" ? "Cannot connect"
                    : "Checking..."
                  }
                />
              )}
            </div>

            <div className="settings-label">Additional Local Servers</div>
            {localServers.length > 0 ? (
              <div className="settings-servers-list">
                {localServers.map((s) => (
                  <div key={s} className="settings-server-row">
                    <span className="settings-server-url">{s}</span>
                    <button className="settings-server-remove" onClick={() => {
                      const updated = localServers.filter((u) => u !== s);
                      setLocalServers(updated);
                      localStorage.setItem("localServers", JSON.stringify(updated));
                      fetchModels();
                    }}>Remove</button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="settings-models-empty">No additional servers</div>
            )}
            <div className="settings-url-row">
              <input
                className="settings-input"
                value={draftNewServerUrl}
                onChange={(e) => { setDraftNewServerUrl(e.target.value); setNewServerCheckStatus("idle"); }}
                placeholder="http://other-server:11434"
                spellCheck={false}
                onKeyDown={(e) => { if (e.key === "Enter") addServer(); }}
              />
              <button
                className="check-btn"
                onClick={addServer}
                disabled={newServerCheckStatus === "checking" || !draftNewServerUrl.trim()}
              >
                {newServerCheckStatus === "checking" ? "..." : "Add"}
              </button>
              {newServerCheckStatus !== "idle" && (
                <span
                  className={`status-dot ${newServerCheckStatus === "ok" ? "connected" : newServerCheckStatus}`}
                  title={newServerCheckStatus === "ok" ? "Added" : newServerCheckStatus === "error" ? "Cannot connect" : "Checking..."}
                />
              )}
            </div>

            <div className="settings-divider" />

            <div className="settings-label">Available Models</div>
            {models.length === 0 ? (
              <div className="settings-models-empty">No models — check connection above</div>
            ) : (
              <div className="settings-models-list">
                {models.map((m) => (
                  <div key={m} className="settings-model-row">
                    <span className="settings-model-name" title={m}>{m}</span>
                    <button
                      className={`settings-model-toggle ${hiddenModels.includes(m) ? "off" : "on"}`}
                      onClick={() => toggleModelVisibility(m)}
                    >
                      {hiddenModels.includes(m) ? "Hidden" : "Visible"}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="settings-divider" />
            <div className="settings-label">Temperature</div>
            <div className="settings-temp-row">
              <span className="settings-speed-label">0.0</span>
              <input
                type="range"
                className="settings-slider"
                min="0"
                max="1"
                step="0.05"
                value={draftTemperature}
                onChange={(e) => setDraftTemperature(Number(e.target.value))}
              />
              <span className="settings-speed-label">1.0</span>
              <span className="settings-temp-value">{draftTemperature.toFixed(2)}</span>
            </div>
            <div className="settings-temp-hint">Precise ←&nbsp;&nbsp;→ Creative</div>

            <div className="settings-divider" />
            <div className="settings-label">API Providers</div>
            {[
              { key: "anthropic", label: "Anthropic (Claude)", emoji: "🟣" },
              { key: "google",    label: "Google (Gemini)",    emoji: "🔵" },
              { key: "openai",    label: "OpenAI",             emoji: "🟢" },
            ].map(({ key, label, emoji }) => (
              <div key={key} className="settings-provider-block">
                <div className={`settings-provider-header${draftEnabledProviders[key] ? " open" : ""}`}>
                  <span className="settings-provider-label">{emoji} {label}</span>
                  <button
                    className={`settings-model-toggle ${draftEnabledProviders[key] ? "on" : "off"}`}
                    onClick={() => setDraftEnabledProviders((p) => ({ ...p, [key]: !p[key] }))}
                  >
                    {draftEnabledProviders[key] ? "On" : "Off"}
                  </button>
                </div>
                {draftEnabledProviders[key] && (
                  <input
                    type="password"
                    className="settings-input settings-api-key-input"
                    placeholder="Paste API key…"
                    value={draftApiKeys[key]}
                    onChange={(e) => setDraftApiKeys((p) => ({ ...p, [key]: e.target.value }))}
                    autoComplete="off"
                    spellCheck={false}
                  />
                )}
              </div>
            ))}
            <div className="settings-api-note">
              API keys are stored locally on this device only. They are sent exclusively
              to their respective AI provider over HTTPS and are never included in
              profile exports.
            </div>

            <div className="settings-divider" />
            <div className="settings-label">Model Display Name</div>
            <input
              className="settings-input"
              style={{ width: "160px" }}
              value={draftModelName}
              onChange={(e) => setDraftModelName(e.target.value)}
              placeholder="Model Nickname"
            />

            <div className="settings-label">Text Scroll Speed</div>
            <div className="settings-speed-row">
              <span className="settings-speed-label">Fast</span>
              <input
                type="range"
                className="settings-slider"
                min="0"
                max="80"
                step="5"
                value={draftWordDelay}
                onChange={(e) => setDraftWordDelay(Number(e.target.value))}
              />
              <span className="settings-speed-label">Slow</span>
            </div>

            <div className="settings-label">Chat Text Size</div>
            <div className="settings-size-btns">
              {["small", "medium", "large"].map((s) => (
                <button
                  key={s}
                  className={`settings-size-btn ${draftChatTextSize === s ? "active" : ""}`}
                  onClick={() => setDraftChatTextSize(s)}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>

            <div className="settings-label">{IS_MACOS ? "Dock" : "System Tray"}</div>
            <label className="settings-toggle-row">
              <input
                type="checkbox"
                checked={draftCloseMinimiesToTray}
                onChange={(e) => setDraftCloseMinimiesToTray(e.target.checked)}
              />
              <span>Close button minimizes to {IS_MACOS ? "Dock" : "tray"}</span>
            </label>

            <div className="settings-divider" />

            <div className="settings-label">PIN Requirement</div>
            <select
              className="settings-select"
              value={draftPinFrequency}
              onChange={(e) => setDraftPinFrequency(e.target.value)}
            >
              <option value="always">Every login (app startup)</option>
              <option value="30days">Every 30 days</option>
              <option value="never">Don&apos;t require PIN on this device</option>
            </select>

            <div className="settings-label">Base Prompt</div>
            <select
              className="settings-select"
              value={promptModelKey}
              onChange={(e) => setPromptModelKey(e.target.value)}
            >
              <option value="_default">Default (all models)</option>
              {models.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              {Object.values(activeCloudModels).flat().map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            <textarea
              className="base-prompt-textarea"
              value={draftPrompt}
              onChange={(e) => setDraftPrompt(e.target.value)}
              placeholder={promptModelKey === "_default" ? "Default system prompt for all models..." : `System prompt for ${promptModelKey}...`}
            />

            <button className="save-prompt-btn" onClick={saveSettings}>
              {settingsSaved ? "Saved!" : "Save Settings"}
            </button>

            <div className="settings-divider" />

            <button className="settings-export-btn" onClick={doExportProfile}>
              Export Profile &amp; Settings
            </button>
            <div className="settings-export-date">
              {lastExportTime
                ? `Last exported: ${new Date(Number(lastExportTime)).toLocaleString()}`
                : "Never exported"}
            </div>

            <div className="settings-update-section">
              <div className="settings-update-row">
                <span className="settings-update-label">Check for updates</span>
                <button
                  className={`settings-update-refresh-btn${updateStatus === "checking" ? " spinning" : ""}`}
                  onClick={checkForUpdate}
                  disabled={updateStatus === "checking"}
                  title="Check for updates"
                >
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="23 4 23 10 17 10"/>
                    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
                  </svg>
                </button>
              </div>
              {updateStatus === "checking" && (
                <div className="settings-update-info">Checking for updates…</div>
              )}
              {updateStatus === "up-to-date" && (
                <div className="settings-update-info success">✓ Up to date</div>
              )}
              {updateStatus && typeof updateStatus === "object" && !confirmingUpdate && (
                <div className="settings-update-available-row">
                  <span className="settings-update-info">Update available: v{updateStatus.version}</span>
                  <button className="settings-privacy-link" onClick={() => setConfirmingUpdate(true)}>Install →</button>
                </div>
              )}
              {updateStatus && typeof updateStatus === "object" && confirmingUpdate && (
                <div className="settings-update-info">
                  Install v{updateStatus.version}? The app will close.
                  <div className="settings-update-confirm-btns">
                    <button className="settings-privacy-link" onClick={() => applyUpdate(updateStatus.path)}>Yes, install</button>
                    <button className="settings-privacy-link" onClick={() => setConfirmingUpdate(false)}>Cancel</button>
                  </div>
                </div>
              )}
              {updateAvailable && !downloading && !downloadError && (
                <div className="settings-update-available-row">
                  <span className="settings-update-info">● v{updateAvailable.version} available</span>
                  <button className="settings-privacy-link" onClick={downloadAndInstall}>
                    {IS_MACOS ? "Download →" : "Download & Install →"}
                  </button>
                </div>
              )}
              {downloading && (
                <div className="settings-update-info">
                  {IS_MACOS 
                    ? `Downloading v${updateAvailable.version}… (will open DMG when done)`
                    : `Downloading v${updateAvailable.version}…`}
                </div>
              )}
              {downloadError && (
                <div className="settings-update-info" style={{ color: "var(--red, #ef4444)" }}>
                  {downloadError}
                </div>
              )}
            </div>

            <div className="settings-doc-links">
              <button className="settings-privacy-link" onClick={() => openDoc("LlamaTalk Goals.pdf")}>
                Our Goals →
              </button>
              <button className="settings-privacy-link" onClick={() => openDoc("LlamaTalk Privacy Policy.pdf")}>
                Privacy Policy →
              </button>
            </div>
          </div>
        )}
        <div className="sidebar-version">v{APP_VERSION} {IS_MACOS ? "macOS" : IS_WINDOWS ? "Windows" : ""}</div>
      </aside>

      {/* Main */}
      <main className="main">
        {ollamaStatus === "error" && (
          <div className="error-banner">
            <span>Cannot connect to local server. Make sure it's running.</span>
            <button className="error-retry" onClick={fetchModels}>Retry</button>
          </div>
        )}

        {currentConv && (
          <div className="chat-header">
            <span className="chat-header-title">{currentConv.title}</span>
            {currentConv.source === "assistant" && (
              <span className="chat-assistant-badge">via Llama Assistant</span>
            )}
            {messages.length > 0 && displayFrom < messages.length && (
              <button
                className="chat-clear-btn"
                onClick={() => setDisplayFrom(messages.length)}
                title="Clear display (history is kept)"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {messages.length === 0 ? (
          <div className="empty-state">
            <h2>What can I help you with?</h2>
            <p>Start a conversation with your local model.</p>
            {selectedModel && (
              <span className="empty-model-badge">{selectedModel}</span>
            )}
          </div>
        ) : (
          <div className="messages-wrap" onClick={() => setOpenMenuMsgId(null)}>
            <div className="messages-inner">
              {messages.slice(displayFrom).map((msg) => (
                <div key={msg.id} className={`message message-${msg.role}`}>
                  <div className="message-avatar">
                    {msg.role === "user" ? "U" : "AI"}
                  </div>
                  <div className="message-body">
                    <div className="message-role">
                      {msg.role === "user" ? "You" : (modelName || selectedModel)}
                    </div>
                    {msg.attachment && (
                      <div className="msg-attachment">
                        <IconPaperclip />
                        <span>{msg.attachment.name}</span>
                      </div>
                    )}
                    <div className="message-text">
                      {msg.content}
                      {isStreaming && msg.id === messages[messages.length - 1]?.id && msg.role === "assistant" && (
                        <LlamaRunning />
                      )}
                    </div>
                  </div>
                  {!isStreaming && (
                    <div className="msg-menu-wrap">
                      <button
                        className="msg-menu-btn"
                        onClick={(e) => { e.stopPropagation(); setOpenMenuMsgId(openMenuMsgId === msg.id ? null : msg.id); }}
                        title="Message options"
                      >⋮</button>
                      {openMenuMsgId === msg.id && (
                        <div className="msg-menu-dropdown" onClick={(e) => e.stopPropagation()}>
                          <button
                            className="msg-menu-item msg-menu-delete"
                            onClick={() => deleteMessage(msg.id)}
                          >Delete message</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>
          </div>
        )}

        <div className="input-area">
          {attachedFile && (
            <div className="file-chip-wrap">
              <div className="file-chip">
                <IconPaperclip />
                <span className="file-chip-name">{attachedFile.name}</span>
                <button className="file-chip-remove" onClick={() => setAttachedFile(null)} title="Remove">×</button>
              </div>
            </div>
          )}
          <div className="token-counter">
            <IconCoin />
            {streamStats ? (
              <span>{streamStats.tokens.toLocaleString()} tokens · {streamStats.tks} tk/s</span>
            ) : (
              <span>{contextTokens.toLocaleString()} tokens</span>
            )}
          </div>
          {selectedModel && (
            <div className="input-privacy-notice">
              {isCloudModel
                ? `Messages sent to ${getProvider(selectedModel) === "anthropic" ? "Anthropic" : getProvider(selectedModel) === "google" ? "Google" : "OpenAI"} — see their privacy policy`
                : "Messages sent only to your local server"}
            </div>
          )}
          <div className="input-wrap">
            <button
              className="attach-btn"
              onClick={attachFile}
              disabled={isStreaming || ollamaStatus !== "connected"}
              title="Attach file"
            >
              <IconPaperclip />
            </button>
            <textarea
              ref={textareaRef}
              className="chat-textarea"
              value={input}
              onChange={handleTextareaChange}
              onKeyDown={handleKeyDown}
              placeholder={
                ollamaStatus === "error"
                  ? "Local server is not running..."
                  : selectedModel
                  ? `Message ${modelName || selectedModel}...`
                  : "Select a model to start..."
              }
              disabled={!selectedModel || ollamaStatus !== "connected"}
              rows={1}
            />
            {isStreaming ? (
              <button className="stop-btn" onClick={stopStreaming} title="Stop generating">
                <IconStop />
              </button>
            ) : (
              <button className="send-btn" onClick={sendMessage} disabled={!canSend} title="Send (Enter)">
                <IconSend />
              </button>
            )}
          </div>
          <div className="input-hint">Enter to send · Shift+Enter for new line · Esc to stop</div>
        </div>
      </main>
    </div>
    )}
    </div>
  );
}
