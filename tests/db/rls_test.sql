-- Behaviour tests for supabase/schema.sql: RLS isolation, limits, audit log, storage folders, account deletion.
-- Run by tests/db/run.sh. Every block raises on failure; psql stops at the first error (ON_ERROR_STOP).
\set ON_ERROR_STOP on
\set QUIET on
\o /dev/null
\set A '''aaaaaaaa-0000-0000-0000-000000000001'''
\set B '''bbbbbbbb-0000-0000-0000-000000000002'''

-- A helper for "this must fail with an error containing X", run as whichever role is current.
reset role;
create or replace function public.t_expect_error(stmt text, pattern text) returns void language plpgsql as $$
declare failed boolean := false; msg text;
begin
  begin
    execute stmt;
  exception when others then
    failed := true; msg := sqlerrm;
  end;
  if not failed then
    raise exception 'expected an error matching "%" from: %', pattern, stmt;
  elsif msg not ilike '%' || pattern || '%' then
    raise exception 'wrong error for %: % (wanted %)', stmt, msg, pattern;
  end if;
end $$;
grant execute on function public.t_expect_error(text, text) to anon, authenticated;

-- ---------- signup trigger ----------
insert into auth.users (id, email, raw_user_meta_data) values
  (:A, 'a@example.test', '{"full_name":"Asha Analyst"}'),
  (:B, 'b@example.test', '{}');
