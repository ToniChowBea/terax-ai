import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useRemoteHostsStore } from "./hosts";
import type { RemoteProfile } from "./types";

type RemoteWorkspace = {
  profileId: string;
  conn: number;
  /** Remote home, used to seed the explorer root when the profile has no cwd. */
  home: string;
  host: string;
  user: string;
  root: string;
};

type State = {
  /** At most one remote workspace is open at a time, mirroring the fact that
   *  the explorer and source-control panel each show a single root. */
  active: RemoteWorkspace | null;
  connecting: boolean;
  error: string | null;
  open: (profile: RemoteProfile) => Promise<RemoteWorkspace | null>;
  close: () => Promise<void>;
};

/**
 * "Open as workspace". Fork-only change: this no longer opens a connection of
 * its own. It uses the host's shared file connection (`useRemoteHostsStore`),
 * which rides the same authenticated SSH transport as the host's terminal
 * tabs, so it never prompts for a password a second time.
 */
export const useRemoteWorkspaceStore = create<State>((set, get) => ({
  active: null,
  connecting: false,
  error: null,

  open: async (profile) => {
    const existing = get().active;
    if (existing?.profileId === profile.id) {
      const alive = await invoke<boolean>("remote_is_open", {
        id: existing.conn,
      }).catch(() => false);
      if (alive) return existing;
    }
    set({ connecting: true, error: null });
    const hosts = useRemoteHostsStore.getState();
    const host = await hosts.ensure(profile.id);
    if (!host) {
      set({
        connecting: false,
        error:
          useRemoteHostsStore.getState().errors[profile.id] ??
          "could not connect",
        active: null,
      });
      return null;
    }
    try {
      const root = await invoke<string>("remote_authorize", {
        conn: host.conn,
        path: profile.cwd?.trim() || host.home,
      });
      const workspace: RemoteWorkspace = {
        profileId: profile.id,
        conn: host.conn,
        home: host.home,
        host: host.host,
        user: host.user,
        root,
      };
      hosts.setWorkspaceRoot(profile.id, root);
      set({ active: workspace, connecting: false, error: null });
      return workspace;
    } catch (e) {
      set({ connecting: false, error: String(e), active: null });
      return null;
    }
  },

  /**
   * Leaves workspace mode. The host connection stays while terminal tabs or
   * the file browser still use it; disconnecting the host is separate.
   */
  close: async () => {
    const active = get().active;
    if (!active) return;
    set({ active: null, error: null });
  },
}));
