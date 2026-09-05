import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";

const context = { window: {} };
runInNewContext(readFileSync(new URL("../ui/markdown-renderer.js", import.meta.url), "utf8"), context);
const { render } = context.window.SovereignMarkdown;

test("syntax highlighting never tokenizes its generated markup", () => {
  const { highlightCode } = context.window.SovereignMarkdown;
  assert.equal(highlightCode("const x = 2;", "js"), '<span class="tok-keyword">const</span> x = <span class="tok-number">2</span>;');
  assert.equal(highlightCode("'class 39 <img>'", "py"), '<span class="tok-string">&#39;class 39 &lt;img&gt;&#39;</span>');
  assert.equal(highlightCode("// class 2", "js"), '<span class="tok-comment">// class 2</span>');
});

test("inline code preserves operators and underscores without double escaping", () => {
  const html = render("`< 2` and `is_prime(n)` and `math_helper.py` and **`a_b`**");
  assert.ok(html.includes('<code class="inline-code">&lt; 2</code>'));
  assert.ok(html.includes('<code class="inline-code">is_prime(n)</code>'));
  assert.ok(html.includes('<code class="inline-code">math_helper.py</code>'));
  assert.ok(html.includes('<strong><code class="inline-code">a_b</code></strong>'));
  assert.ok(!html.includes("&amp;lt;"));
  assert.ok(!html.includes("<em>"));
  assert.ok(render("RECOVERY_REDIRECT_OK").includes("RECOVERY_REDIRECT_OK"));
  assert.ok(render("_emphasis_").includes("<em>emphasis</em>"));
});

test("links preserve query strings and cannot introduce HTML attributes", () => {
  const html = render('[A & B](https://example.com/a_b?q=1&x=2) `<img src=x onerror=alert(1)>`');
  assert.ok(html.includes('href="https://example.com/a_b?q=1&amp;x=2"'));
  assert.ok(html.includes("A &amp; B ↗"));
  assert.ok(!html.includes("<img"));
  assert.ok(!render('[x](javascript:alert(1))').includes('<a '));
  assert.ok(render('[x](https://example.com/"onclick="bad)').includes('&quot;onclick=&quot;bad'));
});

test("code and literal entity text remain distinct in tables and quotations", () => {
  const html = render('| Code |\n| --- |\n| `a_b < 2` |\n\n> `&lt;`');
  assert.ok(html.includes('<code class="inline-code">a_b &lt; 2</code>'));
  assert.ok(html.includes('<code class="inline-code">&amp;lt;</code>'));
});
