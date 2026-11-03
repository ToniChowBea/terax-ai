import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));

import { useRemoteHostsStore } from "./hosts";
import {
  relativeTime,
  sortSessions,
  usePersistentSessions,
  validateSessionName,
} from "./tmux";

describe("validateSessionName", () => {
  it("accepts ordinary and unicode names", () => {
    expect(validateSessionName("dev server")).toBeNull();
    expect(validateSessionName("  build  ")).toBeNull();
    expect(validateSessionName("ünïcødé ☃")).toBeNull();
  });

  it("rejects what tmux would rewrite or a shell could misread", () => {
    for (const bad of [
      "",
      "   ",
      "-x",
      "=x",
      "a.b",
      "a:b",
      "a'b",
      'a"b',
      "a$b",
      "a`b",
      "a\\b",
      "a\tb",
      "a\nb",
      "x".repeat(65),
    ]) {
      expect(validateSessionName(bad), JSON.stringify(bad)).not.toBeNull();
    }
  });
});

describe("sortSessions and relativeTime", () => {
  it("puts the most recently active first", () => {
    const s = sortSessions([
      { id: "$0", name: "old", windows: 1, attached: 0, created: 1, activity: 10 },
      { id: "$1", name: "new", windows: 1, attached: 0, created: 1, activity: 50 },
    ]);
    expect(s.map((x) => x.name)).toEqual(["new", "old"]);
  });

  it("formats compactly", () => {
    const now = 1_000_000 * 1000;
    expect(relativeTime(1_000_000 - 5, now)).toBe("just now");
    expect(relativeTime(1_000_000 - 300, now)).toBe("5m ago");
    expect(relativeTime(1_000_000 - 7200, now)).toBe("2h ago");
    expect(relativeTime(1_000_000 - 3 * 86400, now)).toBe("3d ago");
  });
});

describe("usePersistentSessions", () => {
  beforeEach(() => {
    invoke.mockReset();
    useRemoteHostsStore.setState({
      hosts: {
        h1: {
          profileId: "h1",
          conn: 9,
          home: "/home/me",
          host: "srv",
          user: "me",
        },
      },
    });
    usePersistentSessions.setState({ byHost: {} });
  });

  it("treats 'tmux not installed' as a state, not an error", async () => {
    invoke.mockImplementation(async (cmd: string) =>
      cmd === "remote_is_open"
        ? true
        : cmd === "tmux_list"
          ? { status: "notInstalled" }
          : undefined,
    );
    await usePersistentSessions.getState().refresh("h1");
    const st = usePersistentSessions.getState().byHost.h1;
    expect(st.notInstalled).toBe(true);
    expect(st.error).toBeNull();
  });

  it("passes server names through untouched and acts by id only", async () => {
    const odd = "q'uote $x;`rm -rf ~`";
    invoke.mockImplementation(async (cmd: string) => {
      if (cmd === "remote_is_open") return true;
      if (cmd === "tmux_list")
        return {
          status: "ok",
          sessions: [
            { id: "$4", name: odd, windows: 2, attached: 1, created: 1, activity: 2 },
          ],
        };
      return undefined;
    });
    const s = usePersistentSessions.getState();
    await s.refresh("h1");
    expect(usePersistentSessions.getState().byHost.h1.sessions[0].name).toBe(odd);

    await s.kill("h1", "$4");
    const kill = invoke.mock.calls.find((c) => c[0] === "tmux_kill");
    expect(kill?.[1]).toEqual({ conn: 9, id: "$4" });
    for (const [, args] of invoke.mock.calls) {
      expect(JSON.stringify(args ?? {})).not.toContain("rm -rf");
    }
  });

  it("refuses an invalid new name before calling the host", async () => {
    invoke.mockResolvedValue(true);
    await expect(
      usePersistentSessions.getState().create("h1", "bad:name"),
    ).rejects.toThrow();
    expect(invoke.mock.calls.some((c) => c[0] === "tmux_create")).toBe(false);
  });
});
