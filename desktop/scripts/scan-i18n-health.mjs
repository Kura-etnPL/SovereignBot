import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uiDir = path.resolve(__dirname, "../ui");

console.log("=== SovereignBot i18n Health Scanner ===");

const i18nPath = path.join(uiDir, "i18n.js");
const i18nSource = fs.readFileSync(i18nPath, "utf8");

const sandbox = { globalThis: {}, document: { documentElement: {} } };
vm.createContext(sandbox);
vm.runInContext(i18nSource, sandbox);

const SovereignI18n = sandbox.globalThis.SovereignI18n;
if (!SovereignI18n) {
  console.error("FAIL: SovereignI18n not exported in i18n.js");
  process.exit(1);
}

const { translations } = SovereignI18n;
const enKeys = new Set(Object.keys(translations.en || {}));
const zhKeys = new Set(Object.keys(translations["zh-CN"] || {}));

console.log(`Dictionary sizes: en = ${enKeys.size}, zh-CN = ${zhKeys.size}`);

const missingInZh = [...enKeys].filter((k) => !zhKeys.has(k));
const missingInEn = [...zhKeys].filter((k) => !enKeys.has(k));

let hasErrors = false;

if (missingInZh.length > 0) {
  console.error(`FAIL: ${missingInZh.length} keys in EN but missing in ZH:`, missingInZh);
  hasErrors = true;
}
if (missingInEn.length > 0) {
  console.error(`FAIL: ${missingInEn.length} keys in ZH but missing in EN:`, missingInEn);
  hasErrors = true;
}

const htmlPath = path.join(uiDir, "index.html");
const htmlSource = fs.readFileSync(htmlPath, "utf8");

const dataI18nRegex = /data-i18n(?:-[a-z]+)?="([^"]+)"/g;
let m;
const usedHtmlKeys = new Set();
while ((m = dataI18nRegex.exec(htmlSource)) !== null) {
  usedHtmlKeys.add(m[1]);
}

const missingHtmlKeys = [...usedHtmlKeys].filter((k) => !enKeys.has(k));
if (missingHtmlKeys.length > 0) {
  console.error(`FAIL: ${missingHtmlKeys.length} keys used in index.html missing from i18n dictionary:`, missingHtmlKeys);
  hasErrors = true;
} else {
  console.log(`HTML scan: all ${usedHtmlKeys.size} data-i18n keys are valid.`);
}

// Check for bilingual slashes: must contain Chinese on one side and Latin on the other side of "/"
// inside a string literal or HTML text content.
// e.g. "English / 中文", "中文 / English", "15 min / 15 分钟", "draft… / 正在生成"
const bilingualSlashRegex = /(?:[\u4e00-\u9fa5][^\/]*\/[^\/]*[a-zA-Z]|[a-zA-Z][^\/]*\/[^\/]*[\u4e00-\u9fa5])/;

function containsBilingualSlash(text) {
  // Check string literals ("...", '...', `...`) and HTML text (>...<)
  const tokenRegex = /(["'`])((?:(?!\1|\\).|\\.)*?)\1|>([^<]+)</g;
  let match;
  while ((match = tokenRegex.exec(text)) !== null) {
    let literal = match[2] ?? match[3] ?? "";
    // strip interpolated expressions like ${...} in template literals
    literal = literal.replace(/\$\{[^}]+\}/g, "");
    if (bilingualSlashRegex.test(literal)) return true;
  }
  return false;
}

const slashFiles = [];
const uiFiles = fs.readdirSync(uiDir).filter((f) => f.endsWith(".html") || (f.endsWith(".js") && f !== "i18n.js"));

for (const file of uiFiles) {
  const filePath = path.join(uiDir, file);
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n");
  const matches = [];
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) return;
    if (containsBilingualSlash(line)) {
      matches.push({ line: idx + 1, content: trimmed.slice(0, 100) });
    }
  });
  if (matches.length > 0) {
    slashFiles.push({ file, count: matches.length, samples: process.argv.includes("--all") ? matches : matches.slice(0, 3) });
  }
}

if (slashFiles.length > 0) {
  console.log(`\nFound bilingual slashes in ${slashFiles.length} files:`);
  for (const item of slashFiles) {
    console.log(`  - ${item.file} (${item.count} occurrences)`);
    for (const sample of item.samples) {
      console.log(`      L${sample.line}: ${sample.content}`);
    }
  }
} else {
  console.log("\nBilingual slash scan: 0 files contain bilingual slashes!");
}

if (!hasErrors && slashFiles.length === 0) {
  console.log("\ni18n dictionary symmetry & clean UI: ALL PASS!");
} else {
  process.exitCode = 1;
}
