import type { DirEntry } from "@/modules/explorer/lib/useFileTree";
import type { WorkspaceEnv } from "@/modules/workspace";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { create } from "zustand";
import { useRemoteHostsStore } from "./hosts";
import type { RemoteProfile } from "./types";
import { useRemotesStore } from "./store";

/** Trailing slash only for the root itself, so joins never double up. */
export function joinRemote(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

export function parentRemote(dir: string): string | null {
  if (dir === "/" || dir === "") return null;
  const cut = dir.lastIndexOf("/");
  if (cut < 0) return null;
  return cut === 0 ? "/" : dir.slice(0, cut);
}

export type DirState =
  | { status: "loading" }
  | { status: "loaded"; entries: DirEntry[] }
  | { status: "error"; message: string };

/** One visible row of the tree, flattened for rendering. */
export type TreeRow = {
  path: string;
  entry: DirEntry;
  depth: number;
  expanded: boolean;
};

/**
 * Depth-first rows under `root`, descending only into expanded directories.
 * Pure, so the tree's shape is testable without a server.
 */
export function flattenTree(
  root: string,
  dirs: Readonly<Record<string, DirState>>,
  expanded: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    const state = dirs[dir];
    if (state?.status !== "loaded") return;
    for (const entry of state.entries) {
      const path = joinRemote(dir, entry.name);
      const isOpen = entry.kind === "dir" && expanded.has(path);
      rows.push({ path, entry, depth, expanded: isOpen });
      if (isOpen) walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

type State = {
  profileId: string | null;
  conn: number | null;
  home: string;
  /** Root of the tree. Moves only on explicit navigation or when following. */
  cwd: string;
  dirs: Record<string, DirState>;
  expanded: Set<string>;
  showHidden: boolean;
  connecting: boolean;
  error: string | null;
  open: (profile: RemoteProfile) => Promise<void>;
  close: () => Promise<void>;
  /** Re-root the tree (Up, "Make root", follow terminal). */
  navigate: (dir: string) => Promise<void>;
  /** Expand or collapse a directory in place. Never touches the terminal. */
  toggle: (dir: string) => Promise<void>;
  /** Reload the root and every expanded directory. */
  refresh: () => Promise<void>;
  /** Reload one directory, after a mutation inside it. */
  reload: (dir: string) => Promise<void>;
  authorize: (dir: string) => Promise<void>;
  setShowHidden: (value: boolean) => void;
};

function env(conn: number, profileId: string): WorkspaceEnv {
  return { kind: "ssh", conn, profileId };
}

export const useRemoteBrowserStore = create<State>((set, get) => {
  const load = async (dir: string): Promise<void> => {
    const { conn, profileId } = get();
    if (conn === null || !profileId) return;
    if (get().dirs[dir]?.status !== "loaded") {
      set((s) => ({ dirs: { ...s.dirs, [dir]: { status: "loading" } } }));
    }
    try {
      const entries = await invoke<DirEntry[]>("fs_read_dir", {
        path: dir,
        showHidden: get().showHidden,
        gitDecorations: false,
        workspace: env(conn, profileId),
      });
      if (get().conn !== conn) return;
      set((s) => ({
        dirs: { ...s.dirs, [dir]: { status: "loaded", entries } },
      }));
    } catch (e) {
      if (get().conn !== conn) return;
      set((s) => ({
        dirs: { ...s.dirs, [dir]: { status: "error", message: String(e) } },
      }));
    }
  };

  return {
    profileId: null,
    conn: null,
    home: "",
    cwd: "",
    dirs: {},
    expanded: new Set(),
    showHidden: false,
    connecting: false,
    error: null,

    open: async (profile) => {
      const current = get();
      if (current.profileId === profile.id && current.conn !== null) {
        const alive = await invoke<boolean>("remote_is_open", {
          id: current.conn,
        }).catch(() => false);
        if (alive) return;
      }
      set({
        connecting: true,
        error: null,
        profileId: profile.id,
        conn: null,
        dirs: {},
        expanded: new Set(),
      });
      // The host's shared file connection: the same one the Explorer, search
      // and editors use, riding the terminal's authenticated transport.
      const host = await useRemoteHostsStore.getState().ensure(profile.id);
      if (get().profileId !== profile.id) return;
      if (!host) {
        set({
          connecting: false,
          error:
            useRemoteHostsStore.getState().errors[profile.id] ??
            "could not connect",
          profileId: null,
        });
        return;
      }
      const start = profile.cwd?.trim() || host.home;
      set({ conn: host.conn, home: host.home, connecting: false, error: null });
      await get().navigate(start);
    },

    close: async () => {
      // The connection belongs to the hosts store, which outlives the panel.
      set({
        profileId: null,
        conn: null,
        home: "",
        cwd: "",
        dirs: {},
        expanded: new Set(),
        error: null,
      });
    },

    navigate: async (dir) => {
      if (get().conn === null) return;
      set({ cwd: dir, expanded: new Set(), error: null });
      await load(dir);
    },

    toggle: async (dir) => {
      const expanded = new Set(get().expanded);
      if (expanded.has(dir)) {
        expanded.delete(dir);
        set({ expanded });
        return;
      }
      expanded.add(dir);
      set({ expanded });
      if (get().dirs[dir]?.status !== "loaded") await load(dir);
    },

    refresh: async () => {
      const { cwd, expanded } = get();
      if (!cwd) return;
      await Promise.all([cwd, ...expanded].map((d) => load(d)));
    },

    reload: (dir) => load(dir),

    /**
     * Reads are unrestricted but writes are confined to the roots a
     * connection has been given. An explicit create, rename or delete is the
     * user asking for this directory the same way opening it would.
     */
    authorize: async (dir) => {
      const { conn } = get();
      if (conn === null || !dir) return;
      await invoke("remote_authorize", { conn, path: dir });
    },

    setShowHidden: (value) => {
      set({ showHidden: value, dirs: {} });
      void get().refresh();
    },
  };
});

/** The env the panel's own actions run against, never the app's current one. */
export function browserEnv(): WorkspaceEnv | null {
  const { conn, profileId } = useRemoteBrowserStore.getState();
  return conn !== null && profileId ? env(conn, profileId) : null;
}

/**
 * Re-root the tree wherever the terminal is standing, so a cd moves the tree
 * and the git section with it. Only when the preference asks for it. This is
 * one-way: clicking in the tree never sends anything to the terminal.
 *
 * The cwd is only known when the host's shell emits OSC 7. Nothing happens on
 * a host that does not, which is why this cannot be the only way to navigate.
 */
export function useFollowTerminal(terminalCwd: string | undefined): void {
  const follow = usePreferencesStore((s) => s.remoteFollowTerminal);
  const conn = useRemoteBrowserStore((s) => s.conn);

  useEffect(() => {
    if (!follow || conn === null) return;
    if (!terminalCwd?.startsWith("/")) return;
    if (terminalCwd === useRemoteBrowserStore.getState().cwd) return;
    void useRemoteBrowserStore.getState().navigate(terminalCwd);
  }, [follow, conn, terminalCwd]);
}

/**
 * Keep the browser pointed at the host the user is actually looking at.
 *
 * Switching to another host's tab takes the files with it, and closing the
 * last tab for a host leaves its files belonging to nothing: the browser moves
 * on to another open host, or closes if there is none. Switching to a tab that
 * is not a remote terminal leaves it alone, since an editor tab is no reason
 * to tear down the files beside it.
 */
export function useBrowserTracksTabs(
  openRemoteIds: string[],
  activeRemoteId: string | undefined,
): void {
  const profileId = useRemoteBrowserStore((s) => s.profileId);
  const key = openRemoteIds.join("\u0000");

  useEffect(() => {
    const open = key ? key.split("\u0000") : [];
    const store = useRemoteBrowserStore.getState();
    const profiles = () => useRemotesStore.getState().profiles;

    if (activeRemoteId && activeRemoteId !== profileId) {
      const profile = profiles().find((p) => p.id === activeRemoteId);
      if (profile) void store.open(profile);
      return;
    }

    if (!profileId || open.includes(profileId)) return;

    const next = open[0];
    const profile = next ? profiles().find((p) => p.id === next) : undefined;
    if (profile) void store.open(profile);
    else void store.close();
  }, [profileId, key, activeRemoteId]);
}
