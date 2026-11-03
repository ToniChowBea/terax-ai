import { describe, expect, it } from "vitest";
import { joinRemote, parentRemote } from "./browser";

describe("joinRemote", () => {
  it("does not double the separator at the root", () => {
    expect(joinRemote("/", "etc")).toBe("/etc");
  });

  it("joins under a nested directory", () => {
    expect(joinRemote("/home/me", "notes.txt")).toBe("/home/me/notes.txt");
  });
});

describe("parentRemote", () => {
  it("has no parent above the root", () => {
    expect(parentRemote("/")).toBeNull();
    expect(parentRemote("")).toBeNull();
  });

  it("returns the root rather than an empty string one level down", () => {
    expect(parentRemote("/etc")).toBe("/");
  });

  it("walks up a nested path", () => {
    expect(parentRemote("/home/me/src")).toBe("/home/me");
  });
});

import { flattenTree } from "./browser";
import type { DirEntry } from "@/modules/explorer/lib/useFileTree";

const e = (name: string, kind: "dir" | "file"): DirEntry =>
  ({ name, kind, size: 0, mtime: 0, gitignored: false }) as DirEntry;

describe("flattenTree", () => {
  const dirs = {
    "/home/me": {
      status: "loaded" as const,
      entries: [e("dev", "dir"), e("notes.txt", "file")],
    },
    "/home/me/dev": {
      status: "loaded" as const,
      entries: [e("app", "dir"), e("README.md", "file")],
    },
    "/home/me/dev/app": {
      status: "loaded" as const,
      entries: [e("main.rs", "file")],
    },
  };

  it("lists only the root's children while nothing is expanded", () => {
    const rows = flattenTree("/home/me", dirs, new Set());
    expect(rows.map((r) => r.path)).toEqual([
      "/home/me/dev",
      "/home/me/notes.txt",
    ]);
    expect(rows.every((r) => r.depth === 0 && !r.expanded)).toBe(true);
  });

  it("expands in place, nesting children under their folder", () => {
    const rows = flattenTree(
      "/home/me",
      dirs,
      new Set(["/home/me/dev", "/home/me/dev/app"]),
    );
    expect(rows.map((r) => [r.path, r.depth])).toEqual([
      ["/home/me/dev", 0],
      ["/home/me/dev/app", 1],
      ["/home/me/dev/app/main.rs", 2],
      ["/home/me/dev/README.md", 1],
      ["/home/me/notes.txt", 0],
    ]);
  });

  it("shows an expanded folder whose listing is still loading as empty", () => {
    const rows = flattenTree(
      "/home/me",
      { "/home/me": dirs["/home/me"] },
      new Set(["/home/me/dev"]),
    );
    expect(rows.map((r) => r.path)).toEqual([
      "/home/me/dev",
      "/home/me/notes.txt",
    ]);
    expect(rows[0].expanded).toBe(true);
  });
});
