"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { MetalError } from "@openmetal/sdk";
import { z } from "zod";
import {
  ACTIVE_ORGANIZATION_COOKIE,
  organizationDashboardPath,
} from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";

const OrganizationNameSchema = z
  .string()
  .trim()
  .min(1, "Enter an organization name")
  .max(120, "Use 120 characters or fewer");
const OrganizationSlugSchema = z
  .string()
  .trim()
  .min(1, "Enter an organization slug")
  .max(63, "Use 63 characters or fewer")
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, numbers, and single hyphens");

const UpdateOrganizationSchema = z.object({
  organizationId: z.uuid(),
  name: OrganizationNameSchema,
  slug: OrganizationSlugSchema,
});

export type UpdateOrganizationSettingsState = {
  status?: "success" | "error";
  message?: string;
  fieldErrors?: {
    name?: string;
    slug?: string;
  };
};

export async function updateOrganizationSettings(
  organizationId: string,
  currentSlug: string,
  _previousState: UpdateOrganizationSettingsState,
  formData: FormData,
): Promise<UpdateOrganizationSettingsState> {
  const parsed = UpdateOrganizationSchema.safeParse({
    organizationId,
    name: formData.get("name"),
    slug: formData.get("slug"),
  });
  if (!parsed.success) {
    const flattened = z.flattenError(parsed.error);
    return {
      status: "error",
      fieldErrors: {
        name: flattened.fieldErrors.name?.[0],
        slug: flattened.fieldErrors.slug?.[0],
      },
    };
  }

  const { metal } = await requireMetalSession();
  let organization;
  try {
    organization = await metal.organizations.update(parsed.data.organizationId, {
      name: parsed.data.name,
      slug: parsed.data.slug,
    });
  } catch (error) {
    return {
      status: "error",
      message: error instanceof MetalError ? error.message : "Could not update the organization",
    };
  }

  revalidatePath("/dashboard", "layout");
  if (organization.slug !== currentSlug) {
    redirect(organizationDashboardPath(organization, "settings"));
  }
  return {
    status: "success",
    message: "Organization updated.",
  };
}

const DeleteOrganizationSchema = z.object({
  organizationId: z.uuid(),
  confirmName: OrganizationNameSchema,
  confirmForfeitBalance: z.boolean(),
});

export type DeleteOrganizationResult = {
  error?: string;
};

export async function deleteOrganization(
  input: z.input<typeof DeleteOrganizationSchema>,
): Promise<DeleteOrganizationResult> {
  const parsed = DeleteOrganizationSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "Enter the organization name to confirm deletion" };
  }

  const { metal } = await requireMetalSession();
  try {
    await metal.organizations.delete(parsed.data.organizationId, {
      confirm_name: parsed.data.confirmName,
      confirm_forfeit_balance: parsed.data.confirmForfeitBalance,
    });
  } catch (error) {
    return {
      error: error instanceof MetalError ? error.message : "Could not delete the organization",
    };
  }

  const cookieStore = await cookies();
  if (cookieStore.get(ACTIVE_ORGANIZATION_COOKIE)?.value === parsed.data.organizationId) {
    cookieStore.delete(ACTIVE_ORGANIZATION_COOKIE);
  }
  const remaining = await metal.organizations.list();
  revalidatePath("/dashboard", "layout");
  const nextOrganization = remaining.organizations[0];
  redirect(nextOrganization ? organizationDashboardPath(nextOrganization) : "/dashboard/new");
}
