create or replace function public.sync_guarantor_address() returns trigger language plpgsql as $f$
begin
  if nullif(trim(coalesce(new.guarantor_address,'')),'') is null then
    new.guarantor_address := coalesce(nullif(trim(new.dscr_app->>'homeAddress'),''), nullif(trim(new.rtl_app->>'homeAddress'),''), new.guarantor_address);
  end if;
  return new;
end
$f$;
drop trigger if exists leads_sync_guarantor_address on public.leads;
create trigger leads_sync_guarantor_address before insert or update on public.leads for each row execute function public.sync_guarantor_address();
update public.leads set guarantor_address = guarantor_address where nullif(trim(coalesce(guarantor_address,'')),'') is null and coalesce(nullif(trim(dscr_app->>'homeAddress'),''), nullif(trim(rtl_app->>'homeAddress'),'')) is not null;
select count(*) filter (where nullif(trim(coalesce(guarantor_address,'')),'') is not null) with_address, count(*) filter (where nullif(trim(coalesce(guarantor_address,'')),'') is null) without_address from public.leads;
