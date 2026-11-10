import {
  labelFor,
  resolveTabAccent,
  TAB_COLOR_KEYS,
  type Tab,
  type TabColor,
  TabIcon,
  tabColorCss,
  tabColorName,
} from "@/modules/tabs";
import { findLeafCwd, leafIds } from "@/modules/terminal";
import { PaintBoardIcon } from "@hugeicons/core-free-icons";
import type { PaletteItem } from "./types";

/**
 * Fork-only: open tabs as palette results (Cmd+P), and "Set tab colour" for
 * the active tab.
 *
 * Every tab in every space is listed under "Open tabs". A terminal tab split
 * into panes gets one row per pane, so typing a pane's directory jumps to
 * that pane. Rows are ranked by the palette's own fuzzy matcher against the
 * tab label, kind, directory or path, host, tmux session and space name.
 */
export const TABS_GROUP = "Open tabs";
export const TAB_ITEM_PREFIX = "tab:";

export type TabItemsContext = {
  tabs: Tab[];
  activeId: number;
  spaces: { id: string; name: string }[];
  /** Display name and address of an SSH host, by profile id. */
  host: (remoteId: string) => { label: string; address: string } | undefined;
  hostColor: (remoteId: string) => string | undefined;
  /** Switch to the tab (and its space), and focus `leafId` if given. */
  activate: (tabId: number, leafId?: number) => void;
};

const KIND_WORDS: Record<Tab["kind"], string[]> = {
  terminal: ["terminal", "shell"],
  editor: ["editor", "file"],
  preview: ["preview", "browser", "web"],
  markdown: ["markdown", "file"],
  "ai-diff": ["diff", "ai"],
  "git-diff": ["diff", "git"],
  "git-history": ["git", "history", "graph"],
  "git-commit-file": ["git", "commit", "diff"],
};

/** Where the tab is: a directory, a file path or a URL. */
function locationOf(tab: Tab): string | undefined {
  switch (tab.kind) {
    case "terminal":
      return tab.cwd;
    case "editor":
    case "markdown":
    case "git-diff":
    case "ai-diff":
    case "git-commit-file":
      return "path" in tab ? tab.path : undefined;
    case "preview":
      return tab.url;
    case "git-history":
      return "repoRoot" in tab ? tab.repoRoot : undefined;
    default:
      return undefined;
  }
}

export function createTabItems(ctx: TabItemsContext): PaletteItem[] {
  const spaceName = new Map(ctx.spaces.map((s) => [s.id, s.name]));
  const showSpace = ctx.spaces.length > 1;
  const items: PaletteItem[] = [];

  for (const tab of ctx.tabs) {
    const label = labelFor(tab);
    const space = spaceName.get(tab.spaceId);
    const host =
      tab.kind === "terminal" && tab.remoteId
        ? ctx.host(tab.remoteId)
        : undefined;
    const accent = resolveTabAccent(tab, ctx.hostColor);
    const base: string[] = [
      ...KIND_WORDS[tab.kind],
      ...(space ? [space] : []),
      ...(host ? [host.label, host.address, "ssh", "remote"] : []),
      ...(tab.kind === "terminal" && tab.tmuxSession ? ["tmux"] : []),
      ...(tab.kind === "terminal" && tab.customTitle ? [tab.title] : []),
    ];
    const trailingFor = (where: string | undefined) =>
      [
        tab.id === ctx.activeId ? "Current tab" : undefined,
        host ? host.label : undefined,
        where ? shortLocation(where) : undefined,
        showSpace ? space : undefined,
      ]
        .filter(Boolean)
        .join(" · ") || undefined;
    const leading = <TabIcon tab={tab} />;

    const leaves = tab.kind === "terminal" ? leafIds(tab.paneTree) : [];
    if (tab.kind === "terminal" && leaves.length > 1) {
      leaves.forEach((leafId, i) => {
        const cwd = findLeafCwd(tab.paneTree, leafId);
        items.push({
          id: `${TAB_ITEM_PREFIX}${tab.id}:${leafId}`,
          title: `${label} · pane ${i + 1}`,
          group: TABS_GROUP,
          keywords: [...base, ...(cwd ? [cwd, basename(cwd)] : [])],
          leading,
          accent,
          trailing: trailingFor(cwd),
          run: () => ctx.activate(tab.id, leafId),
        });
      });
      continue;
    }

    const where = locationOf(tab);
    items.push({
      id: `${TAB_ITEM_PREFIX}${tab.id}`,
      title: label,
      group: TABS_GROUP,
      keywords: [...base, ...(where ? [where, basename(where)] : [])],
      leading,
      accent,
      trailing: trailingFor(where),
      run: () => ctx.activate(tab.id),
    });
  }
  return items;
}

/** "Set tab colour: <name>" for the active tab. */
export function createTabColorItems(
  activeTab: Tab | undefined,
  setColor: (tabId: number, color: TabColor | null) => void,
): PaletteItem[] {
  if (!activeTab) return [];
  const colours: PaletteItem[] = TAB_COLOR_KEYS.map((key) => ({
    id: `tab.color.${key}`,
    title: `Set tab colour: ${tabColorName(key)}`,
    group: "Tabs",
    keywords: ["color", "colour", "accent", "tab", key],
    icon: PaintBoardIcon,
    accent: tabColorCss(key),
    trailing: activeTab.color === key ? "Current" : undefined,
    run: () => setColor(activeTab.id, key),
  }));
  const inherits = activeTab.kind === "terminal" && !!activeTab.remoteId;
  return [
    ...colours,
    {
      id: "tab.color.none",
      title: "Set tab colour: None",
      group: "Tabs",
      keywords: ["color", "colour", "accent", "tab", "clear", "remove"],
      icon: PaintBoardIcon,
      // On an SSH tab "None" must also hide the host colour it inherits.
      run: () => setColor(activeTab.id, inherits ? "none" : null),
    },
  ];
}

/** Last two path segments ("naalya/Naalya-API"); URLs stay whole. The full
 *  path is still in the keywords, so search is unaffected. */
export function shortLocation(where: string): string {
  if (where.includes("://")) return where;
  const parts = where.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join("/") : where;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : path;
}
