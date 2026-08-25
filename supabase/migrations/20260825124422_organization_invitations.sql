create table public.organization_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role public.organization_role not null,
  invited_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default timezone('utc', now()),
  expires_at timestamptz not null default timezone('utc', now()) + interval '7 days',
  accepted_at timestamptz,
  revoked_at timestamptz,
  constraint organization_invitations_email_len check (char_length(email) between 3 and 320),
  constraint organization_invitations_email_lower check (email = lower(email)),
  constraint organization_invitations_role_invitee check (role in ('admin', 'member')),
  constraint organization_invitations_accepted_or_revoked check (
    accepted_at is null or revoked_at is null
  )
);

create unique index organization_invitations_pending_email_key
  on public.organization_invitations (organization_id, email)
  where accepted_at is null and revoked_at is null;

create index organization_invitations_organization_id_idx
  on public.organization_invitations (organization_id, created_at);

create index organization_invitations_email_idx
  on public.organization_invitations (email)
  where accepted_at is null and revoked_at is null;

alter table public.organization_invitations enable row level security;

revoke all on table public.organization_invitations from public, anon, authenticated;
grant select on table public.organization_invitations to authenticated;

create policy organization_invitations_select_member
on public.organization_invitations
for select
to authenticated
using (metal.is_organization_member(organization_id));

create policy organization_invitations_no_self_insert
on public.organization_invitations
for insert
to authenticated
with check (false);

create policy organization_invitations_no_self_update
on public.organization_invitations
for update
to authenticated
using (false)
with check (false);
