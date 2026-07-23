grant insert on table public.pilot_leads to anon;

drop policy if exists "No public access to pilot leads" on public.pilot_leads;
drop policy if exists "Allow public pilot lead submissions" on public.pilot_leads;

create policy "Allow public pilot lead submissions"
  on public.pilot_leads
  for insert
  to anon
  with check (
    char_length(name) between 1 and 160
    and char_length(work_email) between 5 and 254
    and position('@' in work_email) > 1
    and char_length(company) between 1 and 180
    and char_length(workflow) between 1 and 2000
    and char_length(source_path) between 1 and 240
  );
;
