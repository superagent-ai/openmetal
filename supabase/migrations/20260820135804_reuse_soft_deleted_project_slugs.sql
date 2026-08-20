alter table public.projects
  drop constraint if exists projects_organization_id_slug_key;

create unique index if not exists projects_organization_id_slug_key
  on public.projects (organization_id, slug)
  where deleted_at is null;
