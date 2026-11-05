import { describe, expect, it } from "vitest";
import { ACCENT_COLORS } from "@/lib/accentColors";
import {
  isTabColor,
  resolveTabAccent,
  TAB_COLOR_KEYS,
  tabColorCss,
  tabColorName,
} from "./tabColor";
import type { Tab } from "./useTabs";

const term = (over: Partial<Extract<Tab, { kind: "terminal" }>> = {}): Tab =>
  ({
    id: 1,
    kind: "terminal",
    spaceId: "s",
    title: "t",
    paneTree: { kind: "leaf", id: 2 },
    activeLeafId: 2,
    ...over,
  }) as Tab;

const editor = (over: Partial<Extract<Tab, { kind: "editor" }>> = {}): Tab =>
  ({
    id: 3,
    kind: "editor",
    spaceId: "s",
    title: "a.ts",
    path: "/a.ts",
    dirty: false,
    preview: false,
    ...over,
  }) as Tab;

describe("tab colours", () => {
  it("accepts only palette keys and none", () => {
    for (const k of TAB_COLOR_KEYS) expect(isTabColor(k)).toBe(true);
    expect(isTabColor("none")).toBe(true);
    for (const bad of [
      "",
      "Blue",
      "#ff0000",
      "red",
      "blue; background:url(x)",
      "oklch(0.62 0.17 254)",
      1,
      null,
      undefined,
      {},
    ]) {
      expect(isTabColor(bad), String(bad)).toBe(false);
    }
  });

  it("maps every key to the shared palette, in order", () => {
    expect(TAB_COLOR_KEYS.map(tabColorCss)).toEqual([...ACCENT_COLORS]);
    expect(tabColorName("emerald")).toBe("Emerald");
  });

  it("uses the tab's own colour on any kind of tab", () => {
    const none = () => undefined;
    expect(resolveTabAccent(term({ color: "rose" }), none)).toBe(
      tabColorCss("rose"),
    );
    expect(resolveTabAccent(editor({ color: "cyan" }), none)).toBe(
      tabColorCss("cyan"),
    );
    expect(resolveTabAccent(editor(), none)).toBeUndefined();
  });

  it("lets an SSH tab inherit its host colour, which a choice overrides", () => {
    const host = (id: string) => (id === "h1" ? "#1A2B3C" : undefined);
    expect(resolveTabAccent(term({ remoteId: "h1" }), host)).toBe("#1a2b3c");
    expect(
      resolveTabAccent(term({ remoteId: "h1", color: "amber" }), host),
    ).toBe(tabColorCss("amber"));
    expect(
      resolveTabAccent(term({ remoteId: "h1", color: "none" }), host),
    ).toBeUndefined();
    // A local tab never inherits.
    expect(resolveTabAccent(term(), host)).toBeUndefined();
  });

  it("never lets an invalid host colour or stored value reach CSS", () => {
    const bad = () => "red; background: url(evil)";
    expect(resolveTabAccent(term({ remoteId: "h1" }), bad)).toBeUndefined();
    const forged = term({ color: "x;y" as never });
    expect(resolveTabAccent(forged, () => undefined)).toBeUndefined();
  });
});
