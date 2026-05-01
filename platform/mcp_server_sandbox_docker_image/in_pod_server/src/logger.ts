// Tiny structured logger. The in-pod MCP server is intentionally
// dependency-light, so this writes JSON lines to stderr without pulling
// in a logging framework. The supervisor's stderr is captured by the
// pod's stdout/stderr stream and surfaced via `kubectl logs`.

type Level = "debug" | "info" | "warn" | "error";

const levelRank: Record<Level, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function currentMin(): number {
  const env = process.env.LOG_LEVEL?.toLowerCase() as Level | undefined;
  return levelRank[env ?? "info"] ?? levelRank.info;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (levelRank[level] < currentMin()) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg,
    ...fields,
  });
  process.stderr.write(line + "\n");
}

export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) =>
    emit("debug", msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) =>
    emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) =>
    emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) =>
    emit("error", msg, fields),
};
