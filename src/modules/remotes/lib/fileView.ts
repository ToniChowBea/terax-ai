import type { Tab } from "@/modules/tabs";
import type { WorkspaceEnv } from "@/modules/workspace";

/**
 * Fork-only (SSH port): which machine the file views (Explorer, file search,
 * content search, source control) are looking at, and from where.
 *
 * Root and env are decided together, in one place, so a local root can never
 * be paired with a remote env (the "could not list /Users/..." bug) and a
 * remote path can never be handed to the local filesystem.
 */
export type FileView = {
  env: WorkspaceEnv;
  root: string | null;
  /** True when the view belongs to a remote host. */
  remote: boolean;
};

import type { RemoteHostConn } from "./hosts";

type Params = {
  activeTab: Tab | undefined;
  /** The local (or WSL) env and the root upstream's own logic picked. */
  localEnv: WorkspaceEnv;
  localRoot: string | null;
  /** Connections by host, newest wins. */
  hosts: readonly RemoteHostConn[];
  /** Explicit "Open as workspace" root per host, if any. */
  workspaceRoots?: Readonly<Record<string, string>>;
  /** Last remote cwd seen per host, from OSC 7 in that host's terminals. */
  lastRemoteCwd?: Readonly<Record<string, string>>;
};

function envFor(host: RemoteHostConn): WorkspaceEnv {
  return { kind: "ssh", conn: host.conn, profileId: host.profileId };
}

/** Which host, if any, the active tab belongs to. */
export function activeRemoteProfile(tab: Tab | undefined): string | null {
  if (!tab) return null;
  if (tab.kind === "terminal") return tab.remoteId ?? null;
  if (tab.kind === "editor" || tab.kind === "markdown") {
    return tab.workspace?.kind === "ssh" ? tab.workspace.profileId : null;
  }
  return null;
}

export function resolveFileView({
  activeTab,
  localEnv,
  localRoot,
  hosts,
  workspaceRoots = {},
  lastRemoteCwd = {},
}: Params): FileView {
  const local: FileView = { env: localEnv, root: localRoot, remote: false };
  const profileId = activeRemoteProfile(activeTab);
  if (!profileId) return local;

  const host = hosts.find((h) => h.profileId === profileId);
  // The host's connection is still being opened (or failed). Showing the
  // local tree under a remote tab would be the old bug in another form, so
  // the view stays remote and simply has no root yet.
  if (!host) {
    return {
      env: { kind: "ssh", conn: 0, profileId },
      root: null,
      remote: true,
    };
  }

  const tabCwd =
    activeTab?.kind === "terminal" && activeTab.cwd?.startsWith("/")
      ? activeTab.cwd
      : undefined;
  const root =
    tabCwd ??
    workspaceRoots[profileId] ??
    lastRemoteCwd[profileId] ??
    host.home ??
    null;
  return { env: envFor(host), root: root || null, remote: true };
}
