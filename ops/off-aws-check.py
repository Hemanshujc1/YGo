#!/usr/bin/env python3
"""Report whether the last verified removable-drive copy is at most 30 days old."""
import datetime as dt
import re
import subprocess
import sys

REGION = "ap-south-1"
PARAMETER = "/ygo/ops/off-aws-verified-at"


def healthy(value: str, now: dt.datetime) -> bool:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
        return False
    try:
        verified = dt.datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    except ValueError:
        return False
    age = now - verified
    return dt.timedelta(0) <= age <= dt.timedelta(days=30)


def run() -> int:
    try:
        result = subprocess.run(
            ["aws", "ssm", "get-parameter", "--region", REGION, "--name", PARAMETER,
             "--query", "Parameter.Value", "--output", "text"],
            check=True, capture_output=True, text=True,
        )
        ok = healthy(result.stdout.strip(), dt.datetime.now(dt.timezone.utc))
    except (OSError, subprocess.CalledProcessError):
        ok = False
    try:
        subprocess.run(
            ["aws", "cloudwatch", "put-metric-data", "--region", REGION,
             "--namespace", "YGo", "--metric-name", "OffAwsCopyHealthy",
             "--value", "1" if ok else "0", "--unit", "Count"],
            check=True, capture_output=True, text=True,
        )
    except (OSError, subprocess.CalledProcessError):
        print("Could not publish off-AWS copy status; the missing-data alarm must fire", file=sys.stderr)
        return 1
    if not ok:
        print("Off-AWS copy unhealthy: verification date missing, invalid, future, or older than 30 days", file=sys.stderr)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(run())
