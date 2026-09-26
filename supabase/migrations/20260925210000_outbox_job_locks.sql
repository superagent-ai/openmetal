-- Workers run jobs concurrently across replicas. Lifecycle jobs (provision,
-- pause, resume, destroy) must not overlap other work on the same sandbox, and
-- billing jobs must not overlap on the same organization. The claim query uses
-- these columns to skip jobs that conflict with a job another worker holds.

alter table metal.outbox_jobs
  add column lock_key text,
  add column lock_mode text,
  add constraint outbox_jobs_lock_mode_check
    check (lock_mode in ('shared', 'exclusive')),
  add constraint outbox_jobs_lock_pair_check
    check ((lock_key is null) = (lock_mode is null));

create index outbox_jobs_held_lock_idx
  on metal.outbox_jobs (lock_key)
  where status = 'leased' and lock_key is not null;

create index outbox_jobs_pending_lock_idx
  on metal.outbox_jobs (lock_key, created_at)
  where status = 'pending' and lock_mode = 'exclusive';

create or replace function metal.set_outbox_job_lock()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  target_sandbox_id uuid;
begin
  new.lock_key := null;
  new.lock_mode := null;
  case new.job_type
    when 'sandbox.provision', 'sandbox.reconcile', 'sandbox.pause', 'sandbox.resume',
      'sandbox.destroy' then
      new.lock_key := 'sandbox:' || (new.payload ->> 'sandbox_id');
      new.lock_mode := 'exclusive';
    when 'sandbox.cost.sync' then
      new.lock_key := 'sandbox:' || (new.payload ->> 'sandbox_id');
      new.lock_mode := 'shared';
    when 'billing.auto_topup.evaluate', 'billing.spend_limit.enforce' then
      new.lock_key := 'organization:' || (new.payload ->> 'organization_id');
      new.lock_mode := 'exclusive';
    when 'process.execute' then
      select sandbox_id into target_sandbox_id
      from metal.sandbox_processes
      where id = (new.payload ->> 'process_id')::uuid;
    when 'filesystem.read', 'filesystem.write', 'filesystem.list', 'filesystem.delete',
      'computer.action', 'computer.screenshot' then
      select sandbox_id into target_sandbox_id
      from metal.runtime_operations
      where id = (new.payload ->> 'runtime_operation_id')::uuid;
    when 'recording.start', 'recording.stop' then
      select sandbox_id into target_sandbox_id
      from metal.sandbox_recordings
      where id = (new.payload ->> 'recording_id')::uuid;
    when 'endpoint.create', 'endpoint.revoke' then
      select sandbox_id into target_sandbox_id
      from metal.sandbox_endpoints
      where id = (new.payload ->> 'endpoint_id')::uuid;
    else
      null;
  end case;
  if target_sandbox_id is not null then
    new.lock_key := 'sandbox:' || target_sandbox_id::text;
    new.lock_mode := 'shared';
  end if;
  if new.lock_key is null then
    new.lock_mode := null;
  end if;
  return new;
end;
$$;

create trigger outbox_jobs_set_lock
before insert or update of job_type, payload on metal.outbox_jobs
for each row execute function metal.set_outbox_job_lock();

update metal.outbox_jobs
set payload = payload
where status in ('pending', 'leased');
