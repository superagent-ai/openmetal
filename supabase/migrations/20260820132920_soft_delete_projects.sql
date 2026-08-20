alter table public.projects
  add column deleted_at timestamptz;

create index projects_active_organization_id_idx
  on public.projects (organization_id)
  where deleted_at is null;
