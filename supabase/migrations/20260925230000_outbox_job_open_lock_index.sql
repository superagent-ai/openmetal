-- The claim query now checks every older claimable job with the same lock key,
-- not only older exclusive ones, so one index over all open jobs that carry a
-- lock replaces the separate held and pending indexes.

drop index metal.outbox_jobs_pending_lock_idx;
drop index metal.outbox_jobs_held_lock_idx;

create index outbox_jobs_open_lock_idx
  on metal.outbox_jobs (lock_key, created_at, id)
  where status in ('pending', 'leased') and lock_key is not null;
