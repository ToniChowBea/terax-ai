import { describe, expect, it, vi } from "vitest";
import type { Tab } from "@/modules/tabs";
import { tabColorCss } from "@/modules/tabs";
import { orderGroups, rankCommands } from "./CommandPalette";
import { COMMAND_GROUPS, SPACE_ITEM_PREFIX } from "./commands";
import { parseQuery } from "./lib/mode";
import {
  createTabColorItems,
  createTabItems,
  TAB_ITEM_PREFIX,
  TABS_GROUP,
  type TabItemsContext,
} from "./tabItems";
import type { PaletteItem } from "./types";

const local: Tab = {
  id: 1,
  kind: "terminal",
  spaceId: "work",
  title: "zsh",
  cwd: "/Users/me/projects/terax",
  paneTree: { kind: "leaf", id: 10, cwd: "/Users/me/projects/terax" },
  activeLeafId: 10,
} as Tab;

const split: Tab = {
  id: 2,
  kind: "terminal",
  spaceId: "work",
  title: "zsh",
  paneTree: {
    kind: "split",
    id: 20,
    dir: "row",
    sizes: [50, 50],
    children: [
      { kind: "leaf", id: 21, cwd: "/srv/api" },
      { kind: "leaf", id: 22, cwd: "/var/log/nginx" },
    ],
  },
  activeLeafId: 21,
} as unknown as Tab;

const remote: Tab = {
  id: 3,
  kind: "terminal",
  spaceId: "home",
  title: "bash",
  remoteId: "h1",
  paneTree: { kind: "leaf", id: 30 },
  activeLeafId: 30,
} as Tab;

const editor: Tab = {
  id: 4,
  kind: "editor",
  spaceId: "home",
  title: "useTabs.ts",
  path: "/Users/me/projects/terax/src/modules/tabs/lib/useTabs.ts",
  dirty: false,
  preview: false,
  color: "violet",
} as Tab;

function ctx(over: Partial<TabItemsContext> = {}): TabItemsContext {
  return {
    tabs: [local, split, remote, editor],
    activeId: 1,
    spaces: [
      { id: "work", name: "Work" },
      { id: "home", name: "Homelab" },
    ],
    host: (id) =>
      id === "h1" ? { label: "pi", address: "me@pi.lan" } : undefined,
    hostColor: (id) => (id === "h1" ? "#112233" : undefined),
    activate: vi.fn(),
    ...over,
  };
}

const ids = (items: PaletteItem[]) => items.map((i) => i.id);
const top = (items: PaletteItem[], term: string) =>
  rankCommands(items, term, {})[0]?.id;

