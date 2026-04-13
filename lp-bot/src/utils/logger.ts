type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? "info";

export class Logger {
  constructor(private prefix: string) {}

  debug(msg: string, ...args: unknown[]) { this.log("debug", msg, args); }
  info(msg: string, ...args: unknown[])  { this.log("info",  msg, args); }
  warn(msg: string, ...args: unknown[])  { this.log("warn",  msg, args); }
  error(msg: string, ...args: unknown[]) { this.log("error", msg, args); }

  private log(level: LogLevel, msg: string, args: unknown[]) {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[MIN_LEVEL]) return;

    const ts = new Date().toISOString().slice(11, 19);
    const icons: Record<LogLevel, string> = { debug: "🔍", info: "ℹ️ ", warn: "⚠️ ", error: "🔴" };
    const out = `[${ts}] ${icons[level]} [${this.prefix}] ${msg}`;

    if (level === "error") console.error(out, ...args);
    else console.log(out, ...args);
  }
}
