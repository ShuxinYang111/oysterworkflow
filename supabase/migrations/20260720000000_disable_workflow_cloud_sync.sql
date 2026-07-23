begin;

-- Workflow definitions and worker-to-workflow assignments are local-only.
-- Dropping the tables permanently removes historical cloud workflow content
-- and prevents current or older clients from writing new copies.
drop table if exists public.worker_workflows;
drop table if exists public.workflows;

-- Older clients embedded workflow ids in worker manifests. Remove that field
-- from existing rows and strip it from any future worker write.
update public.ai_workers
set manifest = manifest - 'workflowIds'
where manifest ? 'workflowIds';

create or replace function public.strip_worker_workflow_ids()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.manifest = new.manifest - 'workflowIds';
  return new;
end;
$$;

drop trigger if exists strip_worker_workflow_ids on public.ai_workers;
create trigger strip_worker_workflow_ids
before insert or update of manifest on public.ai_workers
for each row execute function public.strip_worker_workflow_ids();

commit;
