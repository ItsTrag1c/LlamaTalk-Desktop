import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./index.css";

const DEFAULT_URL = "http://localhost:11434";
const assistantWindow = getCurrentWindow();

const ASSISTANT_SYSTEM_PROMPT = `Personality: Bubbly, enthusiastic, and always ready to help (or get into a little trouble). Llama is like a Microsoft Clippy, but with a bit more... personality. He's a free spirit, always bouncing around and looking for ways to make your day a little brighter (and maybe a little more interesting). Think like a Ted (the teddy bear from the Seth Myers movie) type of humor.Skills: Is a master of multitasking, able to juggle multiple tasks at once while still managing to look adorable and charming. He's also a whiz with words, able to come up with witty one-liners and clever comebacks on the fly. Now, let's get this llama party started! What's the first task you need help with, human?`;

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function LlamaAssistantSVG({ llamaState, mouthOpen }) {
  const isThinking = llamaState === "thinking";
  const isSpeaking = llamaState === "speaking";

  return (
    <span className={`llama-assistant-wrap${isSpeaking ? " speaking" : ""}`}>
      <svg
        viewBox="0 0 36 28"
        width="80"
        height="62"
        fill="#f97316"
        shapeRendering="crispEdges"
        style={{ overflow: "visible" }}
      >
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
        {/* Legs — static */}
        <rect x="16" y="23" width="3" height="5" />
        <rect x="11" y="23" width="3" height="5" />
        <rect x="6" y="23" width="3" height="5" />
        <rect x="1" y="23" width="3" height="5" />

        {/* Eye */}
        <rect x="30" y="6" width="2" height="2" fill="#1a1a1a" />

        {/* Eyebrow */}
        <rect
          className={`llama-eyebrow${isThinking ? " llama-eyebrow-thinking" : ""}`}
          x="29"
          y="4.5"
          width="4"
          height="0.8"
          fill="#c96442"
          style={{
            transform: isSpeaking ? "translateY(-1px)" : "translateY(0)",
            transition: "transform 0.3s ease",
          }}
        />

        {/* Mouth — prop-driven open/close */}
        <rect
          x="29"
          y={mouthOpen ? 8.5 : 9.2}
          width="4"
          height={mouthOpen ? 1.8 : 0.6}
          fill="#1a1a1a"
          style={{ transition: "height 0.1s ease" }}
        />
      </svg>
    </span>
  );
}

