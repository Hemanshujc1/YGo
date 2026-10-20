#!/usr/bin/env python3
"""Replay observed host command shapes through AL2023's real systemd-run parser."""
import json
from pathlib import Path
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
print(f'PASS: {len(calls)} backup/restore invocations accepted by {version}')
