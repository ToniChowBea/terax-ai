import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useRemoteHostsStore } from "./hosts";

/**
 * Fork-only (SSH port): "Persistent sessions", tmux sessions on a host.
 *
 * Everything runs over the host's shared, already authenticated connection.
 * Session names come from the server and are untrusted: they are displayed,
 * never put into a command. Actions target tmux's own `$n` id, which the
 * backend validates; the only name ever sent is one the user typed, which
 * `validateSessionName` checks here and the backend checks again.
 */
export type TmuxSession = {
  id: string;
  name: string;
  windows: number;
  attached: number;
  /** Seconds since the epoch. */
  created: number;
  activity: number;
};

type Listing =
  | { status: "ok"; sessions: TmuxSession[] }
  | { status: "notInstalled" };

type HostSessions = {
  loading: boolean;
  error: string | null;
  notInstalled: boolean;
  sessions: TmuxSession[];
};

type State = {
  byHost: Record<string, HostSessions>;
  refresh: (profileId: string) => Promise<void>;
  create: (profileId: string, name: string) => Promise<string>;
  rename: (profileId: string, id: string, name: string) => Promise<void>;
  kill: (profileId: string, id: string) => Promise<void>;
  detach: (profileId: string, id: string) => Promise<void>;
};

const EMPTY: HostSessions = {
  loading: false,
  error: null,
  notInstalled: false,
  sessions: [],
};

/** Mirrors `tmux::validate_name` in Rust; the backend checks again. */
export function validateSessionName(raw: string): string | null {
  const name = raw.trim();
  if (!name) return "A session name cannot be empty.";
  if ([...name].length > 64) return "Use at most 64 characters.";
  if (name.startsWith("-") || name.startsWith("="))
    return "A session name cannot start with '-' or '='.";
  const bad = [...name].find(
    (c) => ".:'\"\\$`".includes(c) || c.charCodeAt(0) < 0x20 || c === "\u007f",
  );
  if (bad) return `A session name cannot contain ${JSON.stringify(bad)}.`;
  return null;
}

async function connFor(profileId: string): Promise<number> {
  const host = await useRemoteHostsStore.getState().ensure(profileId);
  if (!host) {
    throw new Error(
      useRemoteHostsStore.getState().errors[profileId] ?? "not connected",
    );
  }
  return host.conn;
}

export const usePersistentSessions = create<State>((set, get) => {
  const patch = (profileId: string, p: Partial<HostSessions>) =>
    set((s) => ({
      byHost: {
        ...s.byHost,
        [profileId]: { ...(s.byHost[profileId] ?? EMPTY), ...p },
      },
    }));

  const act = async (profileId: string, fn: (conn: number) => Promise<void>) => {
    try {
      await fn(await connFor(profileId));
    } finally {
      await get().refresh(profileId);
    }
  };

  return {
    byHost: {},

    refresh: async (profileId) => {
      patch(profileId, { loading: true, error: null });
      try {
        const conn = await connFor(profileId);
        const listing = await invoke<Listing>("tmux_list", { conn });
        if (listing.status === "notInstalled") {
          patch(profileId, {
            loading: false,
            notInstalled: true,
            sessions: [],
          });
        } else {
          patch(profileId, {
            loading: false,
            notInstalled: false,
            sessions: sortSessions(listing.sessions),
          });
        }
      } catch (e) {
        patch(profileId, { loading: false, error: String(e) });
      }
    },

    create: async (profileId, name) => {
      const problem = validateSessionName(name);
      if (problem) throw new Error(problem);
      let id = "";
      await act(profileId, async (conn) => {
        id = await invoke<string>("tmux_create", { conn, name: name.trim() });
      });
      return id;
    },

    rename: (profileId, id, name) => {
      const problem = validateSessionName(name);
      if (problem) return Promise.reject(new Error(problem));
      return act(profileId, (conn) =>
        invoke("tmux_rename", { conn, id, name: name.trim() }),
      );
    },

    kill: (profileId, id) =>
      act(profileId, (conn) => invoke("tmux_kill", { conn, id })),

    detach: (profileId, id) =>
      act(profileId, (conn) => invoke("tmux_detach", { conn, id })),
  };
});

/** Most recently active first, the order you want to swap between them. */
export function sortSessions(sessions: TmuxSession[]): TmuxSession[] {
  return [...sessions].sort(
    (a, b) => b.activity - a.activity || a.name.localeCompare(b.name),
  );
}

/** "3m ago", "2h ago", "5d ago": compact enough for a sidebar row. */
export function relativeTime(epochSecs: number, nowMs = Date.now()): string {
  const secs = Math.max(0, Math.round(nowMs / 1000 - epochSecs));
  if (secs < 60) return "just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
