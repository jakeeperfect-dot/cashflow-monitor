create table if not exists public.kdcashflow_state (
  id text primary key check (id = 'primary'),
  version bigint not null default 0,
  payload jsonb not null
);

insert into public.kdcashflow_state (id, version, payload)
values (
  'primary',
  0,
  '{"branches":["Kapatagan Main"],"transactions":[],"users":[],"transactionEditRequests":[],"transactionHistory":[]}'::jsonb
)
on conflict (id) do nothing;

create table if not exists public.kdcashflow_sessions (
  token_hash text primary key,
  user_id text not null,
  expires_at timestamptz not null
);

create index if not exists kdcashflow_sessions_user_id_idx
  on public.kdcashflow_sessions (user_id);

create table if not exists public.kdcashflow_login_attempts (
  ip_hash text primary key,
  window_started_at timestamptz not null,
  failure_count integer not null default 0
);

alter table public.kdcashflow_state enable row level security;
alter table public.kdcashflow_sessions enable row level security;
alter table public.kdcashflow_login_attempts enable row level security;

create or replace function public.kdcashflow_compare_and_set_state(
  p_expected_version bigint,
  p_payload jsonb
)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  updated_count integer;
begin
  update public.kdcashflow_state
  set payload = p_payload, version = version + 1
  where id = 'primary' and version = p_expected_version;

  get diagnostics updated_count = row_count;
  return updated_count = 1;
end;
$$;

create or replace function public.kdcashflow_begin_login_attempt(p_ip_hash text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
declare
  attempt_count integer;
begin
  insert into public.kdcashflow_login_attempts as attempts (ip_hash, window_started_at, failure_count)
  values (p_ip_hash, now(), 1)
  on conflict (ip_hash) do update
  set window_started_at = case
        when now() - attempts.window_started_at > interval '15 minutes' then now()
        else attempts.window_started_at
      end,
      failure_count = case
        when now() - attempts.window_started_at > interval '15 minutes' then 1
        else least(attempts.failure_count + 1, 11)
      end
  returning failure_count into attempt_count;
  return attempt_count <= 10;
end;
$$;

create or replace function public.kdcashflow_reset_login_attempts(p_ip_hash text)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from public.kdcashflow_login_attempts where ip_hash = p_ip_hash;
$$;

revoke all on public.kdcashflow_state from public, anon, authenticated;
revoke all on public.kdcashflow_sessions from public, anon, authenticated;
revoke all on public.kdcashflow_login_attempts from public, anon, authenticated;
revoke all on function public.kdcashflow_compare_and_set_state(bigint, jsonb) from public, anon, authenticated;
revoke all on function public.kdcashflow_begin_login_attempt(text) from public, anon, authenticated;
revoke all on function public.kdcashflow_reset_login_attempts(text) from public, anon, authenticated;
grant select, update on public.kdcashflow_state to service_role;
grant select, insert, update, delete on public.kdcashflow_sessions to service_role;
grant select, insert, update, delete on public.kdcashflow_login_attempts to service_role;
grant execute on function public.kdcashflow_compare_and_set_state(bigint, jsonb) to service_role;
grant execute on function public.kdcashflow_begin_login_attempt(text) to service_role;
grant execute on function public.kdcashflow_reset_login_attempts(text) to service_role;
