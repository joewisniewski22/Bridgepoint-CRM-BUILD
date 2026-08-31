-- One-time cleanup: remove leftover test/debug accounts that were never
-- real team members and have zero leads attached. The 5 fake demo LOs
-- (Maria/Devon/Priya/Blake/Nina) and their leads are intentionally left in
-- place for now -- they're serving as the walkthrough dataset for a team
-- demo, to be purged separately afterward.
delete from public.users where id in (
  'lo-carlos', 'lo-sofia', 'lo-testperson', 'lo-josephwisniewski', 'lo-joetest'
);
