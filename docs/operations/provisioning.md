# Provision YGo (#35)

Owner-operated runbook for ADR-0004/0005/0008. #132 supplies host setup and release packaging; #133 adds deploy/rollback and #134 adds OIDC promotion. Production automation is ready only after all three. #130 supplies backup/restore and #131 supplies monitoring/jobs. Complete those before the production pilot; this runbook lets provisioning begin now. Never put credentials, parameter values or downloaded dumps in Git.

## Account and billing first

Use the owner's AWS account, MFA and **ap-south-1**. Before creating chargeable resources, create a zero-spend budget and USD 25/50/100 actual-spend budget notifications to the owner; confirm delivery. Set reminders for credit exhaustion and six months from account creation. Upgrade the Free plan before real customer/shop data or the pilot, whichever comes first, and immediately if a needed service is unavailable. Record the first invoice's tax treatment. No agent creates resources in this ticket.

Record these non-secret identifiers in the private operator log: account ID, VPC/subnets, EC2 instance ID/public address, RDS endpoint, photo/backup/deploy bucket names, alarm email, chosen DNS names, runtime version/checksum and setup date. Never choose a domain until #27 is settled.

## Network, database and storage

1. Create a VPC with an Internet Gateway, one public subnet and a public route; add private subnets in two AZs for the RDS subnet group (RDS itself remains Single-AZ). No NAT gateway or load balancer.
2. EC2: AL2023 ARM64 AMI, t4g.small, encrypted 30 GB gp3, public IPv4, IMDSv2 required, no key pair. Its security group allows inbound TCP 80/443 only; never 22 or 3000/3001. Permit outbound HTTPS for SSM, packages and AWS APIs, database TCP 5432 to the RDS group, and DNS resolution. RDS permits TCP 5432 only from the EC2 group.
3. RDS: PostgreSQL 17, current supported minor, db.t4g.micro, Single-AZ, private/not public, encrypted 20 GB gp3, seven-day automated backups and deletion protection. Confirm the PostgreSQL/PostGIS pairing in the console; record it. Weekly snapshots/dump retention are completed in #130.
4. Create private S3 buckets in Mumbai for photos, backups and deployments, with Block Public Access, encryption and versioning. #130 defines backup-version expiry; versioning alone does not expire personal data. Do not apply backup retention to photos or deployment artifacts indiscriminately.
5. Open Session Manager through the EC2 instance role below. Verify there is no SSH ingress. Download the regional RDS CA (setup does this); all RDS connection URLs use `sslmode=verify-full&sslrootcert=/etc/ygo/rds-ca.pem` and the actual RDS DNS hostname, never its IP.

Connect to RDS from the instance using `psql` with TLS and a password prompt (never put a password in a shell command). As the RDS administrator, create distinct LOGIN roles `ygo_staging` and `ygo_production` using `CREATE ROLE ... LOGIN`, set their passwords with psql's `\password`, then create `ygo_staging`/`ygo_production` databases owned by the matching role. Connect to each database as administrator and run `CREATE EXTENSION IF NOT EXISTS postgis;`. App roles must not be superusers, have CREATEDB/CREATEROLE, or receive access to the other database: revoke CONNECT from PUBLIC on each and grant CONNECT only to its matching role. The deploy migration uses that database's owner role; do not give it the RDS administrator password.

## IAM and configuration

Attach `AmazonSSMManagedInstanceCore` to the EC2 instance role. Add `ssm:GetParameter` restricted to `/ygo/staging/runtime` and `/ygo/production/runtime`; grant `kms:Decrypt` on their key if using a customer-managed key. Add `s3:GetObject` only for this instance's deployment prefixes. Photo/backup/SES/log-shipping permissions are added by their own tickets. Never attach an administrator policy to the instance.

In Parameter Store, create two **SecureString** values at those paths, each a systemd environment-file document. Set HOST=127.0.0.1, LOG_LEVEL=info, PORT=3000 for staging and PORT=3001 for production, DATABASE_URL with the matching role/database and TLS settings above, plus MIN_CUSTOMER_VERSION/MIN_SHOPKEEPER_VERSION=0.0.0. Use systemd quoting rules for values; URL-encode password characters in DATABASE_URL. Values stay in SSM; never paste them into this runbook or a PR. #133 retrieves them atomically to root-owned mode-0600 `/etc/ygo/<environment>.env`; the application never calls SSM.

