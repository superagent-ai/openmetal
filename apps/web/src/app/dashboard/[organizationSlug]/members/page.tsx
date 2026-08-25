import { MembersView } from "@/components/members-view";
import { requireOrganizationBySlug } from "@/lib/dashboard-organizations";
import { requireMetalSession } from "@/lib/metal-server";

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
