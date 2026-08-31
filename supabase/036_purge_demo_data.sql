-- One-time cleanup: Bridgepoint is going live with its first real deal.
-- Removes all seed/demo leads (every one was @example.com or one of Joe's
-- own test entries -- confirmed via audit, none were real clients) and the
-- 5 fake demo loan officers (Maria Delgado, Devon Marsh, Priya Anand,
-- Blake Ferro, Nina Osei) that were kept temporarily as a team-demo
-- dataset. Real staff (Joe, Fiore, Fanis, David, Erika) and the
-- demo/demo-processor presentation accounts are untouched.
-- emails.lead_id and emails.sent_by both have FK constraints back to
-- leads/users, so that table has to clear first.
delete from public.emails;
delete from public.notifications;
delete from public.leads;
delete from public.users where id in ('lo-maria','lo-devon','lo-priya','lo-blake','lo-nina');
