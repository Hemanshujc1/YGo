#!/usr/bin/env bash
# Restore a verified archive into a new empty database. Never mutate the old DB.
set -euo pipefail
umask 077
die() { echo "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || die "Run as root through Session Manager"
archive=${1:?Usage: restore.sh ARCHIVE SHA256_FILE RECOVERY_ENV}
digest=${2:?Supply archive SHA256 file}
recovery=${3:?Supply separate recovery environment file}
[[ -f $archive && -f $digest && -f $recovery ]] || die "Missing recovery input"
[[ -f /etc/ygo/production.env ]] || die "Missing production configuration"
exec 9>/run/lock/ygo-deploy.lock
flock -n 9 || die "Another YGo host operation is running"
unit=ygo@production
# Stop and disable before every failure-prone step, including validation.
systemctl disable --now "$unit"
committed=false
work=$(mktemp -d /etc/ygo/restore.XXXXXX)
cp /etc/ygo/production.env "$work/old.env"
cleanup() {
  if [[ $committed != true ]]; then
    systemctl disable --now "$unit" || true
    cp "$work/old.env" /etc/ygo/production.env
  fi
  rm -rf "$work"
}
trap cleanup EXIT
# Compare database host/port/name, ignoring credentials; reject malformed or duplicate values.
python3 - /etc/ygo/production.env "$recovery" <<'CHECK' || die "Recovery target is invalid or matches production"
import shlex, sys
from urllib.parse import urlsplit
def identity(path):
    values = [line.split('=', 1)[1].strip() for line in open(path) if line.startswith('DATABASE_URL=')]
    assert len(values) == 1
    words = shlex.split(values[0]); assert len(words) == 1
    url = urlsplit(words[0]); assert url.scheme in ('postgres', 'postgresql') and url.hostname and url.path not in ('', '/')
    return (url.hostname.lower(), url.port or 5432, url.path)
assert identity(sys.argv[1]) != identity(sys.argv[2])
CHECK
[[ ! -L $recovery && $(stat -c '%a:%u' "$recovery") == 600:0 ]] || die "Recovery environment file must be root-owned, mode 0600"
[[ $(sha256sum "$archive" | cut -d' ' -f1) == "$(cut -d' ' -f1 "$digest")" ]] || die "Archive SHA256 mismatch"
pg_restore --file=/dev/null "$archive" || die "Archive verification failed"
run_db() {
  systemd-run --quiet --wait --collect --expand-environment=no --service-type=exec --unit="ygo-restore-$$-$RANDOM" \
    -p "EnvironmentFile=$recovery" -p RuntimeMaxSec=7200 /usr/bin/bash -c "$1" bash "${@:2}"
}
# shellcheck disable=SC2016 # DATABASE_URL expands only inside the transient service.
run_db 'psql "$DATABASE_URL" -Atqc "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('\''pg_catalog'\'','\''information_schema'\'') AND n.nspname NOT LIKE '\''pg_toast%'\'' AND c.relkind IN ('\''r'\'','\''p'\'','\''v'\'','\''m'\'','\''S'\'')" > "$1"' "$work/empty.count" || die "Cannot inspect recovery target"
count=$(cat "$work/empty.count")
[[ $count == 0 ]] || die "Recovery target is not empty"
# shellcheck disable=SC2016 # Same transient-service expansion.
run_db 'exec pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname="$DATABASE_URL" "$1"' "$archive" || die "Restore failed"
# shellcheck disable=SC2016 # Same transient-service expansion.
run_db 'psql "$DATABASE_URL" -Atqc "SELECT count(*) FROM information_schema.tables WHERE table_schema='\''public'\''" > "$1"' "$work/restored.count" || die "Cannot verify restored database"
count=$(cat "$work/restored.count")
[[ $count =~ ^[1-9][0-9]*$ ]] || die "Restored database has no public tables"
[[ -f /opt/ygo/production/current/replay-deletions.js ]] || die "Missing #92 replay-deletions.js; service remains stopped"
systemd-run --quiet --wait --collect --service-type=exec --unit="ygo-replay-$$" \
  --uid=ygo-production --gid=ygo-production -p "EnvironmentFile=$recovery" -p RuntimeMaxSec=7200 \
  /opt/ygo/node/bin/node /opt/ygo/production/current/replay-deletions.js || die "Deletion replay failed (#92)"
install -m 0600 "$recovery" "$work/new.env"
mv -f "$work/new.env" /etc/ygo/production.env
systemctl enable --now "$unit" || die "Service start failed"
timeout --kill-after=5 60 bash -c '
  until curl -fsS --max-time 3 http://127.0.0.1:3001/v1/healthz >/dev/null 2>&1; do sleep 1; done
' || die "Recovered service failed health check"
committed=true
echo "Recovery complete; service started"
