alter table metal.sandboxes
  add column regions jsonb not null default '[]'::jsonb,
  add column features jsonb not null default '{}'::jsonb,
  add column network jsonb not null default '{}'::jsonb;
