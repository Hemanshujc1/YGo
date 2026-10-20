#!/usr/bin/env python3
"""Check host commands and job units with AL2023's real systemd parser."""
import json
from pathlib import Path
import shutil
import subprocess
import sys

version = subprocess.check_output(['systemd-run', '--version'], text=True).splitlines()[0]
assert version.startswith('systemd 252 '), version
calls = [json.loads(line) for line in Path(sys.argv[1]).read_text().splitlines()]
assert any('_dump' in call for call in calls), 'backup invocation missing'
assert any('_db' in call for call in calls), 'restore invocation missing'
assert any('replay-deletions.js' in ' '.join(call) for call in calls), 'replay invocation missing'
# The parser checks that direct executables exist before attempting the bus.
Path('/opt/ygo/node/bin').mkdir(parents=True, exist_ok=True)
Path('/opt/ygo/node/bin/node').symlink_to('/usr/bin/true')
for args in calls:
    result = subprocess.run(['systemd-run', *args], text=True, capture_output=True)
    # No systemd PID 1 exists in this disposable container. Parsing must succeed
    # and reach the bus connection; an unknown option fails before that point.
    assert result.returncode != 0 and 'Failed to connect to bus' in result.stderr, (args, result.stderr)

# Verify the actual timer/service templates and instance overrides with AL2023 systemd.
units = [
    'ygo-job@.service', 'ygo-job@.timer',
    'ygo-job-check.service', 'ygo-job-check.timer',
]
for name in units:
    shutil.copy2(Path('/ops') / name, Path('/etc/systemd/system') / name)
for name in ('ygo-job@backup-nightly.service.d', 'ygo-job@backup-nightly.timer.d',
             'ygo-job@cleanup-sessions.timer.d'):
    shutil.copytree(Path('/ops') / name, Path('/etc/systemd/system') / name, dirs_exist_ok=True)
Path('/opt/ygo/production/current').mkdir(parents=True, exist_ok=True)
subprocess.run([
    'systemd-analyze', 'verify',
    'ygo-job@backup-nightly.service', 'ygo-job@backup-nightly.timer',
    'ygo-job@cleanup-sessions.service', 'ygo-job@cleanup-sessions.timer',
    'ygo-job-check.service', 'ygo-job-check.timer',
], check=True)
print(f'PASS: {len(calls)} backup/restore invocations and six job units accepted by {version}')
