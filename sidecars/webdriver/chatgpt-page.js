// Fixed read-only DOM projection for the ChatGPT Chat adapter. No cookies,
// storage, network APIs or arbitrary caller-supplied scripts are exposed.
export function readChatGPTPage() {
    if (location.protocol !== "https:" || !["chatgpt.com", "www.chatgpt.com"].includes(location.hostname))
        throw new Error("ChatGPT page projection requires the official host");
    const visible = el => el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none";
    const name = el => (el.getAttribute("aria-label") || el.innerText || [...(el.labels ?? [])].map(label => label.innerText).join(" ") || "").trim();
    const buttons = [...document.querySelectorAll("button,[role=button]")].filter(visible);
    const roles = [...document.querySelectorAll('[role="radio"],input[type="radio"]')];
    const selectedMode = roles.find(el => (el.getAttribute("aria-checked") === "true" || el.checked) && /^(聊天|Chat|工作|Work)$/.test(name(el)));
    const menuModels = [...document.querySelectorAll('[role="menuitemradio"]')];
    const modelId = text => /^GPT[- ]5\.6 Sol$/i.test(text) ? "sol" : /^GPT[- ]5\.6 Luna$/i.test(text) ? "gpt-5.6-luna" : undefined;
    const selected = menuModels.find(el => el.getAttribute("aria-checked") === "true");
    const messages = [...document.querySelectorAll('section[data-turn="assistant"]')].slice(-8).map(section => {
        const message = section.querySelector('[data-message-author-role="assistant"]');
        if (!message || !visible(message)) return undefined;
        const text = message.innerText || "";
        return { id: (message.getAttribute("data-message-id") || "").slice(0, 128), text: text.slice(0, 20_000), truncated: text.length > 20_000, complete: [...section.querySelectorAll('button[data-testid="copy-turn-action-button"]')].some(visible) };
    }).filter(Boolean);
    const notices = [...document.querySelectorAll('[role="alert"],[role="status"]')].filter(visible).map(el => el.innerText).join(" ").slice(0, 2000);
    const title = document.title || "";
    return { schema: "sovereignbot.chatgpt-page.v1", url: location.href,
        chatMode: selectedMode ? /^(聊天|Chat)$/.test(name(selectedMode)) : undefined,
        authenticated: buttons.some(el => /打开.*个人资料.*菜单|Open profile menu/i.test(name(el))),
        selectedModel: selected ? modelId(name(selected)) : undefined,
        availableModels: menuModels.map(el => modelId(name(el))).filter(Boolean),
        generating: buttons.some(el => /^(停止生成|停止流式传输|Stop generating|Stop streaming)$/.test(name(el))),
        challenge: /just a moment|verify you are human|验证.*人类|请稍候|请稍等/i.test(`${title} ${notices}`),
        capacityLimited: /usage limit|rate limit|too many requests|达到.*上限/i.test(notices),
        assistantMessages: messages };
}

export const CHATGPT_PAGE_SCRIPT = `return (${readChatGPTPage.toString()})();`;
