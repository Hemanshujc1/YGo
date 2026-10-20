#!/usr/bin/env bash
# Called by the future #131 timer, never by the API process.
set -euo pipefail
umask 077
die() { echo "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || die "Run as root on the YGo host"
mode=${1:?Usage: backup.sh dump BUCKET | snapshot RDS_INSTANCE}
stamp=$(date -u +%Y%m%d)
case $mode in
  dump)
    bucket=${2:?Supply dedicated backup bucket}
    [[ $bucket =~ ^[a-z0-9][a-z0-9.-]+[a-z0-9]$ ]] || die "Invalid bucket"
    # A backup bucket must not be the versioned photo bucket. Fail if lifecycle drifts.
    [[ $(aws --region ap-south-1 s3api get-bucket-versioning --bucket "$bucket" --query Status --output text) == None ]] || die "Backup bucket must never have been versioned"
    aws --region ap-south-1 s3api get-bucket-lifecycle-configuration --bucket "$bucket" |
      python3 -c 'import json,sys; r=json.load(sys.stdin)["Rules"]; assert len(r)==1 and set(r[0]) <= {"ID","Status","Filter","Expiration"} and r[0]["Status"]=="Enabled" and r[0].get("Filter")=={"Prefix":"nightly/"} and r[0]["Expiration"]=={"Days":30}' || die "Expected 30-day nightly/ expiration without earlier actions"
    work=$(mktemp -d)
    trap 'rm -rf "$work"' EXIT
    # The root-only systemd environment file is read by systemd, not sourced.
    # shellcheck disable=SC2016 # DATABASE_URL expands inside the transient service.
    systemd-run --quiet --wait --collect --expand-environment=no --service-type=exec --unit="ygo-dump-$$" \
      -p EnvironmentFile=/etc/ygo/production.env -p RuntimeMaxSec=7200 \
      /usr/bin/bash -c 'exec pg_dump -Fc --file="$1" "$DATABASE_URL"' bash "$work/$stamp.dump" || die "Dump failed"
    pg_restore --file=/dev/null "$work/$stamp.dump" || die "Archive unreadable"
    (cd "$work" && sha256sum "$stamp.dump" > "$stamp.dump.sha256")
    uri="s3://$bucket/nightly/$stamp.dump"
    aws --region ap-south-1 s3 cp "$work/$stamp.dump" "$uri" --only-show-errors
    aws --region ap-south-1 s3 cp "$work/$stamp.dump.sha256" "$uri.sha256" --only-show-errors
    aws --region ap-south-1 s3 cp "$uri" "$work/verify.dump" --only-show-errors
    aws --region ap-south-1 s3 cp "$uri.sha256" "$work/verify.sha256" --only-show-errors
    cmp "$work/$stamp.dump.sha256" "$work/verify.sha256" || die "Uploaded digest mismatch"
    [[ $(sha256sum "$work/verify.dump" | cut -d' ' -f1) == "$(cut -d' ' -f1 "$work/verify.sha256")" ]] || die "Uploaded archive mismatch"
    pg_restore --file=/dev/null "$work/verify.dump" || die "Uploaded archive unreadable"
    echo "Verified nightly backup $uri"
    ;;
  snapshot)
    instance=${2:?Supply RDS instance identifier}
    [[ $instance =~ ^[a-z][a-z0-9-]+$ ]] || die "Invalid RDS identifier"
    aws --region ap-south-1 rds create-db-snapshot --db-instance-identifier "$instance" --db-snapshot-identifier "ygo-weekly-$stamp"
    aws --region ap-south-1 rds wait db-snapshot-completed --db-snapshot-identifier "ygo-weekly-$stamp"
    cutoff=$(date -u -d '35 days ago' +%Y%m%d)
    snapshots=$(aws --region ap-south-1 rds describe-db-snapshots --db-instance-identifier "$instance" --snapshot-type manual --query 'DBSnapshots[].DBSnapshotIdentifier' --output text) || die "Could not inspect snapshots"
    while read -r snapshot; do
      [[ $snapshot =~ ^ygo-weekly-([0-9]{8})$ ]] || continue
      [[ ${BASH_REMATCH[1]} < $cutoff ]] || continue
      aws --region ap-south-1 rds delete-db-snapshot --db-snapshot-identifier "$snapshot"
    done < <(printf '%s\n' "$snapshots" | tr '\t' '\n')
    ;;
  *) die "Choose dump or snapshot" ;;
esac
