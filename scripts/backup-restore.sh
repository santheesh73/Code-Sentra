#!/usr/bin/env bash
# CodeSentra Postgres backup / restore / rehearsal (Section 20).
#
#   backup   <DATABASE_URL> <out.dump>          pg_dump a database to a custom-format archive
#   restore  <DATABASE_URL> <in.dump>           pg_restore an archive into an EMPTY database
#   rehearse <SOURCE_URL> <ADMIN_URL>           dump SOURCE, restore into a fresh DB on ADMIN,
#                                               and verify table/row counts match
#   verify   <DATABASE_URL>                     print a table/row-count fingerprint
#
# Custom format (-Fc) so restore can run in parallel and select objects. The app role
# (codesentra_app) is created by the migrations, not the dump, so restore does not need it.
# Object storage (zips, snapshots) is backed up separately by your bucket's versioning /
# replication — see docs/runbook.md; this script covers the database only.
set -euo pipefail

die() { echo "error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "missing required tool: $1"; }
need pg_dump; need pg_restore; need psql

# A stable fingerprint of the data: every public table and its row count, ordered.
fingerprint() {
  local url="$1"
  psql "$url" -At -F $'\t' -c "
    select relname, n_live_tup
    from pg_stat_user_tables
    where schemaname = 'public'
    order by relname" 2>/dev/null \
  || psql "$url" -At -F $'\t' -c "
    select c.relname,
           (xpath('/row/c/text()',
             query_to_xml(format('select count(*) c from public.%I', c.relname), false, true, '')))[1]::text::bigint
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  backup)
    url="${1:?DATABASE_URL}"; out="${2:?out.dump}"
    echo "dumping to $out ..." >&2
    pg_dump --format=custom --no-owner --no-privileges --file="$out" "$url"
    echo "ok: $(du -h "$out" | cut -f1) archive" >&2
    ;;
  restore)
    url="${1:?DATABASE_URL}"; in="${2:?in.dump}"
    [ -s "$in" ] || die "archive not found or empty: $in"
    echo "restoring $in into $url ..." >&2
    pg_restore --no-owner --no-privileges --exit-on-error --jobs=4 --dbname="$url" "$in"
    echo "ok: restored" >&2
    ;;
  verify)
    fingerprint "${1:?DATABASE_URL}"
    ;;
  rehearse)
    src="${1:?SOURCE_URL}"; admin="${2:?ADMIN_URL (a maintenance connection, e.g. .../postgres)}"
    tmp="$(mktemp -d)"; dump="$tmp/rehearse.dump"
    name="cs_restore_rehearsal_$(date +%s)"
    trap 'rm -rf "$tmp"; psql "$admin" -c "DROP DATABASE IF EXISTS \"$name\" WITH (FORCE)" >/dev/null 2>&1 || true' EXIT
    echo "1/4 dump source" >&2;    pg_dump --format=custom --no-owner --no-privileges --file="$dump" "$src"
    echo "2/4 create $name" >&2;   psql "$admin" -c "CREATE DATABASE \"$name\"" >/dev/null
    target="$(python3 - "$admin" "$name" <<'PY'
import sys, urllib.parse as u
a=u.urlsplit(sys.argv[1]); print(u.urlunsplit((a.scheme,a.netloc,'/'+sys.argv[2],a.query,a.fragment)))
PY
)"
    echo "3/4 restore into $name" >&2
    pg_restore --no-owner --no-privileges --exit-on-error --jobs=4 --dbname="$target" "$dump"
    echo "4/4 compare fingerprints" >&2
    a="$tmp/a.txt"; b="$tmp/b.txt"
    fingerprint "$src" > "$a"; fingerprint "$target" > "$b"
    if diff -u "$a" "$b" >&2; then
      echo "REHEARSAL OK: restored database matches the source ($(wc -l < "$a" | tr -d ' ') tables)" >&2
    else
      die "REHEARSAL FAILED: the restored database does not match the source"
    fi
    ;;
  *)
    sed -n '2,20p' "$0" >&2; exit 2 ;;
esac