describe("palette tab items", () => {
  it("lists every tab in every space, one row per split pane", () => {
    const items = createTabItems(ctx());
    expect(ids(items)).toEqual([
      "tab:1",
      "tab:2:21",
      "tab:2:22",
      "tab:3",
      "tab:4",
    ]);
    expect(items.every((i) => i.group === TABS_GROUP)).toBe(true);
    expect(items.every((i) => i.id.startsWith(TAB_ITEM_PREFIX))).toBe(true);
  });

  it("labels rows with space, host and location, and marks the current tab", () => {
    const items = createTabItems(ctx());
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get("tab:1")?.trailing).toBe(
      "Current tab · /Users/me/projects/terax · Work",
    );
    expect(byId.get("tab:3")?.trailing).toBe("pi · Homelab");
    expect(byId.get("tab:2:22")?.trailing).toBe("/var/log/nginx · Work");
    // A single space is not worth naming.
    const one = createTabItems(ctx({ spaces: [{ id: "work", name: "Work" }] }));
    expect(one[0].trailing).toBe("Current tab · /Users/me/projects/terax");
  });

  it("finds tabs by cwd, host, file name, path and space", () => {
    const items = createTabItems(ctx());
    expect(top(items, "nginx")).toBe("tab:2:22");
    expect(top(items, "srv/api")).toBe("tab:2:21");
    expect(top(items, "pi.lan")).toBe("tab:3");
    expect(top(items, "useTabs")).toBe("tab:4");
    expect(top(items, "modules/tabs/lib")).toBe("tab:4");
    expect(ids(rankCommands(items, "homelab", {}))).toEqual(["tab:3", "tab:4"]);
    expect(rankCommands(items, "qqqzzz", {})).toEqual([]);
  });

  it("switches to the tab, or to the exact pane", () => {
    const activate = vi.fn();
    const items = createTabItems(ctx({ activate }));
    items.find((i) => i.id === "tab:4")?.run();
    expect(activate).toHaveBeenLastCalledWith(4);
    items.find((i) => i.id === "tab:2:22")?.run();
    expect(activate).toHaveBeenLastCalledWith(2, 22);
  });

  it("shows the tab's colour, inherited from its host when unset", () => {
    const items = createTabItems(ctx());
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get("tab:4")?.accent).toBe(tabColorCss("violet"));
    expect(byId.get("tab:3")?.accent).toBe("#112233");
    expect(byId.get("tab:1")?.accent).toBeUndefined();
  });

  it("ranks tabs alongside commands when typing plainly", () => {
    const cmd: PaletteItem = {
      id: "file.save",
      title: "Save File",
      group: "File",
      run: () => {},
    };
    const items = [cmd, ...createTabItems(ctx())];
    const ranked = rankCommands(items, "nginx", {});
    expect(ranked[0].id).toBe("tab:2:22");
    expect(orderGroups(ranked, true)[0]).toBe(TABS_GROUP);
    // With no term, groups keep the fixed order and tabs come last.
    expect(orderGroups(ranked, false)).toBe(COMMAND_GROUPS);
    expect(COMMAND_GROUPS[COMMAND_GROUPS.length - 1]).toBe(TABS_GROUP);
  });

  it("lists a matching space first when searching, even if others match better", () => {
    const row = (id: string, title: string, group: string, keywords: string[] = []) =>
      ({ id, title, group, keywords, run: () => {} }) as PaletteItem;
    const space = row(`${SPACE_ITEM_PREFIX}w`, "Switch to Work", "Spaces", ["Work"]);
    const items = [
      row("tab:9", "work", TABS_GROUP),
      row("spaces.new", "New Space", "Spaces", ["workspace"]),
      space,
    ];
    const ranked = rankCommands(items, "work", {});
    expect(ranked[0]).toBe(space);
    expect(orderGroups(ranked, true)).toEqual(["Spaces", TABS_GROUP]);
  });

  it("does not let a weak match on a Spaces command outrank a tab", () => {
    // "pi" is a subsequence of "Spaces: Overview", but no space is named that.
    const ranked = rankCommands(
      [
        { id: "spaces.overview", title: "Spaces: Overview", group: "Spaces", run: () => {} },
        { id: "tab:8", title: "pi", group: TABS_GROUP, run: () => {} },
      ],
      "pi",
      {},
    );
    expect(orderGroups(ranked, true)).toEqual([TABS_GROUP, "Spaces"]);
  });
});

describe("@ prefix", () => {
  it("routes @ to tabs mode and leaves the other prefixes alone", () => {
    expect(parseQuery("@nginx")).toMatchObject({ mode: "tabs", term: "nginx" });
    expect(parseQuery(">git")).toMatchObject({ mode: "history" });
    expect(parseQuery("# x")).toMatchObject({ mode: "content" });
    expect(parseQuery("nginx")).toMatchObject({ mode: "commands" });
  });
});

describe("set tab colour commands", () => {
  it("offers the palette plus None, and marks the current colour", () => {
    const set = vi.fn();
    const items = createTabColorItems(editor, set);
    expect(items).toHaveLength(9);
    expect(items.find((i) => i.id === "tab.color.violet")?.trailing).toBe(
      "Current",
    );
    items.find((i) => i.id === "tab.color.amber")?.run();
    expect(set).toHaveBeenLastCalledWith(4, "amber");
    items.find((i) => i.id === "tab.color.none")?.run();
    expect(set).toHaveBeenLastCalledWith(4, null);
  });

  it("None on an SSH tab hides the inherited host colour", () => {
    const set = vi.fn();
    createTabColorItems(remote, set)
      .find((i) => i.id === "tab.color.none")
      ?.run();
    expect(set).toHaveBeenLastCalledWith(3, "none");
  });

  it("offers nothing with no active tab", () => {
    expect(createTabColorItems(undefined, vi.fn())).toEqual([]);
  });
});
