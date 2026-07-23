begin;

create table if not exists public.devices (
  owner_id uuid not null references auth.users(id) on delete cascade,
  device_id text not null,
  name text not null,
  platform text not null,
  runtime_version text not null,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  last_seen_at timestamptz not null default now(),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, device_id)
);

create table if not exists public.ai_workers (
  owner_id uuid not null references auth.users(id) on delete cascade,
  worker_id text not null,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, worker_id)
);

create table if not exists public.workflows (
  owner_id uuid not null references auth.users(id) on delete cascade,
  workflow_id text not null,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  primary key (owner_id, workflow_id)
);

create table if not exists public.worker_workflows (
  owner_id uuid not null references auth.users(id) on delete cascade,
  assignment_id text not null,
  worker_id text not null,
  workflow_id text not null,
  manifest jsonb not null check (jsonb_typeof(manifest) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (owner_id, assignment_id),
  foreign key (owner_id, worker_id)
    references public.ai_workers(owner_id, worker_id) on delete cascade,
  foreign key (owner_id, workflow_id)
    references public.workflows(owner_id, workflow_id) on delete cascade
);

create or replace function public.set_oyster_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists devices_set_updated_at on public.devices;
create trigger devices_set_updated_at
before update on public.devices
for each row execute function public.set_oyster_updated_at();

drop trigger if exists ai_workers_set_updated_at on public.ai_workers;
create trigger ai_workers_set_updated_at
before update on public.ai_workers
for each row execute function public.set_oyster_updated_at();

drop trigger if exists workflows_set_updated_at on public.workflows;
create trigger workflows_set_updated_at
before update on public.workflows
for each row execute function public.set_oyster_updated_at();

drop trigger if exists worker_workflows_set_updated_at on public.worker_workflows;
create trigger worker_workflows_set_updated_at
before update on public.worker_workflows
for each row execute function public.set_oyster_updated_at();

alter table public.devices enable row level security;
alter table public.ai_workers enable row level security;
alter table public.workflows enable row level security;
alter table public.worker_workflows enable row level security;

revoke all on table public.devices from anon;
revoke all on table public.ai_workers from anon;
revoke all on table public.workflows from anon;
revoke all on table public.worker_workflows from anon;

grant select, insert, update, delete on table public.devices to authenticated;
grant select, insert, update, delete on table public.ai_workers to authenticated;
grant select, insert, update, delete on table public.workflows to authenticated;
grant select, insert, update, delete on table public.worker_workflows to authenticated;

drop policy if exists devices_owner_select on public.devices;
create policy devices_owner_select on public.devices
for select to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists devices_owner_insert on public.devices;
create policy devices_owner_insert on public.devices
for insert to authenticated
with check ((select auth.uid()) = owner_id);

drop policy if exists devices_owner_update on public.devices;
create policy devices_owner_update on public.devices
for update to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists devices_owner_delete on public.devices;
create policy devices_owner_delete on public.devices
for delete to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists ai_workers_owner_select on public.ai_workers;
create policy ai_workers_owner_select on public.ai_workers
for select to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists ai_workers_owner_insert on public.ai_workers;
create policy ai_workers_owner_insert on public.ai_workers
for insert to authenticated
with check ((select auth.uid()) = owner_id);

drop policy if exists ai_workers_owner_update on public.ai_workers;
create policy ai_workers_owner_update on public.ai_workers
for update to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists ai_workers_owner_delete on public.ai_workers;
create policy ai_workers_owner_delete on public.ai_workers
for delete to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists workflows_owner_select on public.workflows;
create policy workflows_owner_select on public.workflows
for select to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists workflows_owner_insert on public.workflows;
create policy workflows_owner_insert on public.workflows
for insert to authenticated
with check ((select auth.uid()) = owner_id);

drop policy if exists workflows_owner_update on public.workflows;
create policy workflows_owner_update on public.workflows
for update to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists workflows_owner_delete on public.workflows;
create policy workflows_owner_delete on public.workflows
for delete to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists worker_workflows_owner_select on public.worker_workflows;
create policy worker_workflows_owner_select on public.worker_workflows
for select to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists worker_workflows_owner_insert on public.worker_workflows;
create policy worker_workflows_owner_insert on public.worker_workflows
for insert to authenticated
with check ((select auth.uid()) = owner_id);

drop policy if exists worker_workflows_owner_update on public.worker_workflows;
create policy worker_workflows_owner_update on public.worker_workflows
for update to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists worker_workflows_owner_delete on public.worker_workflows;
create policy worker_workflows_owner_delete on public.worker_workflows
for delete to authenticated
using ((select auth.uid()) = owner_id);

create index if not exists devices_owner_last_seen_idx
  on public.devices(owner_id, last_seen_at desc);
create index if not exists ai_workers_owner_updated_idx
  on public.ai_workers(owner_id, updated_at desc)
  where deleted_at is null;
create index if not exists workflows_owner_updated_idx
  on public.workflows(owner_id, updated_at desc)
  where deleted_at is null;
create index if not exists worker_workflows_owner_worker_idx
  on public.worker_workflows(owner_id, worker_id);

commit;