Prepare the GitHub OIDC provider `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com`. Create separate staging/production roles whose trust restricts both audience and exact subject `repo:Hemanshujc1/YGo:environment:staging` or `repo:Hemanshujc1/YGo:environment:production`. In GitHub Environments, allow only main and require owner approval for production; an environment subject does not itself enforce a branch. No long-lived AWS key.

For #134, role policies scope S3 PutObject/GetObject to the environment's deployment prefix, SendCommand to the one EC2 instance and approved deployment SSM document, and GetCommandInvocation for result polling (that action needs Resource `*`). Do not grant access to SecureString values to Actions. Final document ARN, artifact/promotion permissions and workflow variable names ship in #134; do not enable production dispatch before then. Staging health evidence must authorize the exact full commit SHA before production can run.

## Host setup

AL2023's documented Node packages currently cover 20/22/24, so install the official ARM64 Node 26 archive, not the distribution's default Node. On a trusted workstation choose the approved full Node 26 version and review its linux-arm64 SHA256 from the official release's SHASUMS256.txt; record both. Recheck the Node support schedule before pilot launch.

Transfer `ops/setup-host.sh` and `ops/ygo@.service` from the reviewed commit to the same directory on the instance using Session Manager. Inspect them, then run:

```sh
sudo bash ops/setup-host.sh <26.x.y> <reviewed-64-character-archive-sha256>
```

The script checks AL2023/ARM64/root, verifies the archive checksum, installs the runtime at `/opt/ygo/node`, Nginx, PostgreSQL 17 clients, Certbot **5.8.0** and certbot-nginx **5.8.0**, and creates separate unprivileged service users and root-owned release directories. It installs the service template and leaves both API units off. Only rerun for a runtime update with both units stopped; record and verify the new version. No npm/pnpm install runs on the host. Check `aws --version`, `/opt/ygo/node/bin/node --version`, `psql --version`, `/opt/certbot/bin/pip show certbot certbot-nginx` and Session Manager connectivity.

API stdout/stderr use the systemd defaults and go to journald, whose size limits cap local log storage; no `/var/log/ygo` directory or append-only API log files are created. Inspect logs with `sudo journalctl -u ygo@staging -u ygo@production -n 50 --no-pager`. In #35, verify the effective journal limits with `systemd-analyze cat-config systemd/journald.conf` and usage with `journalctl --disk-usage`; #131 adds shipping from journald to CloudWatch with seven-day remote retention.

## DNS, TLS and renewal

After #27, create the Route 53 zone and delegate nameservers at the registrar. Point distinct staging/production API names to the instance; wait for public resolution. For each, install `/etc/nginx/conf.d/ygo-<environment>.conf`, replacing API_HOST and PORT (staging 3000, production 3001):

```nginx
server {
    listen 80;
    server_name API_HOST;
    location / {
        proxy_pass http://127.0.0.1:PORT;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $remote_addr;
    }
}
```

Run `sudo nginx -t` then `sudo systemctl reload nginx`. Issue TLS using `sudo /opt/certbot/bin/certbot --nginx --redirect -d <staging-api-name> -d <production-api-name>`; supply the owner's renewal email and accept terms interactively. Certbot's challenge requires public port 80 even after HTTPS redirects.

Create `/etc/systemd/system/ygo-certbot.service`:

```ini
[Unit]
Description=Renew YGo TLS certificates
[Service]
Type=oneshot
ExecStart=/opt/certbot/bin/certbot renew --quiet
ExecStartPost=/usr/sbin/nginx -s reload
```

Create `/etc/systemd/system/ygo-certbot.timer`:

```ini
[Unit]
Description=Check YGo TLS renewal twice daily
[Timer]
OnCalendar=*-*-* 00,12:00:00
RandomizedDelaySec=3600
Persistent=true
[Install]
WantedBy=timers.target
```

Run `sudo systemctl daemon-reload`, `sudo systemctl enable --now ygo-certbot.timer`, `sudo /opt/certbot/bin/certbot renew --dry-run` and `systemctl list-timers ygo-certbot.timer`. Test HTTPS from outside the instance. Review Certbot updates monthly, change both exact version pins and the versions recorded here in a reviewed PR, then rerun setup with the API units stopped and repeat the dry run. Never upgrade the venv to an unpinned version. #131 adds external health/crash-loop/log alarms. Until then, the owner checks service status and renewal timer failures manually.

## Package and verify a release

From the reviewed checkout, run `pnpm install --frozen-lockfile` then `pnpm --filter @ygo/server build`. Archive the **contents** of `apps/server/dist/`, including package.json, main.js, migrate.js, maps and migrations. Name the archive by its full Git SHA and record its SHA256. The same built artifact must reach staging and production. #133/#134 automate transfer and activation; no production release is activated by setup.

