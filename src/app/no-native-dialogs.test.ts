import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Fork-only (SSH port) guard: `window.confirm` and `window.prompt` do not
 * work in Terax. On macOS, wry's WKWebView UI delegate implements no
 * JavaScript panel callbacks, so WebKit returns false / null immediately and
 * shows nothing: every action behind one silently does nothing (this broke
 * Kill, Rename, New and Delete in the remotes UI). Use the in-app dialogs in
 * `modules/remotes/lib/ask.ts` or the shadcn AlertDialog / Dialog instead.
 *
 * `alert` is banned too, except for two upstream calls on the Windows-only
 * WSL switch path, which this fork leaves alone to keep rebases cheap.
 */
const ROOT = join(__dirname, "..");
const ALERT_ALLOWED = new Set(["app/hooks/useWorkspaceSwitcher.ts"]);

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)
      ? [path]
      : [];
  });
}

/** Strip // and /* *\/ comments so prose mentioning the APIs is fine. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("native dialogs", () => {
  const files = sources(ROOT).map((path) => ({
    rel: relative(ROOT, path).replace(/\\/g, "/"),
    text: code(readFileSync(path, "utf8")),
  }));

  it("scans the source tree", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never uses window.confirm or window.prompt", () => {
    // Qualified calls anywhere, and a bare global call in expression
    // position (after `(`, `!`, `=`, `return`, `&&`...). A method declared
    // or called as `this.confirm(...)` on our own classes is not a hit, nor
    // is a typed signature such as `confirm(prompt: {...}): void`.
    const qualified =
      /\b(?:window|globalThis|self)\s*\.\s*(?:confirm|prompt)\b/;
    const bare =
      /(?:^|[(!=,;?:&|]|\breturn|\bawait)\s*(?:confirm|prompt)\s*\((?!\s*\w+\??\s*:)/m;
    const hits = files.flatMap(({ rel, text }) =>
      qualified.test(text) || bare.test(text) ? [rel] : [],
    );
    expect(hits).toEqual([]);
  });

  it("only uses window.alert in the allowed upstream file", () => {
    const hits = files.flatMap(({ rel, text }) =>
      /\b(?:window|globalThis|self)\s*\.\s*alert\b|(?:^|[(!=,;?:&|]|\breturn|\bawait)\s*alert\s*\(/m.test(
        text,
      ) &&
      !ALERT_ALLOWED.has(rel)
        ? [rel]
        : [],
    );
    expect(hits).toEqual([]);
  });
});
