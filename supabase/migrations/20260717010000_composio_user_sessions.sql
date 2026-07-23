begin;

create table if not exists public.composio_user_sessions (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  session_id text not null check (char_length(session_id) between 1 and 512),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists composio_user_sessions_set_updated_at
  on public.composio_user_sessions;
create trigger composio_user_sessions_set_updated_at
before update on public.composio_user_sessions
for each row execute function public.set_oyster_updated_at();

alter table public.composio_user_sessions enable row level security;

revoke all on table public.composio_user_sessions from anon;
grant select, insert, update, delete
  on table public.composio_user_sessions to authenticated;

drop policy if exists composio_user_sessions_owner_select
  on public.composio_user_sessions;
create policy composio_user_sessions_owner_select
on public.composio_user_sessions
for select to authenticated
using ((select auth.uid()) = owner_id);

drop policy if exists composio_user_sessions_owner_insert
  on public.composio_user_sessions;
create policy composio_user_sessions_owner_insert
on public.composio_user_sessions
for insert to authenticated
with check ((select auth.uid()) = owner_id);

drop policy if exists composio_user_sessions_owner_update
  on public.composio_user_sessions;
create policy composio_user_sessions_owner_update
on public.composio_user_sessions
for update to authenticated
using ((select auth.uid()) = owner_id)
with check ((select auth.uid()) = owner_id);

drop policy if exists composio_user_sessions_owner_delete
  on public.composio_user_sessions;
create policy composio_user_sessions_owner_delete
on public.composio_user_sessions
for delete to authenticated
using ((select auth.uid()) = owner_id);

commit;
