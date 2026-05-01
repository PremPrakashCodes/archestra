import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore, extractBearer } from "./auth.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sandbox-auth-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("extractBearer", () => {
  it("extracts a bearer token", () => {
    expect(extractBearer("Bearer abc123")).toBe("abc123");
  });

  it("is case-insensitive on the scheme", () => {
    expect(extractBearer("bearer abc123")).toBe("abc123");
  });

  it("returns null for missing header", () => {
    expect(extractBearer(undefined)).toBeNull();
  });

  it("returns null for non-bearer schemes", () => {
    expect(extractBearer("Basic abc123")).toBeNull();
  });
});

describe("TokenStore", () => {
  it("loads the initial token from disk", async () => {
    const file = join(dir, "token");
    writeFileSync(file, "secret-1\n");
    const store = new TokenStore(file);
    await store.start();
    try {
      expect(store.verify("secret-1")).toBe(true);
      expect(store.verify("secret-2")).toBe(false);
      expect(store.verify("")).toBe(false);
    } finally {
      store.stop();
    }
  });

  it("reloads the token when the file changes", async () => {
    const file = join(dir, "token");
    writeFileSync(file, "first");
    const store = new TokenStore(file);
    await store.start();
    try {
      expect(store.verify("first")).toBe(true);
      // Bump mtime explicitly: writeFileSync within the same second can
      // leave mtimeMs unchanged on some filesystems. The poll-based
      // reload key is mtime, so test a real change.
      const future = new Date(Date.now() + 2000);
      writeFileSync(file, "second");
      const { utimesSync } = await import("node:fs");
      utimesSync(file, future, future);
      await store.refresh();
      expect(store.verify("first")).toBe(false);
      expect(store.verify("second")).toBe(true);
    } finally {
      store.stop();
    }
  });

  it("rejects every request when the token file is empty", async () => {
    const file = join(dir, "token");
    writeFileSync(file, "");
    const store = new TokenStore(file);
    await store.start();
    try {
      expect(store.verify("")).toBe(false);
      expect(store.verify("anything")).toBe(false);
    } finally {
      store.stop();
    }
  });
});

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}
