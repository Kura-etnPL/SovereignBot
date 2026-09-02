"use strict";

// Local renderer voice boundary. This file intentionally uses only Web Speech /
// OS speech exposed by Chromium. It never records, uploads, or persists audio.
(function installSovereignVoice(root) {
  const MAX_SPOKEN_CHARS = 1_200;
  const MAX_OBSERVED_MESSAGES = 2_000;
  const SENSITIVE_LINE = /(?:^|\n)\s*(?:system|attention|handoff|provider(?:\s+(?:id|token|metadata))?|secret|credential|password|api[_ -]?key|session(?:\s*id)?|cwd|workspace(?:\s+path)?)\s*[:=]/i;

  function normalizeSpeechText(value, limit = MAX_SPOKEN_CHARS) {
    const text = String(value ?? "")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text || text.length <= limit) return text;
    const clipped = text.slice(0, Math.max(1, limit - 1));
    const boundary = Math.max(
      clipped.lastIndexOf("。"), clipped.lastIndexOf("."), clipped.lastIndexOf("!"),
      clipped.lastIndexOf("！"), clipped.lastIndexOf("?"), clipped.lastIndexOf("？"),
    );
    return `${clipped.slice(0, boundary > limit * 0.55 ? boundary + 1 : clipped.length).trim()}…`;
  }

  function isFinalReply(message) {
    if (!message || message.senderId === "user" || message.voiceEligible !== true || typeof message.id !== "string" || !message.id) return false;
    if (message.internal === true || message.system === true || message.status === "attention") return false;
    if (message.replyKind !== undefined && message.replyKind !== "final") return false;
    if (["attention", "handoff", "internal", "review"].includes(message.kind)) return false;
    if (Array.isArray(message.mentions) && message.mentions.length) return false;
    if (Object.values(message.delivery ?? {}).some((entry) => entry?.status === "pending")) return false;
    const text = normalizeSpeechText(message.text);
    return Boolean(text) && !SENSITIVE_LINE.test(text);
  }

  function createVoiceController({
    window: browserWindow = root,
    getConversationId = () => undefined,
    getComposer = () => browserWindow?.document?.getElementById?.("composer-input"),
    getSystemLocale = () => browserWindow?.navigator?.language || "en-US",
    getContext,
    setStatus = () => {},
    maxChars = MAX_SPOKEN_CHARS,
  } = {}) {
    const state = {
      recognitionSupported: false,
      synthesisSupported: typeof browserWindow?.speechSynthesis === "object" && typeof browserWindow?.speechSynthesis?.speak === "function" && typeof browserWindow?.SpeechSynthesisUtterance === "function",
      listening: false,
      speaking: false,
      permission: "unknown",
      speakReplies: false,
      voiceLanguage: "system",
      voiceMuted: false,
      currentConversationId: undefined,
    };
    const observed = new Set();
    const spoken = new Set();
    let recognition;
    let button;
    let held = false;
    let recognitionConversationId;
    let speakingButton;

    const doc = () => browserWindow?.document;
    const emit = (code, extra = {}) => { try { setStatus({ code, ...extra }); } catch {} };
    const synthesis = () => browserWindow?.speechSynthesis;
    const Utterance = () => browserWindow?.SpeechSynthesisUtterance;
    const Recognition = () => browserWindow?.SpeechRecognition || browserWindow?.webkitSpeechRecognition;

    function context() {
      const supplied = getContext?.() || {};
      const conversationId = supplied.conversationId ?? getConversationId();
      return { ...supplied, ...(conversationId ? { conversationId } : {}), activeView: supplied.activeView ?? "conversation" };
    }

    function languageTag() {
      if (state.voiceLanguage === "zh-CN") return "zh-CN";
      if (state.voiceLanguage === "en") return "en-US";
      return String(getSystemLocale() || "en-US").toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
    }

    function updateButton() {
      if (!button) return;
      button.disabled = !state.recognitionSupported;
      button.classList?.toggle?.("recording", state.listening);
      button.setAttribute?.("aria-pressed", String(state.listening));
      button.textContent = state.listening ? "■" : "🎙";
      button.title = state.listening
        ? "Release to finish / 松开完成"
        : state.recognitionSupported ? "Hold to talk / 按住说话" : "Voice input unavailable / 当前环境不支持语音输入";
    }

    function clearSpeakingButton() {
      speakingButton?.classList?.remove?.("speaking");
      speakingButton = undefined;
    }

    function stopSpeaking() {
      try { synthesis()?.cancel?.(); } catch {}
      state.speaking = false;
      clearSpeakingButton();
      updateButton();
    }

    function abortRecognition() {
      held = false;
      try { recognition?.abort?.(); } catch {}
      state.listening = false;
      updateButton();
    }

    function stop(reason = "stopped") {
      abortRecognition();
      stopSpeaking();
      emit(reason);
    }

    function inputError(code, message) {
      emit(code, { message });
      const error = doc()?.getElementById?.("composer-error");
      if (error && message) {
        error.textContent = message;
        error.classList?.remove?.("hidden");
      }
    }

    function startListening() {
      const conversationId = context().conversationId;
      if (!conversationId) {
        inputError("no-conversation", "Open a conversation before using voice / 请先打开会话再使用语音");
        return false;
      }
      if (state.voiceMuted) {
        inputError("muted", "Voice is muted / 语音已静音");
        return false;
      }
      if (!state.recognitionSupported || !recognition) {
        inputError("unsupported", "Voice input is unavailable in this environment / 当前环境不支持语音输入");
        return false;
      }
      if (state.listening) return true;
      recognitionConversationId = conversationId;
      held = true;
      recognition.lang = languageTag();
      try {
        recognition.start();
        return true;
      } catch (error) {
        held = false;
        if (error?.name !== "InvalidStateError") inputError("error", "Voice input could not start; check microphone permission / 语音输入无法启动，请检查麦克风权限");
        return false;
      }
    }

    function finishListening() {
      held = false;
      if (!state.listening) return;
      try { recognition?.stop?.(); } catch {}
    }

    function speakReply(conversationId, message, speakButton) {
      if (!isFinalReply(message) || state.voiceMuted || !state.synthesisSupported) return false;
      if (conversationId !== context().conversationId || context().activeView !== "conversation") return false;
      const text = normalizeSpeechText(message.text, maxChars);
      if (!text) return false;
      const key = `${conversationId}:${message.id}`;
      if (spoken.has(key)) return false;
      spoken.add(key);
      if (spoken.size > MAX_OBSERVED_MESSAGES) spoken.delete(spoken.values().next().value);
      stopSpeaking();
      const Constructor = Utterance();
      const utterance = new Constructor(text);
      utterance.lang = languageTag();
      state.speaking = true;
      speakingButton = speakButton;
      speakButton?.classList?.add?.("speaking");
      const clear = () => { state.speaking = false; clearSpeakingButton(); updateButton(); };
      utterance.onend = clear;
      utterance.onerror = clear;
      try {
        synthesis().speak(utterance);
        updateButton();
        return true;
      } catch {
        clear();
        return false;
      }
    }

    function setupInput(nextButton) {
      button = nextButton;
      const Constructor = Recognition();
      state.synthesisSupported = typeof synthesis() === "object" && typeof synthesis()?.speak === "function" && typeof Utterance() === "function";
      state.recognitionSupported = typeof Constructor === "function";
      if (state.recognitionSupported) {
        try { recognition = new Constructor(); } catch { state.recognitionSupported = false; }
      }
      if (!recognition) {
        updateButton();
        // This status is for the push-to-talk input surface. Read-aloud may
        // still be available when microphone recognition is not.
        emit("unsupported");
        return false;
      }
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onstart = () => { state.listening = true; state.permission = "granted"; updateButton(); emit("listening"); if (!held) finishListening(); };
      recognition.onresult = (event) => {
        const current = context().conversationId;
        if (!current || current !== recognitionConversationId) {
          stop("conversation-switch");
          return;
        }
        const transcript = [...(event?.results || [])].map((result) => result?.[0]?.transcript || "").join(" ").trim();
        if (!transcript) return;
        const composer = getComposer();
        if (!composer) return;
        const existing = String(composer.value || "").trim();
        composer.value = existing ? `${existing} ${transcript}` : transcript;
        const EventCtor = browserWindow?.Event || root?.Event;
        try { composer.dispatchEvent?.(typeof EventCtor === "function" ? new EventCtor("input", { bubbles: true }) : { type: "input", bubbles: true }); } catch {}
        emit("transcribed");
      };
      recognition.onerror = (event) => {
        if (event?.error === "not-allowed" || event?.error === "service-not-allowed") {
          state.permission = "denied";
          state.listening = false;
        }
        if (event?.error !== "aborted" && event?.error !== "no-speech") inputError(state.permission === "denied" ? "permission-denied" : "error", state.permission === "denied" ? "Voice permission was denied; allow the microphone and try again / 麦克风权限被拒绝，请允许后重试" : "Voice input needs permission or is unavailable / 语音输入需要权限或暂不可用");
        updateButton();
      };
      recognition.onend = () => { state.listening = false; updateButton(); };
      button?.addEventListener?.("pointerdown", (event) => { event.preventDefault?.(); startListening(); });
      button?.addEventListener?.("pointerup", finishListening);
      button?.addEventListener?.("pointercancel", finishListening);
      button?.addEventListener?.("pointerleave", finishListening);
      button?.addEventListener?.("keydown", (event) => { if ((event.key === " " || event.key === "Enter") && !event.repeat) { event.preventDefault?.(); startListening(); } });
      button?.addEventListener?.("keyup", (event) => { if (event.key === " " || event.key === "Enter") { event.preventDefault?.(); finishListening(); } });
      updateButton();
      emit("ready");
      return true;
    }

    function setSettings(settings = {}) {
      const voice = settings.voice && typeof settings.voice === "object" ? settings.voice : settings;
      if (typeof voice.speakReplies === "boolean") state.speakReplies = voice.speakReplies;
      const nextLanguage = voice.voiceLanguage ?? voice.language;
      if (["system", "zh-CN", "en"].includes(nextLanguage)) state.voiceLanguage = nextLanguage;
      const nextMuted = typeof voice.voiceMuted === "boolean" ? voice.voiceMuted : typeof voice.muted === "boolean" ? voice.muted : state.voiceMuted;
      if (nextMuted && !state.voiceMuted) stopSpeaking();
      state.voiceMuted = nextMuted;
      if (state.voiceMuted) emit("muted");
      else updateButton();
    }

    function observeConversation(conversationId, messages = []) {
      if (!conversationId || !Array.isArray(messages)) return;
      const switched = state.currentConversationId !== conversationId;
      if (switched) {
        stop("conversation-switch");
        state.currentConversationId = conversationId;
      }
      const candidates = [];
      for (const message of messages) {
        if (!message?.id) continue;
        const key = `${conversationId}:${message.id}`;
        if (observed.has(key)) continue;
        observed.add(key);
        if (!switched && state.speakReplies && !state.voiceMuted && isFinalReply(message)) candidates.push(message);
      }
      while (observed.size > MAX_OBSERVED_MESSAGES) observed.delete(observed.values().next().value);
      if (candidates.length) speakReply(conversationId, candidates.at(-1));
    }

    return Object.freeze({
      setupInput,
      setup: setupInput,
      setSettings,
      observeConversation,
      speakReply,
      stop,
      stopSpeaking,
      isFinalReply,
      getState: () => ({ ...state }),
    });
  }

  root.SovereignVoice = Object.freeze({ createVoiceController, normalizeSpeechText, isFinalReply, MAX_SPOKEN_CHARS });
})(typeof globalThis === "object" ? globalThis : window);
