create table if not exists public.pilot_leads (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  name text not null,
  work_email text not null,
  company text not null,
  workflow text not null,
  source_path text not null default '/pilot',
  user_agent text
);

create index if not exists pilot_leads_created_at_idx
  on public.pilot_leads (created_at desc);

create index if not exists pilot_leads_work_email_idx
  on public.pilot_leads (lower(work_email));

grant select, insert on table public.pilot_leads to service_role;

alter table public.pilot_leads enable row level security;

drop policy if exists "No public access to pilot leads" on public.pilot_leads;
create policy "No public access to pilot leads"
  on public.pilot_leads
  for all
  using (false)
  with check (false);;
