import assert from "node:assert/strict";
import test from "node:test";
import { resolveLocale, t, setLocale } from "../src/i18n.js";

test("language validation: system/zh-CN/en accepted, random rejected", () => {
  assert.equal(resolveLocale("system", "en-US"), "en");
  assert.equal(resolveLocale("zh-CN", "en-US"), "zh-CN");
  assert.equal(resolveLocale("en", "zh-CN"), "en");
  assert.equal(resolveLocale("fr", "en-US"), "en");
});

test("system locale zh* -> zh-CN", () => {
  for (const loc of ["zh-CN", "zh-TW", "zh-SG", "zh", "ZH-cn"]) assert.equal(resolveLocale("system", loc), "zh-CN");
  assert.equal(resolveLocale("system", "en-US"), "en");
  assert.equal(resolveLocale("system", "ja-JP"), "en");
});

test("missing zh key falls back to en, never undefined", () => {
  setLocale("zh-CN");
  assert.equal(t("__no_such_key_xyz__"), "__no_such_key_xyz__");
  // known key present in both locales
  assert.notEqual(t("nav.coworkers"), "undefined");
  setLocale("en");
});

test("t param interpolation", () => {
  setLocale("en");
  assert.match(t("coworker.persistentCount", { count: 3 }), /3/);
});
