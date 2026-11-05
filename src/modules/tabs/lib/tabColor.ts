import {
  ACCENT_COLORS,
  ACCENT_NAMES,
  normalizeAccent,
} from "@/lib/accentColors";
import type { Tab } from "./useTabs";

/**
 * Fork-only: per-tab colours.
 *
 * A tab stores a palette key, never a CSS string, so nothing typed or read
 * back from disk can reach a style attribute unvalidated. The palette is the
 * shared accent palette (spaces, remote hosts), in the same order.
 *
 * `"none"` is an explicit choice: it hides a colour the tab would otherwise
 * inherit from its SSH host. An absent value means "inherit".
 */
export const TAB_COLOR_KEYS = [
  "blue",
  "violet",
  "emerald",
  "amber",
  "rose",
  "cyan",
  "orange",
  "pink",
] as const;

export type TabColorKey = (typeof TAB_COLOR_KEYS)[number];
export type TabColor = TabColorKey | "none";

export function isTabColor(value: unknown): value is TabColor {
  return (
    value === "none" ||
    (typeof value === "string" &&
      (TAB_COLOR_KEYS as readonly string[]).includes(value))
  );
}

/** The CSS colour for a key; only ever one of the fixed palette values. */
export function tabColorCss(key: TabColorKey): string {
  return ACCENT_COLORS[TAB_COLOR_KEYS.indexOf(key)];
}

export function tabColorName(key: TabColorKey): string {
  return ACCENT_NAMES[TAB_COLOR_KEYS.indexOf(key)];
}

/**
 * The colour a tab shows, as CSS, or undefined for none. A per-tab choice
 * wins; an SSH tab without one inherits its host's colour (validated, since
 * host colours may be hex).
 */
export function resolveTabAccent(
  tab: Tab,
  hostColor: (remoteId: string) => string | undefined,
): string | undefined {
  const own = tab.color;
  if (own === "none") return undefined;
  if (own && isTabColor(own)) return tabColorCss(own);
  if (tab.kind === "terminal" && tab.remoteId) {
    const host = hostColor(tab.remoteId);
    return host ? (normalizeAccent(host) ?? undefined) : undefined;
  }
  return undefined;
}