On the host, unpack into `/opt/ygo/<environment>/releases/<sha>`, root-owned and readable by that environment's service group. Load its SSM runtime configuration as described above. Before switching `current`, run migrations as `ygo-<environment>`, using the app database role; the host deploy script below performs this explicitly. Systemd reads the root-owned environment file before launching the unprivileged migration process. Never run migrate.js as root. Never apply migrations on API boot. Migrations must remain compatible with the previous release; rollback switches application files, never reverses SQL. #130 is the procedure for database recovery, with deletion replay required before reopening service.

After #134 wires the workflow, deployment sets `/opt/ygo/<environment>/current`, enables `ygo@<environment>` and verifies `/v1/healthz` locally and publicly. The unit restarts after five seconds, and stops after five rapid failures so monitoring can report the crash loop. Keep the last three successful releases, always protecting current/previous; cleanup happens only after successful health. Staging must pass on that exact commit before production. Until the remaining parts ship, use their tickets as prerequisites rather than improvising a live deployment.

Record in #35: resource IDs and region, no-SSH/private-RDS checks, PostGIS version, role isolation, TLS/renewal checks, setup/runtime versions and failures. Complete SES domain verification/DKIM and production-access request in Mumbai; do not put real users through email sign-in while SES is sandboxed. Run the first-Admin command only after #37 supplies it. The timed restore and its measured recovery time use #130's runbook after #92 supplies replay; never report either prerequisite as complete before it exists.

Sources: [AL2023 Node packages](https://docs.aws.amazon.com/linux/al2023/ug/nodejs.html), [GitHub OIDC environment trust](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws), [Certbot Nginx/pip installation](https://certbot.eff.org/instructions?os=pip&ws=nginx).

## Host deploy and rollback (#133)

Transfer the reviewed `ops/deploy.sh` beside the host setup script. The caller runs it as root through SSM; it downloads `s3://BUCKET/ENV/SHA.tar.gz`. The expected SHA256 must come from the trusted build/dispatch (#134), not just a checksum downloaded beside the archive. Environment is exactly staging or production; SHA is the full lowercase commit SHA. The public health URL is the environment's HTTPS `/v1/healthz`. #134 must enforce exact-commit staging eligibility before production is enabled.

```sh
sudo bash ops/deploy.sh deploy staging <sha> <bucket> <trusted-sha256> https://<staging-api>/v1/healthz
sudo bash ops/deploy.sh rollback staging <retained-successful-sha> https://<staging-api>/v1/healthz
```

One nonblocking host lock serializes both environments; a concurrent caller fails with a clear message. The script validates the archive digest, extracts with Python's data filter, and reads the environment's SecureString into a root-owned mode-0600 temporary file. HOST and PORT must be literal unquoted `127.0.0.1` and `3000` (staging) or `3001` (production). Neither file is sourced by a shell or printed. Existing SHA directories must match the same artifact digest.

Before activating a new release, it runs the equivalent of `systemd-run --wait --collect --service-type=exec --uid=ygo-<environment> --gid=ygo-<environment> -p EnvironmentFile=<root-owned-candidate-file> -p RuntimeMaxSec=600 /opt/ygo/node/bin/node <release>/migrate.js`. A migration failure/ten-minute timeout leaves the active service and configuration untouched; committed SQL is never reversed. After migration, configuration and current-release symlink are replaced atomically, the environment's unit is restarted and both local/public health must pass within sixty seconds.

Failed activation automatically restores the pre-deploy application and configuration and checks health again. If that recovery fails, the service is stopped. With no previous release, it is stopped/disabled and `current` is removed. Failed artifacts stay for investigation until a successful deployment cleans them up. Inspect `journalctl -u ygo@<environment>`; the command returns failure even if automatic recovery succeeds.

Explicit rollback requires a retained successful release, keeps current configuration (including secret rotations), skips migrations and checks health. On failure it attempts to restore the pre-rollback application/configuration. Keep migrations additive and compatible with retained application versions; database recovery belongs to #130.

Only after success, retain three successful releases per environment, always protecting current and previous; failed releases do not consume slots and are also removed during this cleanup. No cleanup runs after failed activation. The Linux CI harness uses the exact script, real packaged migrations/servers, separate Unix users and real PostGIS. AWS/systemd/public DNS are recorded substitutes; the readiness budget is shortened to four seconds in the harness. Live systemd/SSM/TLS behavior remains a #35 verification.
