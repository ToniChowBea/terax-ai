export {
  subscribeAgentSignals,
  useAgentActivityStore,
} from "./lib/agentActivity";
export {
  findLeafCwd,
  hasLeaf,
  leafIds,
  type PaneBounds,
  type PaneNode,
} from "./lib/panes";
export {
  clearFocusedTerminal,
  disposeSession,
  leafHasForegroundProcess,
  leafIdForPty,
  navigateFocusedBlocks,
  ptyIdForLeaf,
  whenSessionReady,
  writeToSession,
} from "./lib/terminalSessionApi";
export { isTerminalSurfaceTarget } from "./lib/terminalSurfaceTarget";
export {
  type TerminalPathDropTarget,
  useTerminalFileDrop,
} from "./lib/useTerminalFileDrop";
export type { TerminalPaneHandle } from "./TerminalPane";
export { TerminalStack } from "./TerminalStack";

// Fork-only (SSH port). Per-host appearance and background types are exported
// so remote profiles can store them; they are not yet applied by the Ghostty
// renderer (see SSH_PORT_NOTES.md).
export {
  pruneAppearance,
  resolveAppearance,
  type TerminalAppearance,
  type TerminalAppearanceOverride,
} from "./lib/appearanceOverride";
export type { PtySession } from "./lib/pty-bridge";
export { registerRemoteOpener } from "./lib/remoteOpener";
export type { TerminalBackground } from "./lib/terminalBackground";
export { useTerminalFont } from "./lib/useTerminalFont";
