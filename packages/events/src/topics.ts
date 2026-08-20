import { OpaqueIdSchema } from "@openmetal/contracts";

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
  return `project:${assertUuid(projectId, "project_id")}`;
}

export function parseTopic(topic: string): { kind: TopicKind; id: string } {
  const match = /^(organization|project):([0-9a-f-]{36})$/i.exec(topic);
  if (!match) {
    throw new TopicError("invalid topic");
  }
  const kind = match[1] as TopicKind;
  const id = assertUuid(match[2] ?? "", `${kind}_id`);
  return { kind, id };
}
