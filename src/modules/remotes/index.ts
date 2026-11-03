export { RemotePrompts, RemotesPanel } from "./RemotesLazy";
export { installRemoteOpener } from "./lib/opener";
export { useRemotesStore } from "./lib/store";
export {
  useBrowserTracksTabs,
  useRemoteBrowserStore,
} from "./lib/browser";
export { useRemoteWorkspaceStore } from "./lib/workspace";
export { profileAddress, profileLabel } from "./lib/tree";

export type { RemoteBackground, RemoteProfile } from "./lib/types";
// Fork-only (SSH port): shared per-host file connection and file-view routing.
export { useRemoteHostsStore } from "./lib/hosts";
export { resolveFileView } from "./lib/fileView";
export { usePersistentSessions } from "./lib/tmux";
