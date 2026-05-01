// file_* tools — agent-facing filesystem surface, scoped to /workspace.
//
// Trust boundary: every input path goes through path-guard. Reads
// realpath the target; writes realpath the parent and reject if it
// resolves outside /workspace. Archive uploads are zip-slip checked
// before any extraction touches the filesystem.

import { Buffer } from "node:buffer";
import { promises as fs, createReadStream } from "node:fs";
import { dirname, join, basename, relative, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import yauzlImport, { type Entry, type ZipFile } from "yauzl";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ActivityProbe } from "../activity.js";
import {
  PathEscapeError,
  resolveSafePath,
  resolveSafeParent,
  validateArchiveEntryName,
} from "../path-guard.js";
import { ToolError, toolJson } from "./pty.js";

const yauzlOpen = promisify(yauzlImport.fromBuffer.bind(yauzlImport)) as (
  buffer: Buffer,
  options: { lazyEntries: true },
) => Promise<ZipFile>;

export interface FileToolDeps {
  workspace: string;
  activity: ActivityProbe;
  uploadMaxBytes: number;
  downloadMaxBytes: number;
}

export class FileManager {
  constructor(private readonly deps: FileToolDeps) {}

  async read(args: {
    path: string;
    encoding?: "utf8" | "base64";
    maxBytes?: number;
  }): Promise<{
    path: string;
    content: string;
    encoding: "utf8" | "base64";
    size: number;
  }> {
    const safe = await this.resolveRead(args.path);
    const stat = await fs.stat(safe);
    if (stat.isDirectory()) {
      throw new ToolError("IS_DIRECTORY", `${args.path} is a directory`);
    }
    const cap = Math.min(
      args.maxBytes ?? this.deps.downloadMaxBytes,
      this.deps.downloadMaxBytes,
    );
    if (stat.size > cap) {
      throw new ToolError(
        "SIZE_LIMIT",
        `file size ${stat.size} exceeds cap ${cap}`,
      );
    }
    const encoding = args.encoding ?? "utf8";
    const buf = await fs.readFile(safe);
    await this.deps.activity.touch();
    return {
      path: this.relativeForResponse(safe),
      content: encoding === "base64" ? buf.toString("base64") : buf.toString("utf8"),
      encoding,
      size: buf.length,
    };
  }

  async write(args: {
    path: string;
    content: string;
    encoding?: "utf8" | "base64";
    createParents?: boolean;
  }): Promise<{ path: string; size: number; sha256: string }> {
    const buf =
      (args.encoding ?? "utf8") === "base64"
        ? Buffer.from(args.content, "base64")
        : Buffer.from(args.content, "utf8");
    if (buf.length > this.deps.uploadMaxBytes) {
      throw new ToolError(
        "SIZE_LIMIT",
        `payload size ${buf.length} exceeds cap ${this.deps.uploadMaxBytes}`,
      );
    }
    const safeAbs = args.createParents
      ? await this.resolveWriteWithMkdir(args.path)
      : await resolveSafeParent(args.path, this.deps.workspace).catch(
          mapPathError,
        );

    await fs.writeFile(safeAbs, buf);

    // Post-write trust check: if the now-existing path realpaths to
    // somewhere outside the workspace (which can happen if the parent
    // was a writable symlink we missed), unlink and reject.
    const canonical = await fs.realpath(safeAbs);
    if (!isWithin(canonical, await fs.realpath(this.deps.workspace))) {
      await fs.unlink(safeAbs).catch(() => {});
      throw new ToolError(
        "PATH_ESCAPE",
        `write target's canonical path resolves outside the workspace: ${args.path}`,
      );
    }
    const sha = createHash("sha256").update(buf).digest("hex");
    await this.deps.activity.touch();
    return {
      path: this.relativeForResponse(canonical),
      size: buf.length,
      sha256: sha,
    };
  }

