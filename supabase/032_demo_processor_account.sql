-- Second demo login, this time for showing the processing side (e.g. a
-- walkthrough for Erika). Uses the real "processor" role directly -- no
-- special-casing needed for permissions, unlike the sales "demo" account,
-- since isProcessor() already checks role. Excluded from allProcessors()
-- (index.html) so it never gets auto-assigned real files or shows up in
-- the real Processor reassignment dropdown.
insert into public.users (id, name, role, title, phone, email, username, pin, onboarded, origination_split, speaks_spanish)
values ('demo-processor', 'Demo Processor', 'processor', 'Demo', null, null, 'demoproc', '5678', true, 0.5, false)
on conflict (id) do nothing;
