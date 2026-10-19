#!/usr/bin/env bash
# Root orchestrates files/systemd; only ygo-<environment> executes application code.
set -euo pipefail
umask 077
die() { echo "$*" >&2; exit 1; }
mode=${1:?Usage: deploy.sh deploy ENV SHA BUCKET SHA256 HTTPS_HEALTH_URL | rollback ENV SHA HTTPS_HEALTH_URL}
environment=${2:?Supply staging or production}
sha=${3:?Supply a full commit SHA}
[[ $EUID == 0 ]] || die "Run through SSM as root"
[[ $environment == staging || $environment == production ]] || die "Unknown environment"
[[ $sha =~ ^[a-f0-9]{40}$ ]] || die "Expected full lowercase commit SHA"
case $mode in
  deploy) bucket=${4:?Supply artifact bucket}; digest=${5:?Supply trusted SHA256}; public=${6:?Supply HTTPS health URL}
    [[ $bucket =~ ^[a-z0-9][a-z0-9.-]+[a-z0-9]$ && $digest =~ ^[a-f0-9]{64}$ ]] || die "Invalid bucket or digest" ;;
  rollback) public=${4:?Supply HTTPS health URL} ;;
  *) die "Choose deploy or rollback" ;;
esac
[[ $public =~ ^https://[a-zA-Z0-9.-]+/v1/healthz$ ]] || die "Expected public HTTPS /v1/healthz URL"
exec 9>/run/lock/ygo-deploy.lock
flock -n 9 || die "Another YGo deployment holds the host lock"
base=/opt/ygo/$environment
release=$base/releases/$sha
config=/etc/ygo/$environment.env
unit=ygo@$environment
port=3000; [[ $environment != production ]] || port=3001
work=$(mktemp -d /etc/ygo/deploy.XXXXXX)
trap 'rm -rf "$work"' EXIT
old=$(readlink "$base/current" || true)
[[ ! -f $config ]] || cp "$config" "$work/old.env"
install -d -m 0700 "$base/successful" "$base/digests"
if [[ $mode == deploy ]]; then
  aws --region ap-south-1 s3 cp "s3://$bucket/$environment/$sha.tar.gz" "$work/release.tar.gz" --only-show-errors
  printf '%s  %s\n' "$digest" "$work/release.tar.gz" | sha256sum --check --strict
  if [[ -d $release ]]; then
    [[ $(cat "$base/digests/$sha") == "$digest" ]] || die "Commit already exists with different artifact bytes"
  else
    mkdir "$work/unpacked"
    # Python's data filter rejects traversal, escaping links and special files.
    python3.12 - "$work/release.tar.gz" "$work/unpacked" <<'EXTRACT'
import sys, tarfile
with tarfile.open(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2], filter="data")
EXTRACT
    chown -R "root:ygo-$environment" "$work/unpacked"
    chmod -R u=rwX,g=rX,o= "$work/unpacked"
    mv "$work/unpacked" "$release"
    printf '%s\n' "$digest" > "$base/digests/$sha"
  fi
  aws --region ap-south-1 ssm get-parameter --name "/ygo/$environment/runtime" --with-decryption --query Parameter.Value --output text > "$work/new.env"
  if [[ $(grep -cE '^[[:space:]]*(HOST|PORT)[[:space:]]*=' "$work/new.env") != 2 ]] ||
     ! grep -qxF "PORT=$port" "$work/new.env" || ! grep -qxF 'HOST=127.0.0.1' "$work/new.env"; then
    die "Runtime must use its assigned loopback host/port"
  fi
  systemd-run --quiet --wait --collect --service-type=exec --unit="ygo-migrate-$environment-$$" \
    --uid="ygo-$environment" --gid="ygo-$environment" -p "EnvironmentFile=$work/new.env" -p RuntimeMaxSec=600 \
    /opt/ygo/node/bin/node "$release/migrate.js"
else
  [[ -f $base/successful/$sha && -f $config ]] || die "Rollback requires a retained successful release and current configuration"
fi
switch() {
  ln -sfn "$1" "$base/current.next" && mv -Tf "$base/current.next" "$base/current"
}
healthy() {
  # shellcheck disable=SC2016 # Positional parameters expand in the child shell.
  timeout --kill-after=5 60 bash -c '
    until curl -fsS --max-time 3 "http://127.0.0.1:$1/v1/healthz" >/dev/null 2>&1 &&
          curl -fsS --max-time 3 "$2" >/dev/null 2>&1; do sleep 1; done
  ' bash "$port" "$public"
}
# No active configuration or symlink changes until artifact, secrets and migration succeed.
if { [[ $mode != deploy ]] || mv -Tf "$work/new.env" "$config"; } && switch "$release" &&
   systemctl reset-failed "$unit" && systemctl enable "$unit" && systemctl restart "$unit" && healthy; then
  if [[ -n $old && $old != "$release" ]]; then
    ln -sfn "$old" "$base/previous.next"
    mv -Tf "$base/previous.next" "$base/previous"
  fi
  touch "$base/successful/$sha"
else
  echo "Activation failed; restoring previous application and pre-deploy configuration" >&2
  if [[ -n $old && -f $work/old.env ]]; then
    mv -Tf "$work/old.env" "$config"
    if ! { switch "$old" && systemctl reset-failed "$unit" && systemctl restart "$unit" && healthy; }; then
      systemctl disable --now "$unit" || true
      die "Recovery failed; service stopped. Inspect journalctl -u $unit"
    fi
    if [[ $mode == rollback ]]; then
      die "Rollback failed; previous application is healthy again"
    fi
    die "Deployment failed; previous application is healthy again"
  fi
  systemctl disable --now "$unit" || true
  rm -f "$base/current"
  die "First deployment failed; service is off and current is removed"
fi
# Failed artifacts do not consume retention slots. Never prune on an unsuccessful activation.
declare -A keep=()
keep[$sha]=1
previous=$(readlink "$base/previous" || true)
[[ -z $previous ]] || keep[${previous##*/}]=1
while read -r retained; do
  (( ${#keep[@]} < 3 )) || break
  keep[$retained]=1
done < <(find "$base/successful" -type f -printf '%T@ %f\n' | sort -nr | awk '{print $2}')
for directory in "$base"/releases/*; do
  candidate=${directory##*/}
  [[ $candidate =~ ^[a-f0-9]{40}$ && -z ${keep[$candidate]:-} ]] || continue
  rm -rf -- "$directory"
  rm -f "$base/successful/$candidate" "$base/digests/$candidate"
done
printf 'Healthy %s %s %s\n' "$environment" "$sha" "$mode"