  async list(args: {
    path?: string;
    maxEntries?: number;
  }): Promise<{
    path: string;
    entries: Array<{
      name: string;
      type: "file" | "directory" | "symlink" | "other";
      size: number;
    }>;
    truncated: boolean;
  }> {
    const target = args.path ? args.path : ".";
    const safe = await this.resolveRead(target);
    const stat = await fs.stat(safe);
    if (!stat.isDirectory()) {
      throw new ToolError("NOT_DIRECTORY", `${target} is not a directory`);
    }
    const dirents = await fs.readdir(safe, { withFileTypes: true });
    const cap = Math.min(args.maxEntries ?? 1000, 5000);
    const sliced = dirents.slice(0, cap);
    const entries = await Promise.all(
      sliced.map(async (entry) => {
        const fullPath = join(safe, entry.name);
        let size = 0;
        let type: "file" | "directory" | "symlink" | "other" = "other";
        if (entry.isFile()) type = "file";
        else if (entry.isDirectory()) type = "directory";
        else if (entry.isSymbolicLink()) type = "symlink";
        if (entry.isFile()) {
          try {
            const s = await fs.stat(fullPath);
            size = s.size;
          } catch {
            size = 0;
          }
        }
        return { name: entry.name, type, size };
      }),
    );
    await this.deps.activity.touch();
    return {
      path: this.relativeForResponse(safe),
      entries,
      truncated: dirents.length > cap,
    };
  }

  // file_upload accepts an in-payload base64 blob. The streaming path
  // (multipart from the backend, no LLM tokens) lives in the platform
  // backend's /api/conversations/:id/sandbox/upload route — that route
  // delivers bytes via Exec.exec and bypasses this tool entirely.
  async upload(args: {
    path: string;
    contentBase64: string;
    extractIfArchive?: boolean;
  }): Promise<{
    path: string;
    size: number;
    sha256: string;
    extracted?: { entries: number };
  }> {
    const buf = Buffer.from(args.contentBase64, "base64");
    if (buf.length > this.deps.uploadMaxBytes) {
      throw new ToolError(
        "SIZE_LIMIT",
        `upload size ${buf.length} exceeds cap ${this.deps.uploadMaxBytes}`,
      );
    }

    const wantsExtract =
      args.extractIfArchive === true && /\.zip$/i.test(args.path);
    if (wantsExtract) {
      const extracted = await this.extractZipInto(args.path, buf);
      const sha = createHash("sha256").update(buf).digest("hex");
      await this.deps.activity.touch();
      return {
        path: this.relativeForResponse(extracted.targetDir),
        size: buf.length,
        sha256: sha,
        extracted: { entries: extracted.entries },
      };
    }

    const safeAbs = await resolveSafeParent(args.path, this.deps.workspace).catch(
      mapPathError,
    );
    await fs.writeFile(safeAbs, buf);
    const canonical = await fs.realpath(safeAbs);
    if (!isWithin(canonical, await fs.realpath(this.deps.workspace))) {
      await fs.unlink(safeAbs).catch(() => {});
      throw new ToolError(
        "PATH_ESCAPE",
        `upload target's canonical path resolves outside the workspace: ${args.path}`,
      );
    }
    const sha = createHash("sha256").update(buf).digest("hex");
    await this.deps.activity.touch();
    return {
      path: this.relativeForResponse(canonical),
      size: buf.length,
      sha256: sha,
    };
  }

