import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// An open Radix menu sets `pointer-events: none` on <body> and closes on a
// pointerdown that reaches the document. A pane that forces `auto` keeps
// taking clicks, and the terminal stops their propagation, so the menu stays
// open. Visible panes must inherit instead.
const SRC = fileURLToPath(new URL("..", import.meta.url));
const FORCED_AUTO = /pointerEvents:[^,\n]*"auto"/;

it("no pane opts out of a modal menu's outside-click handling", () => {
  const offenders = (readdirSync(SRC, { recursive: true }) as string[])
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .filter((file) => FORCED_AUTO.test(readFileSync(join(SRC, file), "utf8")));
  expect(offenders).toEqual([]);
});
