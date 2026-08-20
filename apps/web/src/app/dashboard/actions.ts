"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MetalError } from "@openmetal/sdk";
import { z } from "zod";
import {
  ACTIVE_ORGANIZATION_COOKIE,
  organizationDashboardPath,
  type DashboardSection,
} from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";

const CreateOrganizationSchema = z.object({
  name: z.string().trim().min(1, "Enter an organization name").max(120),
});

export type CreateOrganizationState = {
  error?: string;
};

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 63);
}

async function rememberOrganization(organizationId: string) {
  (await cookies()).set(ACTIVE_ORGANIZATION_COOKIE, organizationId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
}

export async function selectOrganization(organizationId: string, section?: DashboardSection) {
  const { metal } = await requireMetalSession();
  const organization = await metal.organizations.get(organizationId);
  await rememberOrganization(organization.id);
  redirect(organizationDashboardPath(organization, section));
}

export async function createOrganization(
  _previousState: CreateOrganizationState,
  formData: FormData,
): Promise<CreateOrganizationState> {
  const parsed = CreateOrganizationSchema.safeParse({
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter a valid organization name" };
  }

  const slug = slugify(parsed.data.name);
  if (!slug) {
    return { error: "Use at least one letter or number in the organization name" };
  }

  const { metal } = await requireMetalSession();
  let organization;
  try {
    organization = await metal.organizations.create(
      { name: parsed.data.name, slug },
      { idempotencyKey: crypto.randomUUID() },
    );
  } catch (error) {
    return {
      error: error instanceof MetalError ? error.message : "Could not create the organization",
    };
  }

  await rememberOrganization(organization.id);
  redirect(organizationDashboardPath(organization));
}
