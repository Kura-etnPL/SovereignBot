import { CHATGPT_PAGE_SCRIPT } from "./chatgpt-page.js";
const ELEMENT_KEY = "element-6066-11e4-a52e-4f735466cecf";

const KEY_CODES = new Map([
    ["Enter", "\uE007"],
    ["NumpadEnter", "\uE007"],
    ["Tab", "\uE004"],
    ["Escape", "\uE00C"],
    ["Backspace", "\uE003"],
    ["Delete", "\uE017"],
    ["ArrowLeft", "\uE012"],
    ["ArrowUp", "\uE013"],
    ["ArrowRight", "\uE014"],
    ["ArrowDown", "\uE015"],
    ["Home", "\uE011"],
    ["End", "\uE010"],
    ["PageUp", "\uE00E"],
    ["PageDown", "\uE00F"],
    ["Space", " "],
]);

const SNAPSHOT_SCRIPT = String.raw`
return (() => {
  const MAX = 700;
  const interactiveSelector = [
    'a[href]', 'button', 'input', 'textarea', 'select', 'option',
    '[role]', '[tabindex]', '[contenteditable="true"]', 'summary', 'details'
  ].join(',');

  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const visible = (element) => {
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
    return element.getClientRects().length > 0;
  };
  const roleOf = (element) => {
    const explicit = clean(element.getAttribute('role'));
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = element.tagName.toLowerCase();
    if (tag === 'a' && element.hasAttribute('href')) return 'link';
    if (tag === 'button' || tag === 'summary') return 'button';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return element.multiple ? 'listbox' : 'combobox';
    if (tag === 'input') {
      const type = (element.type || 'text').toLowerCase();
      if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      return 'textbox';
    }
    if (element.isContentEditable) return 'textbox';
    return tag;
  };
  const nameOf = (element) => {
    const aria = clean(element.getAttribute('aria-label'));
    if (aria) return aria;
    const labelledBy = clean(element.getAttribute('aria-labelledby'));
    if (labelledBy) {
      const text = labelledBy.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(node => clean(node.textContent)).filter(Boolean).join(' ');
      if (text) return clean(text);
    }
    if (element.labels && element.labels.length) {
      const text = Array.from(element.labels).map(label => clean(label.textContent)).filter(Boolean).join(' ');
      if (text) return clean(text);
    }
    const alt = clean(element.getAttribute('alt'));
    if (alt) return alt;
    const placeholder = clean(element.getAttribute('placeholder'));
    if (placeholder) return placeholder;
    const title = clean(element.getAttribute('title'));
    if (title) return title;
    const value = ['button', 'submit', 'reset'].includes((element.type || '').toLowerCase()) ? clean(element.value) : '';
    if (value) return value;
    return clean(element.innerText || element.textContent);
  };

  const output = [];
  for (const element of document.querySelectorAll(interactiveSelector)) {
    if (output.length >= MAX) break;
    if (!visible(element)) continue;
    output.push({
      element,
      role: roleOf(element),
      name: nameOf(element),
      type: clean(element.getAttribute('type')) || undefined,
      disabled: Boolean(element.disabled || element.getAttribute('aria-disabled') === 'true'),
    });
  }
  return { url: location.href, title: document.title, elements: output };
})();`;

const VISIBLE_TEXT_SCRIPT = String.raw`
return String(document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(-16000);`;

function endpointUrl(base, path) {
    return `${String(base).replace(/\/$/, "")}${path}`;
}

function browserCapabilities({ browser, profileDir, headless, proxyUrl, browserBinary }) {
    const browserName = browser === "edge" ? "MicrosoftEdge" : browser;
    const alwaysMatch = { browserName };
    const proxy = new URL(proxyUrl);
    const proxyAddress = `${proxy.hostname}:${proxy.port}`;

    if (browser === "chrome" || browser === "edge") {
        const args = [
            `--user-data-dir=${profileDir}`,
            `--proxy-server=${proxyUrl}`,
            "--proxy-bypass-list=<-loopback>",
            "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--no-first-run",
            "--no-default-browser-check",
            "--window-size=1440,900",
        ];
        if (headless)
            args.push("--headless=new");
        const options = { args };
        if (browserBinary)
            options.binary = browserBinary;
        alwaysMatch[browser === "edge" ? "ms:edgeOptions" : "goog:chromeOptions"] = options;
    }
    else if (browser === "firefox") {
        const args = ["-profile", profileDir];
        if (headless)
            args.unshift("-headless");
        const options = {
            args,
            prefs: {
                "media.peerconnection.enabled": false,
                "network.proxy.no_proxies_on": "",
            },
        };
        if (browserBinary)
            options.binary = browserBinary;
        alwaysMatch["moz:firefoxOptions"] = options;
        alwaysMatch.proxy = {
            proxyType: "manual",
            httpProxy: proxyAddress,
            sslProxy: proxyAddress,
            noProxy: [],
        };
    }
    else {
        throw new Error(`unsupported WebDriver browser: ${browser}`);
    }
    return { capabilities: { alwaysMatch } };
}

export class WebDriverClient {
    #endpoint;
    #profileDir;
    #browser;
    #headless;
    #proxyUrl;
    #browserBinary;
    #sessionId;
    #timeoutMs;

