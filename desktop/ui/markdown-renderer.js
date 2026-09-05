"use strict";

/**
 * SovereignMarkdown - Ultra-fast, secure Markdown & Thought Engine
 * Formats Markdown, code blocks with syntax highlighting & copy buttons,
 * and collapsible <think> thought-process inspection cards (Manus/Grok style).
 */
(function (global) {
  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // Lightweight syntax token highlight for popular code blocks
  function highlightCode(code, lang) {
    const escaped = escapeHtml(code);
    if (!lang) return escaped;

    const lower = lang.toLowerCase();
    // Keywords for JS/TS, Python, Bash, JSON, SQL, etc.
    if (/^(js|javascript|ts|typescript|json|jsx|tsx|py|python|sh|bash|zsh|sql|html|css)$/.test(lower)) {
      return escaped
        // Comments
        .replace(/(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)/g, '<span class="tok-comment">$1</span>')
        // Strings
        .replace(/(&quot;[\s\S]*?&quot;|&#39;[\s\S]*?&#39;|`[\s\S]*?`)/g, '<span class="tok-string">$1</span>')
        // Numbers
        .replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>')
        // Keywords
        .replace(/\b(const|let|var|function|return|if|else|for|while|import|export|from|class|extends|async|await|try|catch|def|self|None|True|False|elif|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|table)\b/g, '<span class="tok-keyword">$1</span>')
        // Builtins & Booleans
        .replace(/\b(true|false|null|undefined|this|new|typeof|instanceof)\b/g, '<span class="tok-builtin">$1</span>');
    }
    return escaped;
  }

  function renderTable(tableText) {
    const lines = tableText.trim().split("\n");
    if (lines.length < 2) return tableText;

    const headers = lines[0].split("|").slice(1, -1).map(c => c.trim());
    const isDivider = /^[:\-\s|]+$/.test(lines[1]);
    if (!isDivider) return tableText;

    let html = '<div class="table-container"><table class="markdown-table"><thead><tr>';
    for (const h of headers) {
      html += `<th>${escapeHtml(h)}</th>`;
    }
    html += '</tr></thead><tbody>';

    for (let i = 2; i < lines.length; i++) {
      const row = lines[i].split("|").slice(1, -1);
      if (!row.length) continue;
      html += '<tr>';
      for (const c of row) {
        html += `<td>${renderInline(escapeHtml(c.trim()))}</td>`;
      }
      html += '</tr>';
    }
    html += '</tbody></table></div>';
    return html;
  }

  function renderInline(str) {
    let res = str;

    // Inline code `code`
    res = res.replace(/`([^`]+)`/g, (_, code) => `<code class="inline-code">${escapeHtml(code)}</code>`);

    // Bold **text** or __text__
    res = res.replace(/(\*\*|__)(.*?)\1/g, '<strong>$2</strong>');

    // Italic *text* or _text_
    res = res.replace(/(\*|_)(.*?)\1/g, '<em>$2</em>');

    // Strikethrough ~~text~~
    res = res.replace(/~~(.*?)~~/g, '<del>$1</del>');

    // Links [text](url)
    res = res.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, label, url) => {
      const cleanUrl = escapeHtml(url);
      return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="chat-link">${escapeHtml(label)} ↗</a>`;
    });

    return res;
  }

  function render(rawText) {
    if (!rawText) return "";
    let text = String(rawText);

    // 1. Process <think>...</think> blocks (DeepSeek / Manus / Grok reasoning streams)
    const thoughtBlocks = [];
    text = text.replace(/<think>([\s\S]*?)<\/think>/gi, (_, thoughts) => {
      const idx = thoughtBlocks.length;
      thoughtBlocks.push(thoughts.trim());
      return `@@THOUGHT_BLOCK_${idx}@@`;
    });

    // 2. Process Code Blocks ```lang ... ```
    const codeBlocks = [];
    text = text.replace(/```([a-zA-Z0-9_\-#+.]*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const idx = codeBlocks.length;
      codeBlocks.push({ lang: lang.trim() || "code", code: code.replace(/\n$/, "") });
      return `@@CODE_BLOCK_${idx}@@`;
    });

    // 3. Process Tables
    const tables = [];
    text = text.replace(/((?:\|[^\n]+\|\n?){2,})/g, (match) => {
      const html = renderTable(match);
      if (html === match) return match;
      tables.push(html);
      return `@@TABLE_BLOCK_${tables.length - 1}@@\n`;
    });

    // 4. Line-by-line block rendering
    const lines = text.split("\n");
    const output = [];
    let inList = false;
    let listType = null; // 'ul' or 'ol'
    let inBlockquote = false;

    for (let i = 0; i < lines.length; i++) {
      let line = lines[i];

      // Check placeholders
      if (line.includes("@@THOUGHT_BLOCK_") || line.includes("@@CODE_BLOCK_") || line.includes("@@TABLE_BLOCK_")) {
        if (inList) { output.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; listType = null; }
        if (inBlockquote) { output.push('</blockquote>'); inBlockquote = false; }
        output.push(escapeHtml(line));
        continue;
      }

      // Blockquotes
      if (line.startsWith("> ")) {
        if (inList) { output.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; listType = null; }
        if (!inBlockquote) {
          output.push('<blockquote class="chat-blockquote">');
          inBlockquote = true;
        }
        output.push(`<p>${renderInline(escapeHtml(line.slice(2)))}</p>`);
        continue;
      } else if (inBlockquote) {
        output.push('</blockquote>');
        inBlockquote = false;
      }

      // Headers # ## ### ####
      const headerMatch = line.match(/^(#{1,4})\s+(.+)$/);
      if (headerMatch) {
        if (inList) { output.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; listType = null; }
        const level = headerMatch[1].length;
        const content = renderInline(escapeHtml(headerMatch[2]));
        output.push(`<h${level} class="chat-h${level}">${content}</h${level}>`);
        continue;
      }

      // Horizontal Rule
      if (/^(\*\*\*|---|___)$/.test(line.trim())) {
        if (inList) { output.push(listType === 'ul' ? '</ul>' : '</ol>'); inList = false; listType = null; }
        output.push('<hr class="chat-hr" />');
        continue;
      }

      // Unordered list: - or *
      const ulMatch = line.match(/^[-*]\s+(.+)$/);
      if (ulMatch) {
        if (!inList || listType !== 'ul') {
          if (inList) output.push(listType === 'ul' ? '</ul>' : '</ol>');
          output.push('<ul class="chat-list">');
          inList = true;
          listType = 'ul';
        }
        output.push(`<li>${renderInline(escapeHtml(ulMatch[1]))}</li>`);
        continue;
      }

      // Ordered list: 1. 2.
      const olMatch = line.match(/^(\d+)\.\s+(.+)$/);
      if (olMatch) {
        if (!inList || listType !== 'ol') {
          if (inList) output.push(listType === 'ul' ? '</ul>' : '</ol>');
          output.push('<ol class="chat-list ordered">');
          inList = true;
          listType = 'ol';
        }
        output.push(`<li>${renderInline(escapeHtml(olMatch[2]))}</li>`);
        continue;
      }

      // Not in list
      if (inList) {
        output.push(listType === 'ul' ? '</ul>' : '</ol>');
        inList = false;
        listType = null;
      }

      // Empty line / paragraph
      if (!line.trim()) {
        output.push('<div class="chat-spacer"></div>');
      } else {
        output.push(`<p class="chat-p">${renderInline(escapeHtml(line))}</p>`);
      }
    }

    if (inList) output.push(listType === 'ul' ? '</ul>' : '</ol>');
    if (inBlockquote) output.push('</blockquote>');

    let finalHtml = output.join("\n");
    tables.forEach((html, idx) => {
      finalHtml = finalHtml.replace(`@@TABLE_BLOCK_${idx}@@`, () => html);
    });

    // Replace code blocks
    codeBlocks.forEach((item, idx) => {
      const codeHtml = highlightCode(item.code, item.lang);
      const replacement = `
        <div class="code-block" data-lang="${escapeHtml(item.lang)}">
          <div class="code-header">
            <span class="code-lang">${escapeHtml(item.lang)}</span>
            <button type="button" class="code-copy-btn" data-code="${escapeHtml(item.code)}" title="Copy code">
              <span class="copy-icon">⎘</span>
              <span class="copy-label">Copy</span>
            </button>
          </div>
          <pre><code class="language-${escapeHtml(item.lang)}">${codeHtml}</code></pre>
        </div>
      `;
      finalHtml = finalHtml.replace(`@@CODE_BLOCK_${idx}@@`, () => replacement);
    });

    // Replace thought blocks (Manus/Grok style collapsible thinking card)
    thoughtBlocks.forEach((thoughtText, idx) => {
      const formattedThought = renderInline(escapeHtml(thoughtText));
      const replacement = `
        <details class="thought-container" open>
          <summary class="thought-summary">
            <div class="thought-title-group">
              <span class="thought-orb"></span>
              <span class="thought-title">Thought Process · 深度思考</span>
            </div>
            <span class="thought-chevron">▾</span>
          </summary>
          <div class="thought-body">${formattedThought}</div>
        </details>
      `;
      finalHtml = finalHtml.replace(`@@THOUGHT_BLOCK_${idx}@@`, () => replacement);
    });

    return finalHtml;
  }

  global.SovereignMarkdown = {
    renderInto(node, rawText) {
      const template = document.createElement("template");
      template.innerHTML = render(rawText);
      const tags = new Set(["DIV", "SPAN", "P", "STRONG", "EM", "DEL", "CODE", "PRE", "A", "BUTTON", "DETAILS", "SUMMARY", "H1", "H2", "H3", "H4", "UL", "OL", "LI", "HR", "BLOCKQUOTE", "TABLE", "THEAD", "TBODY", "TR", "TH", "TD"]);
      for (const element of template.content.querySelectorAll("*")) {
        if (!tags.has(element.tagName)) { element.replaceWith(document.createTextNode(element.textContent)); continue; }
        for (const attribute of [...element.attributes]) {
          if (!["class", "href", "target", "rel", "type", "title", "data-code", "data-lang", "open"].includes(attribute.name)) element.removeAttribute(attribute.name);
        }
        if (element.hasAttribute("href") && !/^https?:\/\//i.test(element.getAttribute("href"))) element.removeAttribute("href");
      }
      node.replaceChildren(template.content);
    },
    render,
    escapeHtml,
    highlightCode
  };
})(window);