  async download(args: { path: string }): Promise<{
    path: string;
    contentBase64: string;
    size: number;
    sha256: string;
  }> {
    const safe = await this.resolveRead(args.path);
    const stat = await fs.stat(safe);
    if (stat.isDirectory()) {
      throw new ToolError("IS_DIRECTORY", `${args.path} is a directory`);
    }
    if (stat.size > this.deps.downloadMaxBytes) {
      throw new ToolError(
        "SIZE_LIMIT",
        `file size ${stat.size} exceeds cap ${this.deps.downloadMaxBytes}`,
      );
    }
    const hash = createHash("sha256");
    const stream = createReadStream(safe);
    const chunks: Buffer[] = [];
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      chunks.push(chunk);
      hash.update(chunk);
    }
    const buf = Buffer.concat(chunks);
    await this.deps.activity.touch();
    return {
      path: this.relativeForResponse(safe),
      contentBase64: buf.toString("base64"),
      size: buf.length,
      sha256: hash.digest("hex"),
    };
  }

  private async resolveRead(input: string): Promise<string> {
    try {
      return await resolveSafePath(input, this.deps.workspace);
    } catch (err) {
      throw mapPathError(err);
    }
  }

  private async resolveWriteWithMkdir(input: string): Promise<string> {
    // Create parent directories step-by-step under the workspace root
    // so realpath always resolves to a known-safe location. Refuse if
    // the lexical resolution lands outside the workspace.
    const root = await fs.realpath(this.deps.workspace);
    const candidate = await resolveLexicalAbsolute(input, root);
    if (!isWithin(candidate, root)) {
      throw new ToolError(
        "PATH_ESCAPE",
        `path resolves outside the workspace: ${input}`,
      );
    }
    await fs.mkdir(dirname(candidate), { recursive: true });
    try {
      return await resolveSafeParent(input, this.deps.workspace);
    } catch (err) {
      throw mapPathError(err);
    }
  }

  private async extractZipInto(
    requestedPath: string,
    buf: Buffer,
  ): Promise<{ targetDir: string; entries: number }> {
    // Use the requested path's basename without the .zip suffix as the
    // extraction directory under the workspace.
    const dirName = basename(requestedPath, ".zip");
    if (!dirName || dirName.includes("..")) {
      throw new ToolError(
        "PATH_ESCAPE",
        `archive name resolves outside workspace: ${requestedPath}`,
      );
    }
    const safeRootAbs = await resolveSafeParent(
      dirName,
      this.deps.workspace,
    ).catch(mapPathError);
    const stagingRoot = `${safeRootAbs}.partial-${randomUUID()}`;
    await fs.mkdir(stagingRoot, { recursive: true });

    let zip: ZipFile | null = null;
    let totalBytes = 0;
    let entries = 0;
    try {
      try {
        zip = await yauzlOpen(buf, { lazyEntries: true });
      } catch (err) {
        // yauzl rejects malformed-or-malicious entry names while the
        // central directory is being read (e.g. "invalid relative
        // path: ../evil.txt"). Surface that as our PATH_ESCAPE shape
        // so callers see a uniform error code regardless of whether
        // our pre-validation or yauzl's caught the entry.
        if (
          err instanceof Error &&
          /invalid relative path|invalid characters/i.test(err.message)
        ) {
          throw new ToolError("PATH_ESCAPE", err.message);
        }
        throw new ToolError(
          "ARCHIVE_INVALID",
          `failed to open archive: ${(err as Error).message}`,
        );
      }
      // First pass: validate entry names before writing anything.
      const entryList: Entry[] = [];
      const collect = new Promise<void>((resolveEntries, rejectEntries) => {
        zip!.on("entry", (entry: Entry) => {
          try {
            validateArchiveEntryName(entry.fileName);
            entryList.push(entry);
            zip!.readEntry();
          } catch (err) {
            rejectEntries(err);
          }
        });
        zip!.on("end", () => resolveEntries());
        zip!.on("error", (err) => {
          if (
            err instanceof Error &&
            /invalid relative path|invalid characters/i.test(err.message)
          ) {
            rejectEntries(new ToolError("PATH_ESCAPE", err.message));
          } else {
            rejectEntries(err);
          }
        });
        zip!.readEntry();
      });
      await collect;

      // Second pass: extract.
      for (const entry of entryList) {
        const targetAbs = join(stagingRoot, entry.fileName);
        // Defense in depth: re-check after staging join.
        if (!isWithin(targetAbs, stagingRoot)) {
          throw new ToolError(
            "PATH_ESCAPE",
            `archive entry escapes staging root: ${entry.fileName}`,
          );
        }
        if (/\/$/.test(entry.fileName)) {
          await fs.mkdir(targetAbs, { recursive: true });
          continue;
        }
        await fs.mkdir(dirname(targetAbs), { recursive: true });
        await new Promise<void>((entryResolve, entryReject) => {
          zip!.openReadStream(entry, (err, readStream) => {
            if (err || !readStream) {
              entryReject(err ?? new Error("no read stream"));
              return;
            }
            const writeStream = require("node:fs").createWriteStream(targetAbs);
            readStream.on("data", (chunk: Buffer) => {
              totalBytes += chunk.length;
              if (totalBytes > this.deps.uploadMaxBytes * 4) {
                readStream.destroy(
                  new ToolError(
                    "SIZE_LIMIT",
                    `extracted bytes ${totalBytes} exceed expansion cap`,
                  ),
                );
              }
            });
            readStream.on("error", entryReject);
            writeStream.on("error", entryReject);
            writeStream.on("close", () => entryResolve());
            readStream.pipe(writeStream);
          });
        });
        entries += 1;
      }

      // Atomic-ish rename. If a directory with the target name already
      // exists, leave the staging tree behind and let the caller decide.
      try {
        await fs.rename(stagingRoot, safeRootAbs);
      } catch (err) {
        const e = err as NodeJS.ErrnoException;
        if (e.code === "ENOTEMPTY" || e.code === "EEXIST") {
          throw new ToolError(
            "TARGET_EXISTS",
            `target ${dirName} already exists; refuse to overwrite`,
          );
        }
        throw err;
      }
      return { targetDir: safeRootAbs, entries };
    } finally {
      if (zip) {
        try {
          zip.close();
        } catch {
          // ignore
        }
      }
      // Best-effort staging cleanup if rename did not complete.
      try {
        await fs.rm(stagingRoot, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  private relativeForResponse(absolute: string): string {
    const rel = relative(this.deps.workspace, absolute);
    if (rel === "") return "/";
    return rel.split(sep).join("/");
  }
}

function mapPathError(err: unknown): never {
  if (err instanceof PathEscapeError) {
    throw new ToolError("PATH_ESCAPE", err.message);
  }
  if (err instanceof Error) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") {
      throw new ToolError("NOT_FOUND", err.message);
    }
  }
  throw err as Error;
}

function isWithin(target: string, root: string): boolean {
  if (target === root) return true;
  const rel = relative(root, target);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (rel.split(sep).includes("..")) return false;
  return true;
}

async function resolveLexicalAbsolute(
  input: string,
  root: string,
): Promise<string> {
  // Standard path.resolve normalizes `..` segments without touching the
  // filesystem. Use that to detect lexical escape before any disk IO.
  const { resolve, isAbsolute } = await import("node:path");
  return isAbsolute(input) ? input : resolve(root, input);
}

export function registerFileTools(server: McpServer, manager: FileManager): void {
  server.registerTool(
    "file_read",
    {
      description:
        "Read a file inside /workspace. Returns content as utf8 (default) or base64.",
      inputSchema: {
        path: z.string().min(1),
        encoding: z.enum(["utf8", "base64"]).optional(),
        maxBytes: z.number().int().positive().optional(),
      },
    },
    async (args) => toolJson(await manager.read(args)),
  );

  server.registerTool(
    "file_write",
    {
      description:
        "Write a file inside /workspace. Encoding defaults to utf8; pass base64 for binary content. Existing files are overwritten.",
      inputSchema: {
        path: z.string().min(1),
        content: z.string(),
        encoding: z.enum(["utf8", "base64"]).optional(),
        createParents: z
          .boolean()
          .optional()
          .describe("Create parent directories if missing. Defaults to false."),
      },
    },
    async (args) => toolJson(await manager.write(args)),
  );

  server.registerTool(
    "file_list",
    {
      description: "List the entries of a directory inside /workspace.",
      inputSchema: {
        path: z.string().optional(),
        maxEntries: z.number().int().positive().optional(),
      },
    },
    async (args) => toolJson(await manager.list(args ?? {})),
  );

  server.registerTool(
    "file_upload",
    {
      description:
        "Upload a base64-encoded file into /workspace. For larger payloads, use the platform's drag-and-drop panel which streams bytes directly without spending tokens.",
      inputSchema: {
        path: z.string().min(1),
        contentBase64: z.string(),
        extractIfArchive: z
          .boolean()
          .optional()
          .describe(
            "If true and path ends in .zip, extract to a directory of the same basename. zip-slip checked.",
          ),
      },
    },
    async (args) => toolJson(await manager.upload(args)),
  );

  server.registerTool(
    "file_download",
    {
      description:
        "Read a file inside /workspace and return it base64-encoded. Subject to the download size cap.",
      inputSchema: {
        path: z.string().min(1),
      },
    },
    async (args) => toolJson(await manager.download(args)),
  );
}
