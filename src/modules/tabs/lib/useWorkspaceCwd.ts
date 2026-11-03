import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Tab } from "./useTabs";

type Result = {
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
};

// Fork-only (SSH port): an SSH tab's cwd is a path on another machine, so it
// must never become the local explorer root or a new local tab's cwd.
function localTerminalCwd(tab: Tab | undefined): string | undefined {
  return tab?.kind === "terminal" && !tab.remoteId ? tab.cwd : undefined;
}

export function useWorkspaceCwd(
  activeTab: Tab | undefined,
  tabs: Tab[],
  home: string | null,
): Result {
  const lastTerminalCwd = useRef<string | null>(null);

  useEffect(() => {
    const cwd = localTerminalCwd(activeTab);
    if (cwd) lastTerminalCwd.current = cwd;
  }, [activeTab]);

  const explorerRoot = useMemo<string | null>(() => {
    const activeCwd = localTerminalCwd(activeTab);
    if (activeCwd) return activeCwd;
    if (lastTerminalCwd.current) return lastTerminalCwd.current;
    const anyTerm = tabs.find((t) => localTerminalCwd(t));
    return localTerminalCwd(anyTerm) ?? home;
  }, [activeTab, tabs, home]);

  const inheritedCwdForNewTab = useCallback((): string | undefined => {
    const activeCwd = localTerminalCwd(activeTab);
    if (activeCwd) return activeCwd;
    // Editor tabs inherit the last terminal's cwd (or workspace home), not
    // the file's folder — opening a new terminal from a file shouldn't
    // hijack the user's working directory context.
    return lastTerminalCwd.current ?? home ?? undefined;
  }, [activeTab, home]);

  return { explorerRoot, inheritedCwdForNewTab };
}
