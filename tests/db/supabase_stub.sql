-- Minimal stand-in for the parts of a Supabase database that supabase/schema.sql relies on:
-- the anon/authenticated roles, auth.users + auth.uid(), and storage.buckets/objects + storage.foldername().
-- Used only by tests/db/run.sh against a throwaway local Postgres. Never run this in Supabase.
create role anon nologin;
create role authenticated nologin;
-- Owns the app tables, like Supabase's "postgres" role. Not a superuser, so RLS and privileges are really exercised.
create role app_owner nologin;

create schema auth;
create table auth.users (
  id                  uuid primary key default gen_random_uuid(),
  email               text,
  raw_user_meta_data  jsonb default '{}'::jsonb
);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;

create schema storage;
create table storage.buckets (
  id text primary key, name text not null, owner uuid, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[], created_at timestamptz default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name text, owner uuid, metadata jsonb, created_at timestamptz default now()
);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language plpgsql as $$
declare _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1:array_length(_parts, 1) - 1];
end $$;

grant usage on schema auth, storage, public to anon, authenticated, app_owner;
grant create on schema public to app_owner;
grant execute on function auth.uid() to anon, authenticated, app_owner;
grant select, insert, update, delete on storage.objects to anon, authenticated, app_owner;
grant select, insert, update, delete on storage.buckets to app_owner;
grant select on storage.buckets to authenticated;
grant select, delete on auth.users to app_owner;
grant references on auth.users to app_owner;
-- app_owner must be able to put a trigger on auth.users (Supabase's postgres role can)
alter table auth.users owner to app_owner;
alter table storage.objects owner to app_owner;
alter table storage.buckets owner to app_owner;
-- Supabase grants table privileges in public to the API roles by default; RLS is what protects the rows
alter default privileges for role app_owner in schema public grant all on tables to anon, authenticated;
alter default privileges for role app_owner in schema public grant all on sequences to anon, authenticated;