    constructor({ endpoint, profileDir, browser = "chrome", headless = false, proxyUrl, browserBinary, timeoutMs = 30_000 }) {
        this.#endpoint = endpoint;
        this.#profileDir = profileDir;
        this.#browser = browser;
        this.#headless = headless;
        this.#proxyUrl = proxyUrl;
        this.#browserBinary = browserBinary;
        this.#timeoutMs = timeoutMs;
    }

    get sessionId() {
        return this.#sessionId;
    }

    async start() {
        if (this.#sessionId)
            return this.#sessionId;
        const payload = browserCapabilities({
            browser: this.#browser,
            profileDir: this.#profileDir,
            headless: this.#headless,
            proxyUrl: this.#proxyUrl,
            browserBinary: this.#browserBinary,
        });
        const result = await this.#request("POST", "/session", payload, false);
        const sessionId = result?.sessionId ?? result?.value?.sessionId;
        if (!sessionId)
            throw new Error("WebDriver did not return a session id");
        this.#sessionId = sessionId;
        return sessionId;
    }

    async quit() {
        const sessionId = this.#sessionId;
        this.#sessionId = undefined;
        if (!sessionId)
            return;
        try {
            await this.#request("DELETE", `/session/${encodeURIComponent(sessionId)}`, undefined, false);
        }
        catch {
            // Session teardown is best-effort during shutdown. The driver process is also terminated.
        }
    }

    async currentUrl() {
        await this.start();
        return this.#request("GET", this.#sessionPath("/url"));
    }

    async navigate(url) {
        await this.start();
        await this.#request("POST", this.#sessionPath("/url"), { url });
        return { url: await this.currentUrl() };
    }

    async snapshot() {
        await this.start();
        const value = await this.execute(SNAPSHOT_SCRIPT, []);
        const rows = Array.isArray(value?.elements) ? value.elements : [];
        return {
            url: value?.url ?? await this.currentUrl(),
            title: value?.title ?? "",
            elements: rows.map((row) => {
                const elementId = row?.element?.[ELEMENT_KEY] ?? row?.element?.ELEMENT;
                if (!elementId)
                    return undefined;
                return {
                    elementId,
                    role: String(row.role ?? "generic"),
                    name: String(row.name ?? ""),
                    type: row.type ? String(row.type) : undefined,
                    disabled: Boolean(row.disabled),
                };
            }).filter(Boolean),
        };
    }

    async visibleText() {
        await this.start();
        const value = await this.execute(VISIBLE_TEXT_SCRIPT, []);
        return String(value ?? "").slice(-16000);
    }

    async chatGPTPage() {
        await this.start();
        return this.execute(CHATGPT_PAGE_SCRIPT, []);
    }

    async click(elementId) {
        await this.start();
        await this.#request("POST", this.#sessionPath(`/element/${encodeURIComponent(elementId)}/click`), {});
        return { clicked: true };
    }

    async type(elementId, text) {
        await this.start();
        const value = [...String(text)];
        await this.#request("POST", this.#sessionPath(`/element/${encodeURIComponent(elementId)}/value`), {
            text: String(text),
            value,
        });
        return { typed: true, characters: value.length };
    }

    async key(elementId, key) {
        await this.start();
        let target = elementId;
        if (!target) {
            const active = await this.#request("GET", this.#sessionPath("/element/active"));
            target = active?.[ELEMENT_KEY] ?? active?.ELEMENT;
        }
        if (!target)
            throw new Error("WebDriver did not provide an active element for key input");
        const text = KEY_CODES.get(key) ?? String(key);
        await this.#request("POST", this.#sessionPath(`/element/${encodeURIComponent(target)}/value`), {
            text,
            value: [...text],
        });
        return { pressed: true };
    }

    async scroll({ deltaX = 0, deltaY = 0 } = {}) {
        await this.start();
        await this.execute("window.scrollBy(arguments[0], arguments[1]); return {x: window.scrollX, y: window.scrollY};", [deltaX, deltaY]);
        return { scrolled: true, deltaX, deltaY };
    }

    async execute(script, args = []) {
        await this.start();
        return this.#request("POST", this.#sessionPath("/execute/sync"), { script, args });
    }

    #sessionPath(suffix) {
        if (!this.#sessionId)
            throw new Error("WebDriver session is not started");
        return `/session/${encodeURIComponent(this.#sessionId)}${suffix}`;
    }

    async #request(method, path, body, unwrap = true) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
        try {
            const response = await fetch(endpointUrl(this.#endpoint, path), {
                method,
                headers: body === undefined ? undefined : { "content-type": "application/json" },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });
            const text = await response.text();
            let payload;
            try {
                payload = text ? JSON.parse(text) : {};
            }
            catch {
                throw new Error(`WebDriver returned non-JSON status ${response.status}`);
            }
            const value = payload?.value;
            if (!response.ok || value?.error) {
                const errorName = value?.error ?? `HTTP ${response.status}`;
                const message = value?.message ? String(value.message).slice(0, 1200) : "WebDriver request failed";
                throw new Error(`${errorName}: ${message}`);
            }
            return unwrap ? (payload?.value ?? payload) : payload;
        }
        finally {
            clearTimeout(timeout);
        }
    }
}

export { ELEMENT_KEY };
