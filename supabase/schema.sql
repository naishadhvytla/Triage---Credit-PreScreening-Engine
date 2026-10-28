-- ============================================================
--  Triage — Supabase backend schema
--  Run in your Supabase project: Dashboard → SQL Editor → New query → paste all → Run.
--  Idempotent: safe to run again after edits; it never drops your data.
-- ============================================================

-- ---------- PROFILES (one row per user, created on signup) ----------
create table if not exists public.profiles (
  id            uuid primary key references auth.users on delete cascade,
  display_name  text check (char_length(display_name) <= 120),
  created_at    timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles read own"   on public.profiles;
drop policy if exists "profiles insert own" on public.profiles;
drop policy if exists "profiles update own" on public.profiles;
create policy "profiles read own"   on public.profiles for select to authenticated using (auth.uid() = id);
create policy "profiles insert own" on public.profiles for insert to authenticated with check (auth.uid() = id);
create policy "profiles update own" on public.profiles for update to authenticated using (auth.uid() = id) with check (auth.uid() = id);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, left(coalesce(new.raw_user_meta_data->>'display_name',
                                new.raw_user_meta_data->>'full_name',
                                new.raw_user_meta_data->>'name', ''), 120))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- POLICIES (one per user: the auto-decline threshold + new-to-credit routing) ----------
create table if not exists public.policies (
  user_id     uuid primary key default auth.uid() references auth.users on delete cascade,
  threshold   numeric(3,2) not null default 0.90 check (threshold between 0.50 and 0.99),
  route_ntc   boolean not null default true,
  updated_at  timestamptz not null default now()
);

alter table public.policies enable row level security;

drop policy if exists "policies are private" on public.policies;
create policy "policies are private" on public.policies for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_policies_touch on public.policies;
create trigger trg_policies_touch
  before update on public.policies
  for each row execute function public.touch_updated_at();

-- ---------- SCORINGS (saved single applications, max 50 per user) ----------
create table if not exists public.scorings (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users on delete cascade,
  inputs         jsonb not null,
  probability    double precision not null check (probability between 0 and 1),
  lane           text not null check (lane in ('decline','review','human')),
  threshold      numeric(3,2) check (threshold between 0.50 and 0.99),  -- policy in force when saved
  model_version  text not null,
  note           text check (char_length(note) <= 500),
  created_at     timestamptz not null default now()
);

alter table public.scorings enable row level security;

drop policy if exists "scorings are private" on public.scorings;
create policy "scorings are private" on public.scorings for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists scorings_user_idx on public.scorings(user_id, created_at desc);

-- ---------- BATCHES (triaged intake files, max 5 per user) ----------
create table if not exists public.batches (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null default auth.uid() references auth.users on delete cascade,
  file_path           text not null,                 -- {user_id}/{uuid}-{name}.csv in the "intake" bucket
  file_name           text check (char_length(file_name) <= 200),
  row_count           integer not null check (row_count >= 0),
  lane_counts         jsonb not null,                -- {"decline":n,"review":n,"human":n}
  wrong_decline_rate  double precision check (wrong_decline_rate between 0 and 1),  -- null when the file has no decision column
  gender_rates        jsonb,                         -- {"female":r,"male":r} auto-decline rates; null without a gender column
  threshold           numeric(3,2) not null check (threshold between 0.50 and 0.99),
  route_ntc           boolean not null default true,
  model_version       text not null,
  created_at          timestamptz not null default now(),
  constraint batches_file_in_own_folder check (split_part(file_path, '/', 1) = user_id::text)
);

alter table public.batches enable row level security;

drop policy if exists "batches are private" on public.batches;
create policy "batches are private" on public.batches for all to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create index if not exists batches_user_idx on public.batches(user_id, created_at desc);

