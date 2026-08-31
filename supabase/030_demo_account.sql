-- Dedicated "demo" login for showing off the system live (e.g. in a team
-- meeting). Granted owner-level visibility in the app via a special-case in
-- isOwner() (checks id, not role) so it stays out of "the owner" singular
-- assumptions elsewhere (ownerOptions(), guideline-review notifications).
insert into public.users (id, name, role, title, phone, email, username, pin, onboarded, origination_split, speaks_spanish)
values ('demo', 'Demo Account', 'loan_officer', 'Demo', null, null, 'demo', '1234', true, 0.5, false)
on conflict (id) do nothing;
