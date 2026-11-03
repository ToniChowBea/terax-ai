import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));

import { askConfirm, askText, useAskStore, validateEntryName } from "./ask";
import { useRemoteHostsStore } from "./hosts";
import { usePersistentSessions, validateSessionName } from "./tmux";

/** Answer the dialog currently on screen, as AskDialogHost does. */
function answer(value: boolean | string | null) {
  const req = useAskStore.getState().current;
  if (!req) throw new Error("no dialog open");
  if (req.kind === "confirm") req.resolve(value as boolean);
  else req.resolve(value as string | null);
  useAskStore.getState().settle();
}

const session = {
  id: "$3",
  name: "work",
  windows: 1,
  attached: 0,
  created: 1,
  activity: 2,
};

/**
 * The same sequence PersistentSessions.tsx runs: ask first, act only on a
 * yes. Kept here so the flow is tested without a DOM.
 */
async function killFlow() {
  const ok = await askConfirm({
    title: `Kill "${session.name}"?`,
    confirmLabel: "Kill session",
    destructive: true,
  });
  if (!ok) return;
  await usePersistentSessions.getState().kill("h1", session.id);
}

async function renameFlow() {
  const next = await askText({
    title: "Rename persistent session",
    initial: session.name,
    validate: validateSessionName,
  });
  if (next === null || next === session.name) return;
  await usePersistentSessions.getState().rename("h1", session.id, next);
}

async function newFlow() {
  const name = await askText({
    title: "New persistent session",
    validate: validateSessionName,
  });
  if (name === null) return null;
  return usePersistentSessions.getState().create("h1", name);
}

const calls = (cmd: string) => invoke.mock.calls.filter((c) => c[0] === cmd);

describe("in-app dialogs replace window.confirm / window.prompt", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "remote_is_open") return true;
      if (cmd === "tmux_list") return { status: "ok", sessions: [session] };
      if (cmd === "tmux_create") return "$7";
      return undefined;
    });
    useAskStore.setState({ current: null, queue: [] });
    useRemoteHostsStore.setState({
      hosts: {
        h1: { profileId: "h1", conn: 5, home: "/h", host: "srv", user: "me" },
      },
    });
    usePersistentSessions.setState({ byHost: {} });
  });

  it("Kill: confirming kills the session by id and refreshes", async () => {
    const done = killFlow();
    expect(useAskStore.getState().current).toMatchObject({
      kind: "confirm",
      destructive: true,
      confirmLabel: "Kill session",
    });
    expect(calls("tmux_kill")).toHaveLength(0);
    answer(true);
    await done;
    expect(calls("tmux_kill")).toEqual([["tmux_kill", { conn: 5, id: "$3" }]]);
    expect(calls("tmux_list").length).toBeGreaterThan(0);
    expect(useAskStore.getState().current).toBeNull();
  });

  it("Kill: cancelling kills nothing", async () => {
    const done = killFlow();
    answer(false);
    await done;
    expect(calls("tmux_kill")).toHaveLength(0);
  });

  it("Rename: the dialog's value is sent; cancel sends nothing", async () => {
    const first = renameFlow();
    expect(useAskStore.getState().current).toMatchObject({
      kind: "text",
      initial: "work",
    });
    answer("build");
    await first;
    expect(calls("tmux_rename")).toEqual([
      ["tmux_rename", { conn: 5, id: "$3", name: "build" }],
    ]);

    const second = renameFlow();
    answer(null);
    await second;
    expect(calls("tmux_rename")).toHaveLength(1);
  });

  it("New: creates with the typed name and returns the new id", async () => {
    const done = newFlow();
    answer("dev server");
    expect(await done).toBe("$7");
    expect(calls("tmux_create")).toEqual([
      ["tmux_create", { conn: 5, name: "dev server" }],
    ]);
  });

  it("New: the dialog validates before anything reaches the host", () => {
    void newFlow();
    const req = useAskStore.getState().current;
    expect(req?.kind).toBe("text");
    if (req?.kind !== "text") return;
    expect(req.validate?.("bad:name")).not.toBeNull();
    expect(req.validate?.("good name")).toBeNull();
    answer(null);
  });

  it("queues a second dialog behind the first", async () => {
    const a = askConfirm({ title: "A" });
    const b = askConfirm({ title: "B" });
    expect(useAskStore.getState().current).toMatchObject({ title: "A" });
    answer(true);
    expect(await a).toBe(true);
    expect(useAskStore.getState().current).toMatchObject({ title: "B" });
    answer(false);
    expect(await b).toBe(false);
  });

  it("validates remote file and folder names", () => {
    expect(validateEntryName("notes.txt")).toBeNull();
    for (const bad of ["", "  ", ".", "..", "a/b"]) {
      expect(validateEntryName(bad)).not.toBeNull();
    }
  });
});
