import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));

import { useRemoteHostsStore } from "./hosts";
import { usePersistentSessions } from "./tmux";

const session = {
  id: "$3",
  name: "work",
  windows: 1,
  attached: 0,
  created: 1,
  activity: 2,
};

describe("persistent sessions refresh", () => {
  beforeEach(() => {
    invoke.mockReset();
    useRemoteHostsStore.setState({
      hosts: {
        h1: { profileId: "h1", conn: 5, home: "/h", host: "srv", user: "me" },
      },
    });
    usePersistentSessions.setState({ byHost: {} });
  });

  // Regression for "attached again after refresh": the listing replaces the
  // previous one wholesale, so a stale `attached: 1` row cannot survive.
  it("replaces stale rows with the fresh listing", async () => {
    let attached = 1;
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "remote_is_open") return true;
      if (cmd === "tmux_list")
        return { status: "ok", sessions: [{ ...session, attached }] };
      return undefined;
    });
    const s = usePersistentSessions.getState();
    await s.refresh("h1");
    expect(usePersistentSessions.getState().byHost.h1.sessions[0].attached).toBe(1);
    attached = 0;
    await s.detach("h1", "$3");
    expect(usePersistentSessions.getState().byHost.h1.sessions[0].attached).toBe(0);
    await s.refresh("h1");
    expect(usePersistentSessions.getState().byHost.h1.sessions[0].attached).toBe(0);
  });

  it("a slow earlier refresh cannot overwrite a newer one", async () => {
    const pending: Array<(v: unknown) => void> = [];
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "remote_is_open") return true;
      if (cmd === "tmux_list") return new Promise((r) => pending.push(r));
      return undefined;
    });
    const s = usePersistentSessions.getState();
    const older = s.refresh("h1");
    const newer = s.refresh("h1");
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    // The newer request answers first (detached), the older one last
    // (still attached, from before the detach).
    pending[1]({ status: "ok", sessions: [{ ...session, attached: 0 }] });
    await newer;
    pending[0]({ status: "ok", sessions: [{ ...session, attached: 1 }] });
    await older;
    expect(usePersistentSessions.getState().byHost.h1.sessions[0].attached).toBe(0);
  });
});
