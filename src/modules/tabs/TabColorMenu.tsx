import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import { normalizeAccent } from "@/lib/accentColors";
import { PaintBoardIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  TAB_COLOR_KEYS,
  type TabColor,
  tabColorCss,
  tabColorName,
} from "./lib/tabColor";
import type { Tab } from "./lib/useTabs";

const ITEM = "gap-2 rounded-xl px-2.5 py-1.5 text-[13px]";

/**
 * Fork-only: "Set colour" submenu for the tab context menu. Palette swatches
 * plus None; for an SSH tab whose host has a colour, also "Host colour"
 * (back to inheriting).
 */
export function TabColorMenu({
  tab,
  inherited,
  onSetColor,
}: {
  tab: Tab;
  /** The host colour an SSH tab inherits when it has no choice of its own. */
  inherited?: string;
  onSetColor: (color: TabColor | null) => void;
}) {
  const host = inherited ? normalizeAccent(inherited) : null;
  const current = tab.color;
  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger className={ITEM}>
        <HugeiconsIcon icon={PaintBoardIcon} size={13} strokeWidth={1.75} />
        <span className="flex-1">Set colour</span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="min-w-40 p-1">
        {TAB_COLOR_KEYS.map((key) => (
          <ContextMenuItem
            key={key}
            className={ITEM}
            onSelect={() => onSetColor(key)}
          >
            <Swatch color={tabColorCss(key)} />
            <span className="flex-1">{tabColorName(key)}</span>
            {current === key ? <Check /> : null}
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem
          className={ITEM}
          onSelect={() => onSetColor(host ? "none" : null)}
        >
          <Swatch />
          <span className="flex-1">None</span>
          {(host ? current === "none" : !current || current === "none") ? (
            <Check />
          ) : null}
        </ContextMenuItem>
        {host ? (
          <ContextMenuItem className={ITEM} onSelect={() => onSetColor(null)}>
            <Swatch color={host} />
            <span className="flex-1">Host colour</span>
            {!current ? <Check /> : null}
          </ContextMenuItem>
        ) : null}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}

function Swatch({ color }: { color?: string }) {
  return (
    <span
      aria-hidden
      className="size-3 shrink-0 rounded-full border border-foreground/15"
      style={color ? { background: color } : undefined}
    />
  );
}

function Check() {
  return (
    <HugeiconsIcon
      icon={Tick02Icon}
      size={13}
      strokeWidth={2}
      className="text-muted-foreground"
    />
  );
}
