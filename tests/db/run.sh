#!/usr/bin/env bash
# Runs supabase/schema.sql twice (idempotency) against a throwaway local Postgres with a Supabase stand-in,
# then the RLS / limit / audit / storage / delete-account tests. Needs Postgres 15+ binaries (initdb, pg_ctl, psql).
#   bash tests/db/run.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PGBIN="${PGBIN:-$(dirname "$(command -v pg_ctl 2>/dev/null || ls /usr/lib/postgresql/*/bin/pg_ctl | tail -1)")}"
DIR="$(mktemp -d)"; PORT="${PGPORT_TEST:-54329}"
cleanup() { "$PGBIN/pg_ctl" -D "$DIR/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT

RUNAS=()
if [ "$(id -u)" = 0 ]; then chown -R nobody "$DIR" 2>/dev/null; RUNAS=(runuser -u nobody --); fi
"${RUNAS[@]}" "$PGBIN/initdb" -D "$DIR/data" -U postgres -A trust >/dev/null
"${RUNAS[@]}" "$PGBIN/pg_ctl" -D "$DIR/data" -o "-p $PORT -k $DIR -c listen_addresses=''" -l "$DIR/log" -w start >/dev/null

export PGOPTIONS="-c client_min_messages=warning"
PSQL=(psql -h "$DIR" -p "$PORT" -U postgres -d postgres -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" -f "$ROOT/tests/db/supabase_stub.sql" >/dev/null
for i in 1 2; do
  # Like Supabase's SQL editor: run as the (non-superuser) owner role
  { echo "set role app_owner;"; cat "$ROOT/supabase/schema.sql"; } | "${PSQL[@]}" >/dev/null
done
echo "  ok  schema.sql applies cleanly, twice"
"${PSQL[@]}" -f "$ROOT/tests/db/rls_test.sql"
echo "db: all checks passed"
