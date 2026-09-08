select id, name, source, assigned_to, created_at, created_at_ts from public.leads order by created_at_ts desc nulls last, created_at desc limit 8;
