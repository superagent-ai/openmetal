import { OpaqueIdSchema, ProjectIdSchema } from "@openmetal/contracts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TopicKind = "organization" | "project";

export class TopicError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TopicError";
  }
}

function assertUuid(value: string, label: string): string {
  const parsed = OpaqueIdSchema.safeParse(value);
  if (!parsed.success || !UUID_RE.test(value)) {
    throw new TopicError(`invalid ${label}`);
  }
  return parsed.data;
}

export function organizationTopic(organizationId: string): string {
  return `organization:${assertUuid(organizationId, "organization_id")}`;
}

export function projectTopic(projectId: string): string {
  const parsed = ProjectIdSchema.safeParse(projectId);
  if (!parsed.success) throw new TopicError("invalid project_id");
  return `project:${parsed.data}`;
}

export function parseTopic(topic: string): { kind: TopicKind; id: string } {
  const match = /^(organization|project):([A-Za-z0-9_-]+)$/i.exec(topic);
  if (!match) {
    throw new TopicError("invalid topic");
  }
  const kind = match[1] as TopicKind;
  const rawId = match[2] ?? "";
  let id: string;
  if (kind === "project") {
    const parsed = ProjectIdSchema.safeParse(rawId);
    if (!parsed.success) throw new TopicError("invalid project_id");
    id = parsed.data;
  } else {
    id = assertUuid(rawId, `${kind}_id`);
  }
  return { kind, id };
}
