import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import { ActivityProbe } from "../activity.js";
import { FileManager } from "./file.js";
import { ToolError } from "./pty.js";

let workspace: string;
let outsideRoot: string;
let activityFile: string;
let manager: FileManager;

beforeEach(() => {
  const realTmp = realpathSync(tmpdir());
  workspace = mkdtempSync(join(realTmp, "sandbox-file-ws-"));
  outsideRoot = mkdtempSync(join(realTmp, "sandbox-file-out-"));
  activityFile = join(workspace, ".activity");
  writeFileSync(activityFile, "");
  manager = new FileManager({
    workspace,
    activity: new ActivityProbe(activityFile),
    uploadMaxBytes: 16 * 1024 * 1024,
    downloadMaxBytes: 64 * 1024 * 1024,
  });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

describe("file_read / file_write happy path", () => {
  it("round-trips utf8 content", async () => {
    await manager.write({ path: "hello.txt", content: "world" });
    const got = await manager.read({ path: "hello.txt" });
    expect(got.content).toBe("world");
    expect(got.encoding).toBe("utf8");
    expect(got.size).toBe(5);
    expect(got.path).toBe("hello.txt");
  });

  it("round-trips base64 content", async () => {
    const bytes = Buffer.from([0, 1, 2, 3, 254, 255]);
    await manager.write({
      path: "bin.dat",
      content: bytes.toString("base64"),
      encoding: "base64",
    });
    const got = await manager.read({ path: "bin.dat", encoding: "base64" });
    expect(Buffer.from(got.content, "base64").equals(bytes)).toBe(true);
  });
});

describe("file_write path-escape rejections", () => {
  it("rejects ../ traversal", async () => {
    await expect(
      manager.write({ path: "../escape.txt", content: "x" }),
    ).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });

  it("rejects symlink-aimed parent that points outside the workspace", async () => {
    symlinkSync(outsideRoot, join(workspace, "outlink"));
    await expect(
      manager.write({ path: "outlink/escape.txt", content: "x" }),
    ).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });

  it("rejects size-cap violations", async () => {
    const tiny = new FileManager({
      workspace,
      activity: new ActivityProbe(activityFile),
      uploadMaxBytes: 4,
      downloadMaxBytes: 4,
    });
    await expect(
      tiny.write({ path: "big.txt", content: "more than four bytes" }),
    ).rejects.toMatchObject({ code: "SIZE_LIMIT" });
  });
});

describe("file_upload archive zip-slip", () => {
  it("rejects an archive whose entry escapes via ..", async () => {
    // Hand-craft a tiny zip containing one entry "../evil.txt".
    // Use yauzl's sister yazl to build it. yazl is not a dep here, so
    // we build a known-malicious zip with the 'jszip' style minimal
    // structure via a static fixture.
    const malicious = await fixtureMaliciousZip();
    await expect(
      manager.upload({
        path: "archive.zip",
        contentBase64: malicious.toString("base64"),
        extractIfArchive: true,
      }),
    ).rejects.toMatchObject({ code: "PATH_ESCAPE" });
  });

  it("size-caps an oversized payload before extraction", async () => {
    const tiny = new FileManager({
      workspace,
      activity: new ActivityProbe(activityFile),
      uploadMaxBytes: 16,
      downloadMaxBytes: 16,
    });
    const big = Buffer.alloc(64, 0xab);
    await expect(
      tiny.upload({
        path: "x.bin",
        contentBase64: big.toString("base64"),
        extractIfArchive: false,
      }),
    ).rejects.toMatchObject({ code: "SIZE_LIMIT" });
  });
});

describe("file_list", () => {
  it("lists the workspace root by default", async () => {
    await manager.write({ path: "a.txt", content: "1" });
    await manager.write({ path: "b.txt", content: "2" });
    const got = await manager.list({});
    const names = got.entries.map((e) => e.name).sort();
    expect(names).toContain("a.txt");
    expect(names).toContain("b.txt");
  });

  it("rejects listing outside the workspace", async () => {
    await expect(manager.list({ path: "../" })).rejects.toMatchObject({
      code: "PATH_ESCAPE",
    });
  });
});

describe("file_download", () => {
  it("returns base64 + sha256", async () => {
    const bytes = Buffer.from("hello world");
    await manager.write({
      path: "h.bin",
      content: bytes.toString("base64"),
      encoding: "base64",
    });
    const got = await manager.download({ path: "h.bin" });
    expect(Buffer.from(got.contentBase64, "base64").equals(bytes)).toBe(true);
    expect(got.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

// Build a minimal zip whose only entry is "../evil.txt". This matches
// the on-the-wire format yauzl reads. Built with an inline buffer
// rather than pulling in another archive lib at test time.
async function fixtureMaliciousZip(): Promise<Buffer> {
  // Use Node's zlib to deflate the entry payload.
  const { deflateRawSync } = await import("node:zlib");
  const filename = "../evil.txt";
  const fileData = Buffer.from("malicious payload");
  const compressed = deflateRawSync(fileData);

  // Local file header
  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0); // signature
  localHeader.writeUInt16LE(20, 4); // version
  localHeader.writeUInt16LE(0, 6); // flags
  localHeader.writeUInt16LE(8, 8); // method = deflate
  localHeader.writeUInt16LE(0, 10); // mod time
  localHeader.writeUInt16LE(0, 12); // mod date
  localHeader.writeUInt32LE(crc32(fileData), 14);
  localHeader.writeUInt32LE(compressed.length, 18);
  localHeader.writeUInt32LE(fileData.length, 22);
  localHeader.writeUInt16LE(filename.length, 26);
  localHeader.writeUInt16LE(0, 28);
  const filenameBuf = Buffer.from(filename, "utf8");
  const localChunk = Buffer.concat([localHeader, filenameBuf, compressed]);

  // Central directory header
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc32(fileData), 16);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(fileData.length, 24);
  central.writeUInt16LE(filename.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38); // external attrs
  central.writeUInt32LE(0, 42); // local header offset
  const centralChunk = Buffer.concat([central, filenameBuf]);

  // End-of-central-directory record
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralChunk.length, 12);
  eocd.writeUInt32LE(localChunk.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localChunk, centralChunk, eocd]);
}

function crc32(buf: Buffer): number {
  const TABLE = (() => {
    const t = new Array<number>(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      t[i] = c;
    }
    return t;
  })();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = TABLE[(crc ^ buf[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Silence unused import warning when ToolError is referenced indirectly
// by toMatchObject({ code: ... }) instead of instanceof.
void ToolError;
