-- 106: close the public (anon-key) read/write access to client and company data (10/12/2026).
-- Before this, anyone holding the public key could read and edit every lead, email, note, payroll row, etc.
-- The borrower application and booking pages now go through portal-api / booking-api (token-checked),
-- the website forms and background jobs use edge functions (service role), and signed-in staff keep their
-- own policies. Kept public on purpose: approved funded deals, approved reviews, published site content.

do $do$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public' and (roles::text like '%anon%' or roles::text like '%public%')
      and tablename not in ('funded_deals', 'site_reviews')
  loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end
$do$;

-- tables that only had anon/public policies: signed-in staff keep full access, as they effectively had before
create policy "authenticated full access" on public.company_settings for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.third_party_contacts for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.engagement_config for all to authenticated using (true) with check (true);
create policy "authenticated full access" on public.growth_goals for all to authenticated using (true) with check (true);

-- the public showcase page only ever needs published content
create policy "anon read published" on public.site_content for select to anon using (status = 'published');

-- belt and braces: the anon role gets no table privileges except the three intentionally public tables
revoke all on all tables in schema public from anon;
grant select on public.site_content, public.funded_deals, public.site_reviews to anon;