-- ---------- AUDIT LOG (append-only: users can insert and read their own rows, never change them) ----------
create table if not exists public.audit_log (
  id          bigint generated always as identity primary key,
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  action      text not null check (char_length(action) <= 64),
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

alter table public.audit_log enable row level security;

drop policy if exists "audit read own"   on public.audit_log;
drop policy if exists "audit insert own" on public.audit_log;
create policy "audit read own"   on public.audit_log for select to authenticated using (auth.uid() = user_id);
create policy "audit insert own" on public.audit_log for insert to authenticated with check (auth.uid() = user_id);
-- No update/delete policies, and the privileges are revoked too, so rows cannot be edited or removed from the client.
revoke update, delete, truncate on public.audit_log from anon, authenticated;

create index if not exists audit_user_idx on public.audit_log(user_id, created_at desc);

-- Written by the database on every save, delete and policy change, so the log holds even if the UI is bypassed.
create or replace function public.write_audit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  j      jsonb := to_jsonb(case when tg_op = 'DELETE' then old else new end);
  detail jsonb;
begin
  -- Skip when the whole account is being deleted (the cascade removes the log as well).
  if not exists (select 1 from auth.users where id = (j->>'user_id')::uuid) then
    return null;
  end if;
  detail := case tg_table_name
    when 'scorings' then jsonb_build_object('id', j->'id', 'lane', j->'lane', 'probability', j->'probability', 'model_version', j->'model_version')
    when 'batches'  then jsonb_build_object('id', j->'id', 'file_name', j->'file_name', 'row_count', j->'row_count', 'lane_counts', j->'lane_counts', 'threshold', j->'threshold')
    else jsonb_build_object('threshold', j->'threshold', 'route_ntc', j->'route_ntc')
         || case when tg_op = 'UPDATE' then jsonb_build_object('previous', to_jsonb(old) - 'user_id' - 'updated_at') else '{}'::jsonb end
  end;
  insert into public.audit_log (user_id, action, detail)
  values ((j->>'user_id')::uuid,
          case tg_table_name when 'scorings' then 'scoring' when 'batches' then 'batch' else 'policy' end
          || case when tg_table_name = 'policies' then '.save' when tg_op = 'INSERT' then '.save' else '.delete' end,
          detail);
  return null;
end;
$$;

drop trigger if exists trg_scorings_audit on public.scorings;
create trigger trg_scorings_audit after insert or delete on public.scorings
  for each row execute function public.write_audit();
drop trigger if exists trg_batches_audit on public.batches;
create trigger trg_batches_audit after insert or delete on public.batches
  for each row execute function public.write_audit();
drop trigger if exists trg_policies_audit on public.policies;
create trigger trg_policies_audit after insert or update on public.policies
  for each row execute function public.write_audit();

-- ---------- HARD LIMITS: 50 saved scorings and 5 batches per user ----------
-- Enforced in the database, so the caps hold even if the UI is bypassed. The advisory lock
-- serialises concurrent saves by the same user, so two parallel inserts cannot both slip under the cap.
create or replace function public.enforce_save_limit()
returns trigger
language plpgsql
security definer set search_path = public
as $$
declare
  cap  integer := tg_argv[0]::integer;
  used integer;
begin
  perform pg_advisory_xact_lock(hashtext(tg_table_name), hashtext(new.user_id::text));
  execute format('select count(*) from public.%I where user_id = $1', tg_table_name) into used using new.user_id;
  if used >= cap then
    raise exception '%', case tg_table_name when 'scorings' then 'SCORING_LIMIT_REACHED' else 'BATCH_LIMIT_REACHED' end
      using hint = format('You have %s saved %s. Delete one to save another.', cap, tg_table_name);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_scorings_limit on public.scorings;
create trigger trg_scorings_limit before insert on public.scorings
  for each row execute function public.enforce_save_limit('50');
drop trigger if exists trg_batches_limit on public.batches;
create trigger trg_batches_limit before insert on public.batches
  for each row execute function public.enforce_save_limit('5');

-- ---------- DELETE MY ACCOUNT ----------
-- The client removes the user's files from Storage first (Supabase only allows that through the Storage API),
-- then calls this. Deleting the auth user cascades to every table above.
create or replace function public.delete_account()
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'NOT_SIGNED_IN';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
-- Trigger functions are never called directly.
revoke all on function public.handle_new_user(), public.write_audit(), public.enforce_save_limit(), public.touch_updated_at() from public, anon, authenticated;

-- Signed-out visitors get nothing from these tables.
revoke all on public.profiles, public.policies, public.scorings, public.batches, public.audit_log from anon;

-- ============================================================
--  STORAGE — uploaded intake CSVs, private, one folder per user: intake/{user_id}/{file}.csv
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('intake', 'intake', false, 10485760, array['text/csv', 'text/plain', 'application/vnd.ms-excel'])
on conflict (id) do update
  set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- Files a user holds in the bucket. Caps uploads at 5, matching the batch limit, so Storage cannot fill up with orphans.
create or replace function public.intake_file_count(uid uuid)
returns integer
language sql
stable
security definer set search_path = storage, public
as $$
  select count(*)::integer from storage.objects where bucket_id = 'intake' and (storage.foldername(name))[1] = uid::text;
$$;
revoke all on function public.intake_file_count(uuid) from public, anon;
grant execute on function public.intake_file_count(uuid) to authenticated;

drop policy if exists "intake read own"   on storage.objects;
drop policy if exists "intake insert own" on storage.objects;
drop policy if exists "intake delete own" on storage.objects;

create policy "intake read own" on storage.objects for select to authenticated
  using (bucket_id = 'intake' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "intake insert own" on storage.objects for insert to authenticated
  with check (bucket_id = 'intake' and (storage.foldername(name))[1] = auth.uid()::text
              and public.intake_file_count(auth.uid()) < 5);
create policy "intake delete own" on storage.objects for delete to authenticated
  using (bucket_id = 'intake' and (storage.foldername(name))[1] = auth.uid()::text);
