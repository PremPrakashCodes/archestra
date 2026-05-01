import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  PathEscapeError,
  resolveSafePath,
  resolveSafeParent,
  isInsideWorkspace,
  validateArchiveEntryName,
} from "./path-guard.js";

let workspace: string;
let outsideRoot: string;

beforeEach(() => {
  // Use realpath-canonicalized tempdirs so symlink tests on macOS (/tmp -> /private/tmp)
  // do not produce false escapes on the canonicalized comparison.
  const realTmp = require("node:fs").realpathSync(tmpdir());
  workspace = mkdtempSync(join(realTmp, "sandbox-ws-"));
  outsideRoot = mkdtempSync(join(realTmp, "sandbox-outside-"));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

describe("isInsideWorkspace", () => {
  it("accepts the workspace root itself", () => {
    expect(isInsideWorkspace(workspace, workspace)).toBe(true);
  });

  it("accepts paths nested under the workspace", () => {
    expect(isInsideWorkspace(join(workspace, "a", "b"), workspace)).toBe(true);
  });

  it("rejects sibling paths that share a string prefix", () => {
    // /workspace2/foo should NOT be accepted when root is /workspace,
    // even though startsWith() naively says yes. This is the classic
    // string-prefix-vs-path-prefix bug we want to make impossible.
    expect(isInsideWorkspace(`${workspace}2${sep}foo`, workspace)).toBe(false);
  });

  it("rejects paths outside the workspace", () => {
    expect(isInsideWorkspace(outsideRoot, workspace)).toBe(false);
    expect(isInsideWorkspace("/etc/passwd", workspace)).toBe(false);
  });
});

describe("resolveSafePath (file_read / file_list)", () => {
  it("resolves a workspace-relative path", async () => {
    writeFileSync(join(workspace, "data.csv"), "x,y\n1,2\n");
    const resolved = await resolveSafePath("data.csv", workspace);
    expect(resolved).toBe(join(workspace, "data.csv"));
  });

  it("rejects ../ traversal", async () => {
    await expect(resolveSafePath("../etc/passwd", workspace)).rejects.toBeInstanceOf(
      PathEscapeError,
    );
  });

  it("rejects nested ../ traversal back into the workspace", async () => {
    // Normalises out, but we still want to reject any path expression
    // whose canonical form is outside the workspace.
    await expect(
      resolveSafePath("a/../../etc/passwd", workspace),
    ).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects absolute paths outside the workspace", async () => {
    await expect(resolveSafePath("/etc/passwd", workspace)).rejects.toBeInstanceOf(
      PathEscapeError,
    );
  });

  it("rejects paths whose realpath escapes via a symlink chain", async () => {
    // /workspace/escape -> /tmp/sandbox-outside-XXX/secret
    // Even though "escape" is a valid name inside /workspace, realpath
    // resolution must follow the symlink and reject because the target
    // sits outside.
    const target = join(outsideRoot, "secret");
    writeFileSync(target, "shh");
    symlinkSync(target, join(workspace, "escape"));
    await expect(resolveSafePath("escape", workspace)).rejects.toBeInstanceOf(
      PathEscapeError,
    );
  });

  it("rejects sibling-prefix attacks (workspace=/foo, target=/foo2)", async () => {
    // Build a sibling directory whose name starts with the workspace name.
    const sibling = `${workspace}2`;
    mkdirSync(sibling);
    writeFileSync(join(sibling, "a.txt"), "x");
    try {
      await expect(
        resolveSafePath(join(sibling, "a.txt"), workspace),
      ).rejects.toBeInstanceOf(PathEscapeError);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

describe("resolveSafeParent (file_write to a new file)", () => {
  it("returns the resolved absolute path for a brand-new file", async () => {
    const resolved = await resolveSafeParent("new.txt", workspace);
    expect(resolved).toBe(join(workspace, "new.txt"));
  });

  it("creates a path under a nested non-existent dir only when explicitly told to", async () => {
    // Without parent creation, the parent must exist already.
    await expect(
      resolveSafeParent("missing-dir/new.txt", workspace),
    ).rejects.toThrow();
  });

  it("rejects a write whose parent escapes via realpath symlink", async () => {
    symlinkSync(outsideRoot, join(workspace, "outlink"));
    await expect(
      resolveSafeParent("outlink/new.txt", workspace),
    ).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("rejects ../ in a write path", async () => {
    await expect(
      resolveSafeParent("../etc/passwd", workspace),
    ).rejects.toBeInstanceOf(PathEscapeError);
  });
});

describe("validateArchiveEntryName (zip-slip + absolute injection)", () => {
  it("accepts a normal nested entry", () => {
    expect(() => validateArchiveEntryName("data/a.csv")).not.toThrow();
  });

  it("rejects ../ traversal", () => {
    expect(() => validateArchiveEntryName("../evil.txt")).toThrow(PathEscapeError);
  });

  it("rejects nested ../", () => {
    expect(() => validateArchiveEntryName("inner/../../evil.txt")).toThrow(
      PathEscapeError,
    );
  });

  it("rejects absolute entry names", () => {
    expect(() => validateArchiveEntryName("/etc/passwd")).toThrow(PathEscapeError);
  });

  it("rejects Windows-style drive-letter absolute entries", () => {
    expect(() => validateArchiveEntryName("C:\\evil.txt")).toThrow(PathEscapeError);
  });

  it("rejects entries containing null bytes", () => {
    expect(() => validateArchiveEntryName("a\x00b.txt")).toThrow(PathEscapeError);
  });

  it("rejects backslash-separated traversal (zip-slip on cross-platform archives)", () => {
    expect(() => validateArchiveEntryName("..\\evil.txt")).toThrow(PathEscapeError);
  });
});
