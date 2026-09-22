-- The public lifecycle contract allows runtime_timeout_seconds through 172800.
-- Create stores that as ceil(seconds / 60), so the row cap must be 2880 minutes.
-- The previous 1440-minute check rejected a valid 48 hour timeout as a 500.

alter table metal.sandboxes
  drop constraint sandboxes_ttl_range,
  add constraint sandboxes_ttl_range
    check (ttl_minutes between 1 and 2880);
