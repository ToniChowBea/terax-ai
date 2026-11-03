import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { openRemoteConnection } from "./connect";
import { usePromptStore } from "./opener";
import { findProfile } from "./store";
import type { RemoteProfile } from "./types";

/**
 * Fork-only (SSH port): one file-access connection per host.
 *
 * Every consumer of a host's files (the Explorer while a host tab is active,
 * the Remotes-view tree, Cmd+Shift+F search, editors of remote files, remote
 * git) uses this one connection. It rides the same authenticated SSH
 * transport as that host's terminal tabs (see `ssh::pool` in Rust), so
 * connecting never asks for the password a second time.
 */
/** A live file-access connection to a host. */
export type RemoteHostConn = {
  profileId: string;
  conn: number;
  /** Remote home from SFTP realpath("."). */
  home: string;
};

type HostState = RemoteHostConn & {
  host: string;
  user: string;
};

type State = {
  hosts: Record<string, HostState>;
  connecting: Record<string, boolean>;
  errors: Record<string, string>;
  /** Roots picked with "Open as workspace", by host. */
  workspaceRoots: Record<string, string>;
  /** Last cwd a host's terminal reported (OSC 7), by host. */
  lastCwd: Record<string, string>;
  ensure: (profileId: string) => Promise<HostState | null>;
  close: (profileId: string) => Promise<void>;
  setWorkspaceRoot: (profileId: string, root: string) => void;
  noteCwd: (profileId: string, cwd: string) => void;
};

const inflight = new Map<string, Promise<HostState | null>>();

export const useRemoteHostsStore = create<State>((set, get) => ({
  hosts: {},
  connecting: {},
  errors: {},
  workspaceRoots: {},
  lastCwd: {},

  ensure: (profileId) => {
    const running = inflight.get(profileId);
    if (running) return running;
    const task = (async () => {
      const existing = get().hosts[profileId];
      if (existing) {
        const alive = await invoke<boolean>("remote_is_open", {
          id: existing.conn,
        }).catch(() => false);
        if (alive) return existing;
        set((s) => {
          const hosts = { ...s.hosts };
          delete hosts[profileId];
          return { hosts };
        });
      }
      const profile: RemoteProfile | undefined = findProfile(profileId);
      if (!profile) return null;
      set((s) => ({
        connecting: { ...s.connecting, [profileId]: true },
        errors: omit(s.errors, profileId),
      }));
      try {
        const opened = await openRemoteConnection(profile);
        const state: HostState = {
          profileId,
          conn: opened.conn,
          home: opened.home,
          host: opened.host,
          user: opened.user,
        };
        // The home is the default root of every view of this host; mutations
        // there (new file, rename, save) must be allowed.
        await invoke("remote_authorize", {
          conn: opened.conn,
          path: profile.cwd?.trim() || opened.home,
        }).catch(() => undefined);
        set((s) => ({
          hosts: { ...s.hosts, [profileId]: state },
          connecting: omit(s.connecting, profileId),
        }));
        return state;
      } catch (e) {
        set((s) => ({
          connecting: omit(s.connecting, profileId),
          errors: { ...s.errors, [profileId]: String(e) },
        }));
        return null;
      }
    })();
    inflight.set(profileId, task);
    void task.finally(() => inflight.delete(profileId));
    return task;
  },

  close: async (profileId) => {
    const host = get().hosts[profileId];
    set((s) => ({
      hosts: omit(s.hosts, profileId),
      workspaceRoots: omit(s.workspaceRoots, profileId),
      lastCwd: omit(s.lastCwd, profileId),
    }));
    if (host) {
      usePromptStore.setState((prev) => ({
        queue: prev.queue.filter(
          (p) => p.scope !== "workspace" || p.sessionId !== host.conn,
        ),
      }));
      await invoke("remote_close", { id: host.conn }).catch(() => {});
    }
  },

  setWorkspaceRoot: (profileId, root) =>
    set((s) => ({ workspaceRoots: { ...s.workspaceRoots, [profileId]: root } })),

  noteCwd: (profileId, cwd) => {
    if (!cwd.startsWith("/") || get().lastCwd[profileId] === cwd) return;
    set((s) => ({ lastCwd: { ...s.lastCwd, [profileId]: cwd } }));
  },
}));

function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

/** The workspace env for a connected host, or null when it is not open. */
export function hostEnv(
  profileId: string,
): { kind: "ssh"; conn: number; profileId: string } | null {
  const host = useRemoteHostsStore.getState().hosts[profileId];
  return host ? { kind: "ssh", conn: host.conn, profileId } : null;
}

/**
 * Authorize a remote directory for mutations on its host's connection. Reads
 * are unrestricted; writes are confined to authorized roots, so an explicit
 * user action (create, rename, delete, save) authorizes where it happens.
 */
export async function authorizeRemoteDir(
  profileId: string,
  dir: string,
): Promise<void> {
  const host = useRemoteHostsStore.getState().hosts[profileId];
  if (!host || !dir.startsWith("/")) return;
  await invoke("remote_authorize", { conn: host.conn, path: dir }).catch(
    () => undefined,
  );
}
