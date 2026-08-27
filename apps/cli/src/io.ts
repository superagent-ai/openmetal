import { createInterface } from "node:readline/promises";

export type CliIo = {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
};

export const processIo: CliIo = {
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
};

export type OutputOptions = {
  json?: boolean;
  color?: boolean;
};

export function writeResult(io: CliIo, value: unknown, options: OutputOptions = {}): void {
  if (options.json || !io.stdout.isTTY) {
    io.stdout.write(`${JSON.stringify(value, null, options.json ? 2 : 0)}\n`);
    return;
  }

  if (isTabular(value)) {
    io.stdout.write(`${renderTable(value)}\n`);
    return;
  }
  if (isRecord(value)) {
    const collections = Object.entries(value).filter(([, child]) => isTabular(child));
    if (collections.length === 1) {
      const collection = collections[0] as [string, Record<string, unknown>[]];
      io.stdout.write(`${renderTable(collection[1] as Record<string, unknown>[])}\n`);
      if ("next_cursor" in value && value.next_cursor) {
        io.stdout.write(`Next cursor: ${String(value.next_cursor)}\n`);
      }
      return;
    }
    const rows = Object.entries(value).map(([field, child]) => ({
      field,
      value: displayValue(child),
    }));
    io.stdout.write(`${renderTable(rows)}\n`);
    return;
  }
  io.stdout.write(`${String(value)}\n`);
}

export function writeText(io: CliIo, value: string): void {
  io.stdout.write(`${value}\n`);
}

export function writeError(
  io: CliIo,
  message: string,
  details?: { code?: string; requestId?: string },
): void {
  const prefix = details?.code ? `${details.code}: ` : "";
  io.stderr.write(`${prefix}${message}\n`);
  if (details?.requestId) io.stderr.write(`request_id: ${details.requestId}\n`);
}

export async function promptLine(io: CliIo, message: string): Promise<string> {
  const readline = createInterface({ input: io.stdin, output: io.stdout });
  try {
    return (await readline.question(`${message}: `)).trim();
  } finally {
    readline.close();
  }
}

export async function promptSecret(io: CliIo, message: string): Promise<string> {
  if (!io.stdin.isTTY || typeof io.stdin.setRawMode !== "function") {
    return promptLine(io, message);
  }

  io.stdout.write(`${message}: `);
  io.stdin.setRawMode(true);
  io.stdin.resume();
  io.stdin.setEncoding("utf8");

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = () => {
      io.stdin.off("data", onData);
      io.stdin.setRawMode(false);
      io.stdin.pause();
      io.stdout.write("\n");
    };
    const onData = (chunk: string | Buffer) => {
      const text = String(chunk);
      for (const character of text) {
        if (character === "\u0003") {
          finish();
          reject(new Error("cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u007f") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            io.stdout.write("\b \b");
          }
          continue;
        }
        value += character;
        io.stdout.write("*");
      }
    };
    io.stdin.on("data", onData);
  });
}

export async function confirm(
  io: CliIo,
  message: string,
  options: { yes?: boolean; noInput?: boolean } = {},
): Promise<void> {
  if (options.yes) return;
  if (options.noInput || !io.stdin.isTTY) {
    throw new Error(`${message}; rerun with --yes to confirm`);
  }
  const answer = (await promptLine(io, `${message} [y/N]`)).toLowerCase();
  if (answer !== "y" && answer !== "yes") throw new Error("cancelled");
}

export async function choose<T>(
  io: CliIo,
  message: string,
  values: T[],
  label: (value: T) => string,
): Promise<T> {
  if (values.length === 0) throw new Error(`no values available for ${message.toLowerCase()}`);
  if (values.length === 1) return values[0] as T;
  if (!io.stdin.isTTY)
    throw new Error(`${message} requires an explicit flag in non-interactive mode`);

  io.stdout.write(`${message}:\n`);
  values.forEach((value, index) => io.stdout.write(`  ${index + 1}) ${label(value)}\n`));
  const answer = Number(await promptLine(io, "Selection"));
  const selected = Number.isInteger(answer) ? values[answer - 1] : undefined;
  if (!selected) throw new Error("invalid selection");
  return selected;
}

function isTabular(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.length > 0 && value.every(isRecord);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function renderTable(rows: Record<string, unknown>[]): string {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const widths = keys.map((key) =>
    Math.min(60, Math.max(key.length, ...rows.map((row) => displayValue(row[key]).length))),
  );
  const render = (values: string[]) =>
    values
      .map((value, index) => {
        const width = widths[index] ?? 0;
        return truncate(value, width).padEnd(width);
      })
      .join("  ");
  return [
    render(keys.map((key) => key.toUpperCase())),
    render(widths.map((width) => "-".repeat(width))),
    ...rows.map((row) => render(keys.map((key) => displayValue(row[key])))),
  ].join("\n");
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return width <= 1 ? value.slice(0, width) : `${value.slice(0, width - 1)}…`;
}
