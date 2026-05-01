// Path containment and zip-slip guards.
//
// The single trust boundary for every file_* tool is "the canonical
// realpath of the target lives inside the canonical realpath of the
// workspace." String-prefix checks are insufficient — `/workspace2`
// shares a prefix with `/workspace`. Symlinks must be resolved.
// Archive entries must be checked before extraction, because once the
// extraction has touched the filesystem the trust boundary is already
// breached.

import { promises as fs } from "node:fs";
import { isAbsolute, normalize, relative, resolve, sep, dirname } from "node:path";

export class PathEscapeError extends Error {
  readonly code = "PATH_ESCAPE";
  constructor(
    message: string,
    public readonly attemptedPath: string,
  ) {
    super(message);
    this.name = "PathEscapeError";
  }
}

// True iff `target` (already absolute) lies at or below `root` (already
// canonical absolute). Uses path.relative, which is the only correct
// way to do this check across platforms — startsWith() is insufficient
// because it accepts /foo2 as a child of /foo.
export function isInsideWorkspace(target: string, root: string): boolean {
  if (!isAbsolute(target) || !isAbsolute(root)) return false;
  const rel = relative(root, target);
  if (rel === "") return true;
  if (rel.startsWith("..")) return false;
  if (rel.split(sep).includes("..")) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

// Resolve a workspace-relative or absolute path to its canonical form
// for read-side operations (file_read, file_list, file_download).
// Both the workspace root and the target are realpath-canonicalized,
// so any symlink chain — even one whose final hop sits outside the
// workspace — is rejected.
export async function resolveSafePath(
  input: string,
  workspaceRoot: string,
): Promise<string> {
  const root = await canonicalRoot(workspaceRoot);
  const candidate = isAbsolute(input) ? input : resolve(root, input);

  // Lexical check first. path.resolve normalizes `..` segments so a
  // traversal whose target doesn't exist (e.g. ../etc/passwd in a
  // tempdir) lands outside the workspace lexically. Realpath would
  // still throw ENOENT here, but a PATH_ESCAPE error is the correct
  // signal for the caller — there's no point in distinguishing
  // "outside-and-missing" from "outside-but-real".
  if (!isInsideWorkspace(candidate, root)) {
    throw new PathEscapeError(
      `path resolves outside the workspace: ${input}`,
      input,
    );
  }

  // Realpath catches symlink chains whose final hop sits outside.
  const canonical = await fs.realpath(candidate);
  if (!isInsideWorkspace(canonical, root)) {
    throw new PathEscapeError(
      `path resolves outside the workspace via symlink: ${input}`,
      input,
    );
  }
  return canonical;
}

// Resolve a workspace-relative or absolute path for write-side
// operations (file_write, file_upload). The target file may not exist
// yet, but its parent directory MUST exist and MUST canonicalize to a
// location inside the workspace. Returns the absolute path the caller
// should write to (parent canonical + basename — so symlinks beneath
// the parent are not silently followed for the new file itself).
export async function resolveSafeParent(
  input: string,
  workspaceRoot: string,
): Promise<string> {
  const root = await canonicalRoot(workspaceRoot);
  const absolute = isAbsolute(input) ? input : resolve(root, input);

  // Reject obvious traversal in the requested string itself before
  // any filesystem work — defense in depth.
  if (normalize(input).split(/[\\/]/).includes("..")) {
    throw new PathEscapeError(`path contains '..' traversal: ${input}`, input);
  }

  const parent = dirname(absolute);
  const canonicalParent = await fs.realpath(parent);
  if (!isInsideWorkspace(canonicalParent, root)) {
    throw new PathEscapeError(
      `write target's parent is outside the workspace: ${input}`,
      input,
    );
  }
  const base = absolute.slice(absolute.lastIndexOf(sep) + 1);
  return resolve(canonicalParent, base);
}

// Validate an archive entry name *before* extraction. zip-slip works by
// putting `../` segments in entry names so that extraction writes
// outside the destination directory. The defense is to refuse the
// entire archive at the first malicious entry — anything else means
// state is already on disk.
export function validateArchiveEntryName(name: string): void {
  if (name.includes("\x00")) {
    throw new PathEscapeError(`archive entry contains null byte`, name);
  }
  if (isAbsolute(name)) {
    throw new PathEscapeError(`archive entry is absolute: ${name}`, name);
  }
  // Windows drive-letter absolutes are not caught by isAbsolute on POSIX hosts.
  if (/^[A-Za-z]:[\\/]/.test(name)) {
    throw new PathEscapeError(
      `archive entry has Windows drive prefix: ${name}`,
      name,
    );
  }
  // Backslashes can appear in cross-platform archives; treat them as
  // separators for traversal purposes.
  const segments = name.split(/[\\/]/);
  if (segments.includes("..")) {
    throw new PathEscapeError(
      `archive entry contains '..' traversal: ${name}`,
      name,
    );
  }
  // Reject leading sep just in case isAbsolute didn't catch it on a
  // mixed-style entry like `\foo\bar`.
  if (segments[0] === "") {
    throw new PathEscapeError(
      `archive entry is rooted (leading separator): ${name}`,
      name,
    );
  }
}

async function canonicalRoot(workspaceRoot: string): Promise<string> {
  if (!isAbsolute(workspaceRoot)) {
    throw new Error(`workspace root must be absolute, got: ${workspaceRoot}`);
  }
  return fs.realpath(workspaceRoot);
}
