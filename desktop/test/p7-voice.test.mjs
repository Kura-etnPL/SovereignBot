import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import test from "node:test";
import { DESKTOP_SETTINGS_SCHEMA } from "../src/main/services.js";

const read = (relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

function loadVoiceRuntime() {
    const context = { Event: class Event { constructor(type, init = {}) { this.type = type; Object.assign(this, init); } } };
    context.globalThis = context;
    vm.runInNewContext(read("../ui/voice-controller.js"), context, { filename: "voice-controller.js" });
    return context.SovereignVoice;
}

function button() {
    const listeners = new Map();
    return {
        disabled: false,
        classList: { add() {}, remove() {}, toggle() {} },
        setAttribute(name, value) { this[name] = value; },
        addEventListener(name, handler) { listeners.set(name, handler); },
        emit(name, event = {}) { listeners.get(name)?.(event); },
    };
}

function speechWindow({ recognition = true } = {}) {
    const recognitions = [];
    const utterances = [];
    class Recognition {
        constructor() { recognitions.push(this); }
        start() { this.started = true; }
        stop() { this.stopped = true; this.onend?.(); }
        abort() { this.aborted = true; }
    }
    class Utterance {
        constructor(text) { this.text = text; utterances.push(this); }
    }
    const host = {
        navigator: { language: "en-US" },
        speechSynthesis: {
            cancelCount: 0,
            speakCount: 0,
            cancel() { this.cancelCount += 1; },
            speak(utterance) { this.speakCount += 1; this.lastUtterance = utterance; },
        },
        SpeechSynthesisUtterance: Utterance,
    };
    if (recognition) host.SpeechRecognition = Recognition;
    return { host, recognitions, utterances };
}

function makeController(Voice, host, current = "conv_aaaaaaaaaaaaaaaa") {
    const composer = { value: "", events: 0, dispatchEvent() { this.events += 1; } };
    const statuses = [];
    const state = { current };
    const controller = Voice.createVoiceController({
        window: host,
        getConversationId: () => state.current,
        getComposer: () => composer,
        getSystemLocale: () => "en-US",
        setStatus: (value) => statuses.push(value),
    });
    return { controller, composer, statuses, state };
}

test("P7.1 settings are bounded, opt-in, and persisted without audio/session fields", () => {
    assert.deepEqual(DESKTOP_SETTINGS_SCHEMA.voiceLanguage, ["system", "zh-CN", "en"]);
    assert.equal(DESKTOP_SETTINGS_SCHEMA.speakReplies, "boolean");
    assert.equal(DESKTOP_SETTINGS_SCHEMA.voiceMuted, "boolean");
    const services = read("../src/main/services.js");
    const ipc = read("../src/main/lib/ipc-schema.js");
    const store = read("../src/main/conversation-store.js");
    for (const source of [services, ipc, store]) {
        assert.doesNotMatch(source, /MediaRecorder|getUserMedia|rawAudio|audioBlob|providerSession/i);
    }
    assert.match(ipc, /voiceLanguage/);
    assert.match(ipc, /speakReplies/);
    assert.match(ipc, /voiceMuted/);
    assert.match(store, /voiceEligible/);
});

test("P7.1 voice input handles unsupported and permission-denied environments", () => {
    const Voice = loadVoiceRuntime();
    const unsupported = makeController(Voice, speechWindow({ recognition: false }).host);
    const unsupportedButton = button();
    assert.equal(unsupported.controller.setupInput(unsupportedButton), false);
    assert.equal(unsupportedButton.disabled, true);
    assert.equal(unsupported.statuses.at(-1).code, "unsupported");

    const deniedWindow = speechWindow();
    const denied = makeController(Voice, deniedWindow.host);
    const deniedButton = button();
    assert.equal(denied.controller.setupInput(deniedButton), true);
    deniedWindow.recognitions[0].onerror({ error: "not-allowed" });
    assert.equal(denied.statuses.at(-1).code, "permission-denied");
    assert.equal(deniedButton["aria-pressed"], "false");
});

test("P7.1 push-to-talk routes transcript only to the currently open conversation and honors language", () => {
    const Voice = loadVoiceRuntime();
    const { host, recognitions } = speechWindow();
    const fixture = makeController(Voice, host);
    fixture.controller.setSettings({ voiceLanguage: "zh-CN" });
    const input = button();
    fixture.controller.setupInput(input);
    input.emit("pointerdown", { preventDefault() {} });
    const recognition = recognitions[0];
    assert.equal(recognition.lang, "zh-CN");
    recognition.onstart();
    recognition.onresult({ results: [[{ transcript: "你好" }]] });
    assert.equal(fixture.composer.value, "你好");
    fixture.state.current = "conv_bbbbbbbbbbbbbbbb";
    recognition.onresult({ results: [[{ transcript: "错误会话" }]] });
    assert.equal(fixture.composer.value, "你好");
    assert.equal(recognition.aborted, true);
});

test("P7.1 auto-speech is final-only, opt-in, deduplicated, bounded, muted, and stops", () => {
    const Voice = loadVoiceRuntime();
    const { host } = speechWindow();
    const fixture = makeController(Voice, host);
    fixture.controller.setSettings({ speakReplies: true, voiceLanguage: "en" });
    const old = { id: "msg_old", senderId: "coworker_a", text: "historical", voiceEligible: true };
    const internal = { id: "msg_internal", senderId: "coworker_a", text: "handoff details", voiceEligible: false };
    const final = { id: "msg_final", senderId: "coworker_a", text: "final answer", voiceEligible: true };
    fixture.controller.observeConversation("conv_aaaaaaaaaaaaaaaa", [old, internal]);
    assert.equal(host.speechSynthesis.speakCount, 0, "historical replies must not replay");
    fixture.controller.observeConversation("conv_aaaaaaaaaaaaaaaa", [old, internal, final]);
    assert.equal(host.speechSynthesis.speakCount, 1);
    fixture.controller.observeConversation("conv_aaaaaaaaaaaaaaaa", [old, internal, final]);
    assert.equal(host.speechSynthesis.speakCount, 1, "polling must not duplicate speech");
    assert.equal(fixture.controller.speakReply("conv_aaaaaaaaaaaaaaaa", internal), false);
    assert.equal(host.speechSynthesis.lastUtterance.lang, "en-US");

    const cappedHost = speechWindow().host;
    const capped = makeController(Voice, cappedHost);
    assert.equal(capped.controller.speakReply("conv_aaaaaaaaaaaaaaaa", {
        id: "msg_capped",
        senderId: "coworker_a",
        text: "word ".repeat(1_000),
        voiceEligible: true,
    }), true);
    assert.ok(cappedHost.speechSynthesis.lastUtterance.text.length <= Voice.MAX_SPOKEN_CHARS);

    fixture.controller.setSettings({ voiceMuted: true });
    assert.equal(host.speechSynthesis.cancelCount > 0, true);
    fixture.controller.observeConversation("conv_aaaaaaaaaaaaaaaa", [old, internal, final, { id: "msg_next", senderId: "coworker_a", text: "next", voiceEligible: true }]);
    assert.equal(host.speechSynthesis.speakCount, 1);
    fixture.controller.stop();
    assert.equal(host.speechSynthesis.cancelCount > 1, true);

    const restarted = makeController(Voice, host);
    restarted.controller.setSettings({ speakReplies: true });
    restarted.controller.observeConversation("conv_aaaaaaaaaaaaaaaa", [final]);
    assert.equal(host.speechSynthesis.speakCount, 1, "a new renderer must not replay history");
});

test("P7.1 UI keeps Voice Call independent and exposes one accessible settings/status path", () => {
    const html = read("../ui/index.html");
    const app = read("../ui/app.js");
    const runtime = read("../ui/voice-controller.js");
    assert.match(html, /voice-controller\.js/);
    assert.match(html, /id="voice-input"/);
    assert.match(app, /ensureVoiceSettingsCard/);
    assert.match(app, /voice-stop/);
    assert.match(app, /voiceEligible/);
    assert.match(app, /beforeunload/);
    assert.match(runtime, /aria-pressed/);
    assert.match(runtime, /conversation-switch/);
    assert.doesNotMatch(runtime, /voiceCall|telephony|RTCPeerConnection|MediaRecorder/i);
    assert.doesNotMatch(app, /voiceCall|telephony|RTCPeerConnection/i);
});