export default function AssistantApp() {
  const [ollamaUrl, setOllamaUrl] = useState(
    () => localStorage.getItem("ollamaUrl") || DEFAULT_URL
  );
  const [selectedModel, setSelectedModel] = useState(
    () => localStorage.getItem("selectedModel") || ""
  );
  const [modelNickname, setModelNickname] = useState(
    () => localStorage.getItem("modelNickname") || ""
  );
  // messages: { id, role, content }
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [llamaState, setLlamaState] = useState("idle");
  const [mouthOpen, setMouthOpen] = useState(false);
  // Track which main-app conversation this session is synced to
  const [sessionConvId, setSessionConvId] = useState(null);
  const [sessionStartTime, setSessionStartTime] = useState(null);

  const abortRef = useRef(null);
  const streamIdRef = useRef(null);
  const msgListRef = useRef(null);

  // Make window background transparent
  useEffect(() => {
    document.documentElement.style.background = "transparent";
    document.body.style.background = "transparent";
  }, []);

  // Auto-scroll message list to bottom when messages change
  useEffect(() => {
    if (msgListRef.current) {
      msgListRef.current.scrollTop = msgListRef.current.scrollHeight;
    }
  }, [messages]);

  // Sync config changes from main window via storage events
  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === "ollamaUrl") setOllamaUrl(e.newValue || DEFAULT_URL);
      if (e.key === "selectedModel") setSelectedModel(e.newValue || "");
      if (e.key === "modelNickname") setModelNickname(e.newValue || "");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Apply theme from localStorage
  useEffect(() => {
    function applyTheme(t) {
      const resolved =
        t === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "light"
          : t;
      document.documentElement.setAttribute("data-theme", resolved);
    }
    const theme = localStorage.getItem("theme") || "system";
    applyTheme(theme);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onMqChange = () => {
      if ((localStorage.getItem("theme") || "system") === "system") applyTheme("system");
    };
    mq.addEventListener("change", onMqChange);
    return () => mq.removeEventListener("change", onMqChange);
  }, []);

  // Toggle mouth open/close while speaking
  useEffect(() => {
    if (llamaState !== "speaking") {
      setMouthOpen(false);
      return;
    }
    const id = setInterval(() => setMouthOpen((v) => !v), 180);
    return () => clearInterval(id);
  }, [llamaState]);

  // Intercept window close → hide instead of destroy
  useEffect(() => {
    let unlisten;
    assistantWindow
      .onCloseRequested((e) => {
        e.preventDefault();
        hideAssistant();
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, []);

  function hideAssistant() {
    invoke("hide_assistant_window").catch(() => {});
    invoke("set_assistant_checked", { checked: false }).catch(() => {});
    localStorage.setItem("showAssistant", "false");
  }

  // Sync the current conversation to the main app via a dedicated localStorage key.
  // The main app listens for changes to "assistantSyncedConv" and merges it into
  // the conversations list. This avoids race conditions with the main conversations array.
  function syncToMainApp(msgs, convId, startTime) {
    const firstUserMsg = msgs.find((m) => m.role === "user");
    const convData = {
      id: convId,
      title: `\uD83E\uDD99 ${(firstUserMsg?.content || "Assistant Chat").slice(0, 36)}`,
      createdAt: startTime,
      messages: msgs,
      source: "assistant",
    };
    localStorage.setItem("assistantSyncedConv", JSON.stringify(convData));
  }

  async function sendMessage() {
    if (!input.trim() || !selectedModel || isStreaming) return;

    const inputText = input.trim();
    const userMsgId = genId();
    const asstMsgId = genId();

    // Get or create session conversation ID
    let convId = sessionConvId;
    let startTime = sessionStartTime;
    if (!convId) {
      convId = genId();
      startTime = Date.now();
      setSessionConvId(convId);
      setSessionStartTime(startTime);
    }

    const userMsg = { id: userMsgId, role: "user", content: inputText };
    const asstMsg = { id: asstMsgId, role: "assistant", content: "" };
    const updatedMessages = [...messages, userMsg, asstMsg];

    setMessages(updatedMessages);
    setInput("");
    setIsStreaming(true);
    setLlamaState("thinking");
    abortRef.current = new AbortController();

    try {
      const wordDelayMs = Number(localStorage.getItem("wordDelay") ?? 20);
      const bt = localStorage.getItem("backendType") || "ollama";

      // Build API messages from all completed exchanges (exclude empty assistant placeholder)
      const history = updatedMessages
        .filter((m) => !(m.id === asstMsgId))
        .map((m) => ({ role: m.role, content: m.content }));
      const apiMessages = [
        { role: "system", content: ASSISTANT_SYSTEM_PROMPT },
        ...history,
      ];

      const streamId = genId();
      streamIdRef.current = streamId;

      let streamUrl, streamHeaders, providerType, streamBody;
      if (bt === "openai-compatible") {
        providerType = "openai-compatible";
        streamUrl = `${ollamaUrl}/v1/chat/completions`;
        streamHeaders = JSON.stringify([["content-type", "application/json"]]);
        streamBody = JSON.stringify({ model: selectedModel, messages: apiMessages, stream: true });
      } else {
        providerType = "ollama";
        streamUrl = `${ollamaUrl}/api/chat`;
        streamHeaders = JSON.stringify([["content-type", "application/json"]]);
        streamBody = JSON.stringify({ model: selectedModel, messages: apiMessages, stream: true });
      }

      let fullContent = "";
      let tokenQueue = [];
      let drainTimer = null;
      let speakingStarted = false;

      const updateContent = (newContent) => {
        setMessages((prev) =>
          prev.map((m) => (m.id === asstMsgId ? { ...m, content: newContent } : m))
        );
      };

      const unlistenToken = await listen("chat-token", (event) => {
        if (event.payload.id !== streamId) return;
        if (!speakingStarted) {
          speakingStarted = true;
          setLlamaState("speaking");
        }
        const token = event.payload.token;
        if (wordDelayMs > 0) {
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
            }, wordDelayMs);
          }
        } else {
          fullContent += token;
          updateContent(fullContent);
        }
      });

      const unlistenUsage = await listen("chat-usage", (event) => {
        if (event.payload.id !== streamId) return;
        // Usage data available — could be used for display in the future
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

      invoke("stream_chat", {
        url: streamUrl, headers: streamHeaders, body: streamBody,
        providerType, streamId,
      }).catch(() => {});

      try {
        await streamDone;
      } catch (err) {
        if (!abortRef.current.signal.aborted) throw err;
      }

      if (drainTimer) clearInterval(drainTimer);
      while (tokenQueue.length > 0) {
        fullContent += tokenQueue.shift();
      }
      updateContent(fullContent);

      unlistenToken();
      unlistenUsage();
      streamIdRef.current = null;

      // Sync completed conversation to main app
      const finalMsgs = updatedMessages.map((m) =>
        m.id === asstMsgId ? { ...m, content: fullContent } : m
      );
      syncToMainApp(finalMsgs, convId, startTime);
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === asstMsgId ? { ...m, content: "\u26A0 Could not reach server." } : m
        )
      );
    } finally {
      setIsStreaming(false);
      setLlamaState("idle");
    }
  }

  function stopStreaming() {
    abortRef.current?.abort();
    if (streamIdRef.current) {
      invoke("cancel_stream", { streamId: streamIdRef.current }).catch(() => {});
    }
    setIsStreaming(false);
    setLlamaState("idle");
  }

  function clearConversation() {
    setMessages([]);
    setSessionConvId(null);
    setSessionStartTime(null);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      sendMessage();
    }
    if (e.key === "Escape") stopStreaming();
  }

  const displayName = modelNickname || selectedModel;

  return (
    <div className="aw-root">
      {/* Drag handle — move and close the widget */}
      <div className="aw-drag-handle" data-tauri-drag-region>
        <span className="aw-drag-grip" data-tauri-drag-region>
          Llama Assistant
        </span>
        <div className="aw-drag-actions">
          {messages.length > 0 && (
            <button
              className="aw-drag-clear"
              onClick={clearConversation}
              title="Clear conversation"
            >Clear</button>
          )}
          <button className="aw-drag-close" onClick={hideAssistant} title="Hide">
            ×
          </button>
        </div>
      </div>

      {/* Llama + scrollable message list */}
      <div className="aw-top-row">
        <div className="aw-llama-wrap">
          <LlamaAssistantSVG llamaState={llamaState} mouthOpen={mouthOpen} />
        </div>

        <div className="aw-message-list" ref={msgListRef}>
          {messages.length === 0 ? (
            <div className="aw-empty">Ask me anything…</div>
          ) : (
            messages.map((msg) => (
              <div key={msg.id} className={`aw-msg aw-msg-${msg.role}`}>
                {msg.role === "user" && (
                  <span className="aw-msg-role">You</span>
                )}
                <span className="aw-msg-text">
                  {msg.role === "assistant" && !msg.content && llamaState === "thinking" ? (
                    <div className="aw-thinking">
                      <span /><span /><span />
                    </div>
                  ) : msg.content}
                </span>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Input bar */}
      <div className="aw-input-row">
        <input
          className="aw-input"
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            "Ask Llama Assistant…"
          }
          disabled={!selectedModel || isStreaming}
        />
        {isStreaming ? (
          <button className="aw-btn" onClick={stopStreaming} title="Stop">
            ■
          </button>
        ) : (
          <button
            className="aw-btn"
            onClick={sendMessage}
            disabled={!input.trim() || !selectedModel}
            title="Send (Enter)"
          >
            ▶
          </button>
        )}
      </div>
    </div>
  );
}
