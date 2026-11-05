import type { ShortcutId } from "@/modules/shortcuts";
import type { TerminalIcon } from "@hugeicons/core-free-icons";
import type { ReactNode } from "react";

type PaletteIcon = typeof TerminalIcon;

export type PaletteItem = {
  id: string;
  title: string;
  group: string;
  keywords?: string[];
  icon?: PaletteIcon;
  iconUrl?: string;
  shortcutId?: ShortcutId;
  trailing?: string;
  disabledReason?: string;
  /** Fork-only: rendered instead of `icon` (open tabs show their tab icon). */
  leading?: ReactNode;
  /** Fork-only: a colour dot, from the fixed tab palette or a validated hex. */
  accent?: string;
  run: () => void;
};

export type PaletteMode =
  | "commands"
  | "history"
  | "content"
  | "help"
  /** Fork-only: "@" lists only open tabs. */
  | "tabs";
