revoke insert, update, delete on table public.projects from authenticated;

drop policy if exists projects_select_member on public.projects;

create policy projects_select_member
on public.projects
for select
to authenticated
using (
  deleted_at is null
  and metal.is_organization_member(organization_id)
);
