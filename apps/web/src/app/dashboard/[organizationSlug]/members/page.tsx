import type { Metadata } from "next";
import { MembersView } from "@/components/members-view";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";
import { dashboardPageMetadata } from "@/lib/page-metadata";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}): Promise<Metadata> {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  return dashboardPageMetadata({
    title: "Members",
    description: `Invite and manage members of ${organization.name}.`,
    path: `/dashboard/${organization.slug}/members`,
  });
}

export default async function OrganizationMembersPage({
  params,
}: {
  params: Promise<{ organizationSlug: string }>;
}) {
  const { organizationSlug } = await params;
  const organization = await requireOrganizationBySlug(organizationSlug);
  const { metal } = await requireMetalSession();
  const result = await metal.members.list(organization.id);

  return (
    <MembersView
      organizationId={organization.id}
      organizationName={organization.name}
      viewerUserId={result.viewer.user_id}
      viewerRole={result.viewer.role}
      initialMembers={result.members}
      initialInvitations={result.invitations}
    />
  );
}
