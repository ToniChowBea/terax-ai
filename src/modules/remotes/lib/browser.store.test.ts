import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: class {} }));

import { useRemoteBrowserStore } from "./browser";

const listing: Record<string, unknown[]> = {
  "/home/me": [{ name: "dev", kind: "dir", size: 0, mtime: 0, gitignored: false }],
  "/home/me/dev": [
    { name: "app.ts", kind: "file", size: 1, mtime: 0, gitignored: false },
  ],
};

describe("remote browser store", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation(async (cmd: string, args: { path: string }) => {
      if (cmd === "fs_read_dir") return listing[args.path] ?? [];
      return undefined;
    });
    useRemoteBrowserStore.setState({
      profileId: "h1",
      conn: 7,
      home: "/home/me",
      cwd: "",
      dirs: {},
      expanded: new Set(),
      connecting: false,
      error: null,
    });
  });

  // Regression: clicking a folder used to type `cd '<path>'` into the
  // terminal. Expanding must only list the directory, over SFTP.
  it("expands a folder in place without touching the terminal or the root", async () => {
    const s = useRemoteBrowserStore.getState();
    await s.navigate("/home/me");
    await s.toggle("/home/me/dev");

    const st = useRemoteBrowserStore.getState();
    expect(st.cwd).toBe("/home/me");
    expect(st.expanded.has("/home/me/dev")).toBe(true);
    expect(st.dirs["/home/me/dev"]).toMatchObject({ status: "loaded" });
    const commands = invoke.mock.calls.map((c) => c[0]);
    expect(new Set(commands)).toEqual(new Set(["fs_read_dir"]));
    for (const [, args] of invoke.mock.calls) {
      expect(args.workspace).toEqual({ kind: "ssh", conn: 7, profileId: "h1" });
    }

    await useRemoteBrowserStore.getState().toggle("/home/me/dev");
    expect(useRemoteBrowserStore.getState().expanded.has("/home/me/dev")).toBe(
      false,
    );
  });
});
