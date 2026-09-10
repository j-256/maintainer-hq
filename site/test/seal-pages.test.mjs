import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sealPage } from "../plugins/seal-pages.mjs";

function fixture(script = "window.fixture = true;", src = "") {
  return '<!doctype html><html><head><meta charset="utf-8"><script>' + script + '</script><meta http-equiv="content-security-policy" content="default-src \'none\'; connect-src \'self\'; script-src \'self\' \'sha256-stale\'; style-src \'self\'"></head><body><script' + (src ? ' src="' + src + '"' : '') + '>window.other = true;</script></body></html>';
}

test("seals exact final scripts before any execute without weakening evaluation policy", () => {
  const result = sealPage(fixture());
  assert.ok(result.indexOf('http-equiv="content-security-policy"') < result.indexOf("<script>"));
  for (const text of ["window.fixture = true;", "window.other = true;"])
    assert.ok(result.includes(createHash("sha256").update(text).digest("base64")));
  assert.equal(result.includes("sha256-stale"), false);
  assert.equal(result.includes("'unsafe-inline'"), false);
  assert.equal(result.includes("'unsafe-eval'"), false);
  assert.ok(result.includes("connect-src 'self'"));
  assert.equal(sealPage(result), result);
});

test("uses browser-normalized line endings for inline hash verification", () => {
  const result = sealPage(fixture("\r\nwindow.fixture = true;\r\n"));
  const hash = createHash("sha256").update("\nwindow.fixture = true;\n").digest("base64");
  assert.ok(result.includes(hash));
});

test("rejects unexpected scripts or incomplete policy rather than enabling them", () => {
  assert.throws(() => sealPage(fixture("", "https://untrusted.example/script.js")), /same-origin/);
  assert.throws(() => sealPage(fixture("", "//untrusted.example/script.js")), /same-origin/);
  assert.throws(() => sealPage(fixture().replace('charset="utf-8"', "")), /encoding/);
  assert.throws(() => sealPage(fixture().replace("script-src", "unexpected-src")));
});
