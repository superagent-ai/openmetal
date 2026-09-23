import { sql } from "drizzle-orm";
import { parseTopic } from "@openmetal/events";
import type { MetalDb } from "./client.js";

// realtime.send writes to realtime.messages, which Supabase Realtime delivers only after the
// surrounding transaction commits. It downgrades its own failures to warnings, so a lost
// broadcast never rolls back the caller; clients recover missed events by cursor.
export async function sendRealtimeBroadcast(
  db: MetalDb,
  input: { topic: string; event: string; payload: unknown },
): Promise<void> {
  parseTopic(input.topic);
  await db.execute(
    sql`select realtime.send(${JSON.stringify(input.payload)}::jsonb, ${input.event}, ${input.topic}, true)`,
  );
}
