import { and, desc, eq, gt } from "drizzle-orm";
import { domainEvents, type MetalDb } from "@openmetal/db";
import { CursorError, parseCursor, serializeCursor, toPublicEvent } from "@openmetal/events";
import { getProject } from "./services.js";

export async function listProjectEvents(
  db: MetalDb,
  input: { userId: string; projectId: string; after?: string; limit: number },
) {
  const project = await getProject(db, input.userId, input.projectId);
  const after = input.after ? parseCursor(input.after) : 0n;
  if (input.after) {
    const cursorEvent = await db
      .select({ projectId: domainEvents.projectId })
      .from(domainEvents)
      .where(eq(domainEvents.cursor, after))
      .then((rows) => rows[0]);
    if (!cursorEvent || cursorEvent.projectId !== project.id) {
      throw new CursorError("cursor does not belong to project");
    }
  }
  const rows = await db
    .select()
    .from(domainEvents)
    .where(and(eq(domainEvents.projectId, project.id), gt(domainEvents.cursor, after)))
    .orderBy(domainEvents.cursor)
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const events = page.map((row) =>
    toPublicEvent({
      cursor: serializeCursor(row.cursor),
      eventId: row.eventId,
      type: row.type,
      organizationId: row.organizationId,
      projectId: row.projectId,
      occurredAt: row.occurredAt,
      data: row.payload,
    }),
  );
  const last = page.at(-1);
  return {
    events,
    next_cursor: rows.length > input.limit && last ? serializeCursor(last.cursor) : null,
  };
}

export { desc };
