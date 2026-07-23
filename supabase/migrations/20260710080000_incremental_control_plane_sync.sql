begin;

create table if not exists public.workspace_sync_state (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 0 check (revision >= 0),
  updated_at timestamptz not null default now()
);

alter table public.ai_workers
  add column if not exists sync_revision bigint not null default 0;
alter table public.workflows
  add column if not exists sync_revision bigint not null default 0;
alter table public.worker_workflows
  add column if not exists sync_revision bigint not null default 0;
alter table public.worker_workflows
  add column if not exists deleted_at timestamptz;

insert into public.workspace_sync_state (owner_id, revision, updated_at)
select owner_id, 1, now()
from (
  select owner_id from public.ai_workers
  union
  select owner_id from public.workflows
  union
  select owner_id from public.worker_workflows
) owners
on conflict (owner_id) do nothing;

update public.ai_workers
set sync_revision = 1
where sync_revision = 0;

update public.workflows
set sync_revision = 1
where sync_revision = 0;

update public.worker_workflows
set sync_revision = 1
where sync_revision = 0;

create or replace function public.assign_oyster_sync_revision()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_revision bigint;
begin
  insert into public.workspace_sync_state (owner_id, revision, updated_at)
  values (new.owner_id, 1, now())
  on conflict (owner_id) do update
    set revision = public.workspace_sync_state.revision + 1,
        updated_at = now()
  returning revision into next_revision;

  new.sync_revision = next_revision;
  return new;
end;
$$;

drop trigger if exists ai_workers_assign_sync_revision on public.ai_workers;
create trigger ai_workers_assign_sync_revision
before insert or update on public.ai_workers
for each row execute function public.assign_oyster_sync_revision();

drop trigger if exists workflows_assign_sync_revision on public.workflows;
create trigger workflows_assign_sync_revision
before insert or update on public.workflows
for each row execute function public.assign_oyster_sync_revision();

drop trigger if exists worker_workflows_assign_sync_revision on public.worker_workflows;
create trigger worker_workflows_assign_sync_revision
before insert or update on public.worker_workflows
for each row execute function public.assign_oyster_sync_revision();

alter table public.workspace_sync_state enable row level security;

revoke all on table public.workspace_sync_state from anon;
revoke insert, update, delete on table public.workspace_sync_state from authenticated;
grant select on table public.workspace_sync_state to authenticated;

drop policy if exists workspace_sync_state_owner_select
  on public.workspace_sync_state;
create policy workspace_sync_state_owner_select
on public.workspace_sync_state
for select to authenticated
using ((select auth.uid()) = owner_id);

create index if not exists ai_workers_owner_revision_idx
  on public.ai_workers(owner_id, sync_revision);
create index if not exists workflows_owner_revision_idx
  on public.workflows(owner_id, sync_revision);
create index if not exists worker_workflows_owner_revision_idx
  on public.worker_workflows(owner_id, sync_revision);
create index if not exists worker_workflows_owner_active_idx
  on public.worker_workflows(owner_id, worker_id)
  where deleted_at is null;

commit;
