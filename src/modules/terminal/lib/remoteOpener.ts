import type { PtySession } from "./pty-bridge";

/**
 * Fork-only (SSH port): opens a terminal session on a remote host.
 *
 * Registered by the remotes module at boot so the terminal never imports it,
 * which would make the two modules mutually dependent. The returned session
 * has the same shape as a local PTY, so the Ghostty session code drives it
 * exactly like one.
 */
export type RemoteOpener = (
  remoteId: string,
  cols: number,
  rows: number,
  handlers: {
    onData: (bytes: Uint8Array) => void;
    onExit: (code: number) => void;
  },
  /** Opaque per-tab options the remotes module understands (tmux attach). */
  options?: RemoteOpenOptions,
) => Promise<PtySession>;

export type RemoteOpenOptions = {
  /** tmux session id (`$n`) to attach to instead of a login shell. */
  tmuxSession?: string;
};

let remoteOpener: RemoteOpener | null = null;

export function registerRemoteOpener(opener: RemoteOpener | null): void {
  remoteOpener = opener;
}

export function openRemoteSession(
  remoteId: string,
  cols: number,
  rows: number,
  handlers: Parameters<RemoteOpener>[3],
  options?: RemoteOpenOptions,
): Promise<PtySession> {
  if (!remoteOpener) {
    return Promise.reject(new Error("remote sessions are not available"));
  }
  return remoteOpener(remoteId, cols, rows, handlers, options);
}
