# YGo timed jobs (#131 part 2b)

Part 2a supplies `job_runs` and the one-shot command. This part schedules the implemented `backup-nightly` and `cleanup-sessions` jobs. The weekly RDS snapshot gets its own timer and staleness check in part 2c. All units run on the production AL2023 host in `ap-south-1`; no agent creates AWS resources.

## Install and start

Complete [backup setup](backups.md), deploy a release containing `job.js` and `check-jobs.js`, and migrate its database before enabling timers. Verify the existing `/opt/ygo/ops/backup.sh` is root-owned and mode 0700. The instance role needs the #130 S3 permissions and the `cloudwatch:PutMetricData` permission for namespace `YGo` from [monitoring](monitoring.md). No access keys belong on the host.

Create root-owned mode-0600 `/etc/ygo/backup.env` containing `BACKUP_BUCKET=<dedicated-backup-bucket>` using the bucket identifier from the private operator log. Do not commit or paste its value into a PR. The production database URL remains only in `/etc/ygo/production.env`. The backup service reads both files; cleanup and the checker read only the production file. Install these reviewed files as root-owned under `/etc/systemd/system/`:

- `ops/ygo-job@.service` and `ops/ygo-job@.timer`
- `ops/ygo-job@backup-nightly.service.d/override.conf`
- `ops/ygo-job@cleanup-sessions.timer.d/override.conf`
- `ops/ygo-job-check.service` and `ops/ygo-job-check.timer`

Keep the two override directories with the same names. The template runs as `ygo-production` with the API unit's filesystem and privilege hardening. Only the backup instance runs as root because `backup.sh` requires root. Its override also shares `/tmp` with the transient `pg_dump` unit and permits the backup script's temporary archive there. The backup script verifies S3 lifecycle, dump readability, upload digest, download digest and downloaded archive before the job records `ok`. A failed script records `failed` with fixed `backup failed` text; details stay in journald, not `job_runs`.

Run `sudo systemd-analyze verify ygo-job@backup-nightly.service ygo-job@backup-nightly.timer ygo-job@cleanup-sessions.service ygo-job@cleanup-sessions.timer ygo-job-check.service ygo-job-check.timer`, then `sudo systemctl daemon-reload`. Inspect `systemctl cat` for both job instances and the checker before enabling them. Start each job once with `sudo systemctl start ygo-job@backup-nightly.service` and `sudo systemctl start ygo-job@cleanup-sessions.service`. Check exit status, journal, the verified S3 archive/digest, and `job_runs` rows. Then start `sudo systemctl start ygo-job-check.service` and inspect both `YGo/JobHealthy` metric series, each with its `JobName` dimension. A job with no successful run is unhealthy.

Only after these checks, run `sudo systemctl enable --now ygo-job@backup-nightly.timer ygo-job@cleanup-sessions.timer ygo-job-check.timer` and inspect `systemctl list-timers`. The schedules are 20:30 UTC backup, 22:30 UTC cleanup and 01:30 UTC checker, all `Persistent=true`. A missed firing runs after the host returns. The checker has its own unprivileged unit; it is not a job and writes no `job_runs` row. It ignores running rows: a latest **finished** failure reports 0; otherwise a success finished more than 26 hours ago (or no success) reports 0. Database read failures report 0 for every job. A failed metric publish exits nonzero, leaving the missing-data alarm to report trouble. The checker uses the instance role, not AWS keys.

After the first checker metrics arrive, rerun the reviewed `ops/monitoring.sh` as the operator and confirm `ygo-job-backup-nightly` and `ygo-job-cleanup-sessions` use the existing Mumbai SNS topic with confirmed email subscription. Both alarms evaluate the Minimum `JobHealthy` value over one day, threshold <1, one period, missing data breaching. Each job has its own alarm and 26-hour limit in the server job definition. A future job must add its timer, age limit, metric dimension and alarm in the same feature ticket.

## Prove alarm and recovery

`pnpm gate`, the real-Postgres job tests and the AL2023 `test-systemd-compat.py` check must pass in CI. On the host, record a successful manual run of both jobs, the verified S3 object and `job_runs` rows. Confirm the checker emits 1 for both dimensions. For each alarm, use a controlled maintenance window and publish **0 to its actual `YGo/JobHealthy` metric series** with `aws cloudwatch put-metric-data --region ap-south-1 --namespace YGo --metric-name JobHealthy --dimensions JobName=JOB_NAME --value 0 --unit Count`. Confirm the alarm enters ALARM and sends email; then run the real job and checker and confirm a 1 is published. Since the alarm uses the one-day Minimum, the 0 can keep it in ALARM until the next daily evaluation window. Confirm return to OK and the recovery email then. Record the metric history and emails privately; never paste account IDs, ARNs, database URLs or bucket names into the PR. If any metric, timer, alert or recovery fails, activation is incomplete.

The separate >30-day off-AWS removable-drive alarm and calendar reminder stay as described in [backups](backups.md). A successful S3 dump never proves an off-AWS copy.
