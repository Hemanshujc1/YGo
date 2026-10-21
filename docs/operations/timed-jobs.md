# YGo timed jobs (#131 part 2b)

Part 2a supplies `job_runs` and the one-shot command. The template schedules `backup-nightly`, `cleanup-sessions`, and now `snapshot-weekly`, each with its own freshness metric and alarm. All units run on the production AL2023 host in `ap-south-1`; no agent creates AWS resources.

## Install and start

Complete [backup setup](backups.md), deploy a release containing `job.js` and `check-jobs.js`, and migrate its database before enabling timers. Verify the existing `/opt/ygo/ops/backup.sh` is root-owned and mode 0700. The instance role needs the backup S3 permissions, the [production-scoped RDS snapshot permissions](backups.md), and `cloudwatch:PutMetricData` for namespace `YGo` from [monitoring](monitoring.md). No access keys belong on the host.

Create root-owned mode-0600 `/etc/ygo/backup.env` containing `BACKUP_BUCKET=<dedicated-backup-bucket>` and `RDS_INSTANCE_ID=<production-rds-instance>` using identifiers from the private operator log. Do not commit or paste their values into a PR. The production database URL remains only in `/etc/ygo/production.env`. The backup and snapshot services read both files; cleanup and the checker read only the production file. Install these reviewed files as root-owned under `/etc/systemd/system/`:

- `ops/ygo-job@.service` and `ops/ygo-job@.timer`
- `ops/ygo-job@backup-nightly.service.d/override.conf`
- `ops/ygo-job@backup-nightly.timer.d/override.conf`
- `ops/ygo-job@cleanup-sessions.timer.d/override.conf`
- `ops/ygo-job@snapshot-weekly.service.d/override.conf`
- `ops/ygo-job@snapshot-weekly.timer.d/override.conf`
- `ops/ygo-job-check.service` and `ops/ygo-job-check.timer`

Keep the override directories with the same names. The template runs as `ygo-production` with the API unit's filesystem and privilege hardening. Backup and snapshot alone override to root because `backup.sh` requires root. The backup override shares `/tmp` with the transient `pg_dump` unit and permits the temporary archive there. The backup script verifies S3 lifecycle, dump readability, upload digest, download digest and downloaded archive before recording `ok`. The snapshot script records `ok` only after RDS reports `available` and retention succeeds. It polls for up to 170 minutes, leaving ten minutes of the service's three-hour timeout for retention. Failures store fixed `backup failed` or `snapshot failed` text; details stay in journald.

Run `sudo systemd-analyze verify ygo-job@backup-nightly.service ygo-job@backup-nightly.timer ygo-job@cleanup-sessions.service ygo-job@cleanup-sessions.timer ygo-job@snapshot-weekly.service ygo-job@snapshot-weekly.timer ygo-job-check.service ygo-job-check.timer`, then `sudo systemctl daemon-reload`. Inspect `systemctl cat` for all three job instances and the checker. Start each job once with `sudo systemctl start ygo-job@JOB.service`. Check exit status, journal, the verified S3 archive/digest, the RDS snapshot's `available` status, and `job_runs` rows. A second snapshot start on the same UTC date uses the same snapshot name and fails; inspect the existing snapshot before retrying. Then start `sudo systemctl start ygo-job-check.service` and inspect all three `YGo/JobHealthy` series, each with its `JobName` dimension. A job with no successful run is unhealthy.

Only after these checks, run `sudo systemctl enable --now ygo-job@backup-nightly.timer ygo-job@cleanup-sessions.timer ygo-job@snapshot-weekly.timer ygo-job-check.timer` and inspect `systemctl list-timers`. The overrides set 20:30 UTC nightly backup, 22:30 UTC cleanup, and **Monday 00:30 UTC (06:00 IST)** snapshot; the checker runs daily at 01:30 UTC. All use `Persistent=true`. A missed firing runs after the host returns. The checker has its own unprivileged unit; it is not a job and writes no `job_runs` row. It ignores running rows: a latest **finished** failure reports 0; otherwise a success older than its limit (26 hours for daily jobs, eight days for snapshots) or no success reports 0. Database read failures report 0 for every job; a missing or invalid database URL publishes nothing, so missing data breaches. A failed metric publish exits nonzero, leaving the missing-data alarm to report trouble. The checker uses the instance role, not AWS keys.

After the first checker metrics arrive, rerun the reviewed `ops/monitoring.sh` as the operator and confirm all three `ygo-job-*` alarms use the existing Mumbai SNS topic with confirmed email subscription. Each evaluates the Minimum `JobHealthy` value over one day, threshold <1, one period, missing data breaching. A future job must add its timer, age limit, metric dimension and alarm in the same feature ticket.

## Prove alarm and recovery

`pnpm gate`, real-Postgres job/freshness tests, the slow-snapshot/retention script test, and AL2023 `test-systemd-compat.py` must pass in CI. On the host, record successful runs of all three jobs, the verified S3 object, the `available` RDS snapshot, and `job_runs` rows. Confirm the checker emits 1 for all three dimensions. For each alarm, use a controlled maintenance window and publish **0 to its actual `YGo/JobHealthy` metric series** with `aws cloudwatch put-metric-data --region ap-south-1 --namespace YGo --metric-name JobHealthy --dimensions JobName=JOB_NAME --value 0 --unit Count`. Confirm ALARM and email; then run the real job and checker and confirm a 1 is published. Since the alarm uses the one-day Minimum, the 0 can keep it in ALARM until the next daily evaluation window. Confirm return to OK and the recovery email then. Record metric history and emails privately; never paste account IDs, ARNs, database URLs or bucket names into the PR. If any metric, timer, alert or recovery fails, activation is incomplete.

The separate >30-day off-AWS removable-drive alarm and calendar reminder stay as described in [backups](backups.md). A successful S3 dump never proves an off-AWS copy.
