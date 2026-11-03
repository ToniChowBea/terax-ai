import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { setLastWslDistro } from "@/modules/settings/store";

export type WorkspaceEnv =
  | { kind: "local" }
  | { kind: "wsl"; distro: string }
  /**
   * A directory on another machine. `conn` is the live remote connection id
   * the backend dispatches on; `profileId` is carried for display and for
   * reconnecting after a restart, and is ignored by Rust.
   */
  | { kind: "ssh"; conn: number; profileId: string };

export type WslDistro = {
  name: string;
  default: boolean;
  running: boolean;
};

type State = {
  env: WorkspaceEnv;
  /**
   * Fork-only (SSH port): the last env that is not a remote host. The Explorer
   * follows the active tab onto a remote host, but local-only things (local
   * shells, LSP, theme files, local editor tabs) must keep using this one.
   */
  localEnv: WorkspaceEnv;
  distros: WslDistro[];
  loading: boolean;
  error: string | null;
  setEnv: (env: WorkspaceEnv) => void;
  refreshDistros: () => Promise<WslDistro[]>;
};

export const LOCAL_WORKSPACE: WorkspaceEnv = { kind: "local" };

export const useWorkspaceEnvStore = create<State>((set) => ({
  env: LOCAL_WORKSPACE,
  localEnv: LOCAL_WORKSPACE,
  distros: [],
  loading: false,
  error: null,
  setEnv: (env) => {
    set(env.kind === "ssh" ? { env } : { env, localEnv: env });
    if (env.kind === "wsl") void setLastWslDistro(env.distro);
  },
  refreshDistros: async () => {
    set({ loading: true, error: null });
    try {
      const distros = await invoke<WslDistro[]>("wsl_list_distros");
      set({ distros, loading: false });
      return distros;
    } catch (e) {
      set({ distros: [], loading: false, error: String(e) });
      return [];
    }
  },
}));

export function currentWorkspaceEnv(): WorkspaceEnv {
  return useWorkspaceEnvStore.getState().env;
}

/**
 * Fork-only (SSH port): the env for things that only ever run on this
 * machine. Equal to `currentWorkspaceEnv()` unless the Explorer is currently
 * following a remote host, in which case it is the local (or WSL) env that
 * was active before. A local path must never be sent to a remote backend.
 */
export function localWorkspaceEnv(): WorkspaceEnv {
  return useWorkspaceEnvStore.getState().localEnv;
}

/** Same environment for document identity: a host, not a connection id. */
export function sameWorkspace(
  a: WorkspaceEnv | undefined,
  b: WorkspaceEnv | undefined,
): boolean {
  const key = (e: WorkspaceEnv | undefined) =>
    e && e.kind === "ssh" ? workspaceScopeKey(e) : "local-side";
  return key(a) === key(b);
}

export function workspaceScopeKey(env: WorkspaceEnv): string {
  if (env.kind === "wsl") return `wsl:${env.distro}`;
  // Keyed by profile, not connection: the id changes on every reconnect and
  // the scope has to stay stable across one so caches are not thrown away.
  if (env.kind === "ssh") return `ssh:${env.profileId}`;
  return "local";
}

/**
 * Rebuild an env from its scope key. An `ssh:` key cannot be revived on its
 * own, because the connection it needs no longer exists; the caller reopens
 * the workspace and gets a fresh id.
 */
export function parseWorkspaceScopeKey(key: string): WorkspaceEnv {
  return key.startsWith("wsl:")
    ? { kind: "wsl", distro: key.slice("wsl:".length) }
    : LOCAL_WORKSPACE;
}

export function isRemoteEnv(
  env: WorkspaceEnv,
): env is { kind: "ssh"; conn: number; profileId: string } {
  return env.kind === "ssh";
}

export function currentWorkspaceScopeKey(): string {
  return workspaceScopeKey(currentWorkspaceEnv());
}

export async function getWslHome(distro: string): Promise<string> {
  return invoke<string>("wsl_home", { distro });
}