do $$ begin
  assert (select display_name from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 'Asha Analyst', 'profile A not created from metadata';
  assert (select count(*) from public.profiles) = 2, 'profiles not auto-created';
end $$;
\echo '  ok  profiles are created on signup'

-- ---------- act as user A ----------
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', false) \g /dev/null

insert into public.scorings (inputs, probability, lane, threshold, model_version, note)
values ('{"age":27}', 0.97, 'decline', 0.90, 'muc02-logreg-1', 'first');
insert into public.policies (threshold, route_ntc) values (0.85, true);
insert into public.policies (threshold, route_ntc) values (0.88, false)
  on conflict (user_id) do update set threshold = excluded.threshold, route_ntc = excluded.route_ntc;
do $$ begin
  assert (select count(*) from public.scorings) = 1, 'A cannot see own scoring';
  assert (select threshold from public.policies) = 0.88, 'policy upsert failed';
  assert (select count(*) from public.audit_log where action = 'scoring.save') = 1, 'no audit row for scoring save';
  assert (select count(*) from public.audit_log where action = 'policy.save') = 2, 'no audit rows for policy save/update';
  assert (select detail->'previous'->>'threshold' from public.audit_log where action = 'policy.save' order by id desc limit 1) = '0.85',
    'policy change does not record the previous value';
end $$;
select public.t_expect_error($$insert into public.policies (threshold) values (0.40) on conflict (user_id) do update set threshold = 0.40$$, 'check');
select public.t_expect_error($$update public.policies set threshold = 1.2$$, 'check');
\echo '  ok  own rows readable, policy saved + range-checked, audit written on save and policy change'

-- audit_log is append-only
select public.t_expect_error($$update public.audit_log set action = 'x'$$, 'permission denied');
select public.t_expect_error($$delete from public.audit_log$$, 'permission denied');
insert into public.audit_log (action, detail) values ('client.note', '{}');
select public.t_expect_error($$insert into public.audit_log (user_id, action) values ('bbbbbbbb-0000-0000-0000-000000000002', 'forged')$$, 'row-level security');
\echo '  ok  audit_log is insert + select only, and only for yourself'

-- cannot write rows for someone else
select public.t_expect_error($$insert into public.scorings (user_id, inputs, probability, lane, model_version) values ('bbbbbbbb-0000-0000-0000-000000000002', '{}', 0.5, 'review', 'v')$$, 'row-level security');
select public.t_expect_error($$insert into public.batches (file_path, row_count, lane_counts, threshold, model_version) values ('bbbbbbbb-0000-0000-0000-000000000002/x.csv', 1, '{}', 0.9, 'v')$$, 'batches_file_in_own_folder');
\echo '  ok  cannot write rows or file paths for another user'

-- scoring limit: 50
insert into public.scorings (inputs, probability, lane, model_version) select '{}', 0.5, 'review', 'v' from generate_series(1, 49);
select public.t_expect_error($$insert into public.scorings (inputs, probability, lane, model_version) values ('{}', 0.5, 'review', 'v')$$, 'SCORING_LIMIT_REACHED');
delete from public.scorings where note is null and id = (select id from public.scorings where note is null limit 1);
insert into public.scorings (inputs, probability, lane, model_version) values ('{}', 0.5, 'review', 'v');
do $$ begin
  assert (select count(*) from public.scorings) = 50, 'scoring count wrong after delete + re-save';
  assert (select count(*) from public.audit_log where action = 'scoring.delete') = 1, 'no audit row for delete';
end $$;
\echo '  ok  50-scoring limit holds; deleting one frees a slot; deletes are audited'

-- storage: own folder only, max 5 files
insert into storage.objects (bucket_id, name, owner) select 'intake', 'aaaaaaaa-0000-0000-0000-000000000001/f' || g || '.csv', auth.uid() from generate_series(1, 5) g;
select public.t_expect_error($$insert into storage.objects (bucket_id, name) values ('intake', 'aaaaaaaa-0000-0000-0000-000000000001/f6.csv')$$, 'row-level security');
select public.t_expect_error($$insert into storage.objects (bucket_id, name) values ('intake', 'bbbbbbbb-0000-0000-0000-000000000002/x.csv')$$, 'row-level security');
select public.t_expect_error($$insert into storage.objects (bucket_id, name) values ('intake', 'loose.csv')$$, 'row-level security');
\echo '  ok  storage: uploads only into your own folder, at most 5 files'

-- batch limit: 5
insert into public.batches (file_path, file_name, row_count, lane_counts, wrong_decline_rate, gender_rates, threshold, route_ntc, model_version)
select 'aaaaaaaa-0000-0000-0000-000000000001/f' || g || '.csv', 'f.csv', 240, '{"decline":46,"review":180,"human":14}', 0.0217, '{"female":0.149,"male":0.211}', 0.90, true, 'v'
from generate_series(1, 5) g;
select public.t_expect_error($$insert into public.batches (file_path, row_count, lane_counts, threshold, model_version) values ('aaaaaaaa-0000-0000-0000-000000000001/f9.csv', 1, '{}', 0.9, 'v')$$, 'BATCH_LIMIT_REACHED');
\echo '  ok  5-batch limit holds'

-- ---------- act as user B: sees nothing of A's ----------
select set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-0000-0000-000000000002","role":"authenticated"}', false) \g /dev/null
do $$
declare n int;
begin
  assert (select count(*) from public.scorings) = 0, 'B can read A''s scorings';
  assert (select count(*) from public.batches) = 0, 'B can read A''s batches';
  assert (select count(*) from public.policies) = 0, 'B can read A''s policy';
  assert (select count(*) from public.audit_log) = 0, 'B can read A''s audit log';
  assert (select count(*) from public.profiles) = 1, 'B can read other profiles';
  assert (select count(*) from storage.objects) = 0, 'B can list A''s files';
  update public.scorings set note = 'hijacked'; get diagnostics n = row_count; assert n = 0, 'B updated A''s scorings';
  delete from public.batches; get diagnostics n = row_count; assert n = 0, 'B deleted A''s batches';
  delete from storage.objects; get diagnostics n = row_count; assert n = 0, 'B deleted A''s files';
end $$;
\echo '  ok  user B cannot read, change or delete any of user A''s rows or files'

-- ---------- signed-out (anon) ----------
reset role;
set role anon;
select set_config('request.jwt.claims', '{"role":"anon"}', false) \g /dev/null
select public.t_expect_error($$select * from public.scorings$$, 'permission denied');
select public.t_expect_error($$select public.delete_account()$$, 'permission denied');
do $$ begin assert (select count(*) from storage.objects) = 0, 'anon can list files'; end $$;
\echo '  ok  signed-out visitors get nothing'

-- ---------- delete account (A) ----------
reset role;
set role authenticated;
select set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-0000-0000-000000000001","role":"authenticated"}', false) \g /dev/null
delete from storage.objects;   -- the client does this through the Storage API first
select public.delete_account();
reset role;
do $$ begin
  assert (select count(*) from auth.users where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0, 'user not deleted';
  assert (select count(*) from public.scorings) + (select count(*) from public.batches) + (select count(*) from public.policies)
       + (select count(*) from public.audit_log) + (select count(*) from public.profiles where id = 'aaaaaaaa-0000-0000-0000-000000000001') = 0,
    'rows left behind after account deletion';
  assert (select count(*) from auth.users) = 1, 'other users affected';
end $$;
\echo '  ok  delete_account removes the user and every row they owned, nobody else''s'
