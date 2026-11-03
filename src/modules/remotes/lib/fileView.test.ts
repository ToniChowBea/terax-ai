import { describe, expect, it } from "vitest";
import type { Tab } from "@/modules/tabs";
import { activeRemoteProfile, resolveFileView } from "./fileView";

const LOCAL = { kind: "local" } as const;
const host = { profileId: "h1", conn: 7, home: "/home/emmanuel" };

function terminal(over: Partial<Extract<Tab, { kind: "terminal" }>> = {}): Tab {
  return {
    id: 1,
    kind: "terminal",
    spaceId: "s",
    title: "t",
    paneTree: { kind: "leaf", id: 2 },
    activeLeafId: 2,
    ...over,
  } as Tab;
}

describe("resolveFileView", () => {
  it("keeps the local root and env for a local tab", () => {
    const view = resolveFileView({
      activeTab: terminal({ cwd: "/Users/Emmanuel.Alawode" }),
      localEnv: LOCAL,
      localRoot: "/Users/Emmanuel.Alawode",
      hosts: [host],
    });
    expect(view).toEqual({
      env: LOCAL,
      root: "/Users/Emmanuel.Alawode",
      remote: false,
    });
  });

  // Regression: "Open as workspace" left the explorer rooted at the Mac home
  // while listing went to the server ("could not list /Users/...").
  it("never pairs a local root with a remote env", () => {
    const view = resolveFileView({
      activeTab: terminal({ remoteId: "h1" }),
      localEnv: LOCAL,
      localRoot: "/Users/Emmanuel.Alawode",
      hosts: [host],
    });
    expect(view.env).toEqual({ kind: "ssh", conn: 7, profileId: "h1" });
    expect(view.root).toBe("/home/emmanuel");
    expect(view.root).not.toContain("/Users/");
  });

  it("follows the remote terminal's cwd when known", () => {
    const view = resolveFileView({
      activeTab: terminal({ remoteId: "h1", cwd: "/home/emmanuel/dev/app" }),
      localEnv: LOCAL,
      localRoot: "/Users/me",
      hosts: [host],
    });
    expect(view.root).toBe("/home/emmanuel/dev/app");
  });

  it("prefers an explicit workspace root over home", () => {
    const view = resolveFileView({
      activeTab: terminal({ remoteId: "h1" }),
      localEnv: LOCAL,
      localRoot: "/Users/me",
      hosts: [host],
      workspaceRoots: { h1: "/srv/project" },
    });
    expect(view.root).toBe("/srv/project");
  });

  it("uses the host's last known cwd for a remote editor tab", () => {
    const editor = {
      id: 3,
      kind: "editor",
      spaceId: "s",
      title: "a.rs",
      path: "/home/emmanuel/dev/a.rs",
      dirty: false,
      preview: false,
      workspace: { kind: "ssh", conn: 7, profileId: "h1" },
    } as Tab;
    const view = resolveFileView({
      activeTab: editor,
      localEnv: LOCAL,
      localRoot: "/Users/me",
      hosts: [host],
      lastRemoteCwd: { h1: "/home/emmanuel/dev" },
    });
    expect(view.remote).toBe(true);
    expect(view.root).toBe("/home/emmanuel/dev");
  });

  it("returns to the local root when a local tab becomes active again", () => {
    const view = resolveFileView({
      activeTab: terminal(),
      localEnv: LOCAL,
      localRoot: "/Users/me/code",
      hosts: [host],
      lastRemoteCwd: { h1: "/home/emmanuel/dev" },
    });
    expect(view).toEqual({ env: LOCAL, root: "/Users/me/code", remote: false });
  });

  it("has no root, rather than a local one, while the host is connecting", () => {
    const view = resolveFileView({
      activeTab: terminal({ remoteId: "h2" }),
      localEnv: LOCAL,
      localRoot: "/Users/me",
      hosts: [host],
    });
    expect(view.remote).toBe(true);
    expect(view.root).toBeNull();
  });

  it("ignores a non-absolute cwd from a remote shell", () => {
    const view = resolveFileView({
      activeTab: terminal({ remoteId: "h1", cwd: "C:/nope" }),
      localEnv: LOCAL,
      localRoot: "/Users/me",
      hosts: [host],
    });
    expect(view.root).toBe("/home/emmanuel");
  });
});

describe("activeRemoteProfile", () => {
  it("is null for local tabs and editors", () => {
    expect(activeRemoteProfile(terminal())).toBeNull();
    expect(
      activeRemoteProfile({
        id: 1,
        kind: "editor",
        spaceId: "s",
        title: "x",
        path: "/x",
        dirty: false,
        preview: false,
      } as Tab),
    ).toBeNull();
  });
});
