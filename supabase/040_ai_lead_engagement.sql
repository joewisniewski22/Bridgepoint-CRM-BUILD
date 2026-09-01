-- Tracks the AI conversion-texting automation's stage per lead:
-- null = never enrolled (e.g. self-generated leads are excluded on purpose)
-- 'awaiting_language' = bilingual LO's lead, waiting on their EN/ES choice
-- 'engaging' = actively conversing toward conversion
-- Respects the existing automation_paused flag as its stop switch.
alter table public.leads add column if not exists ai_stage text;
