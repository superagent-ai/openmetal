import { readFile } from "node:fs/promises";
import type { z } from "zod";
import type { CliIo } from "./io.js";

export async function readJsonInput(
  io: CliIo,
  options: { file?: string; stdin?: boolean },
): Promise<unknown> {
  if (options.file && options.stdin) throw new Error("use only one of --file or --stdin");
  if (!options.file && !options.stdin) throw new Error("provide --file <path> or --stdin");
  const raw = options.file ? await readFile(options.file, "utf8") : await readAll(io.stdin);
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `invalid JSON input: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function parseJsonInput<T>(
  io: CliIo,
  options: { file?: string; stdin?: boolean },
  schema: z.ZodType<T>,
): Promise<T> {
  return schema.parse(await readJsonInput(io, options));
}

async function readAll(stream: NodeJS.ReadStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
