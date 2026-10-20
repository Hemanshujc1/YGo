#!/usr/bin/env python3
"""Disposable Linux/root rehearsal of the exact host restore script and real PostGIS."""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import urlsplit, urlunsplit
from uuid import uuid4

def cmd(*args, **kwargs):
    result = subprocess.run(args, text=True, capture_output=True, **kwargs)
    if result.returncode:
        raise RuntimeError(f'{args[0]} failed: {result.stderr}')
    return result.stdout.strip()

def fake():
    state = Path(os.environ['YGO_RESTORE_TEST'])
    tool, args = Path(sys.argv[0]).name, sys.argv[1:]
    if tool == 'aws':
        if 's3api' in args:
            rule = '{"Rules":[{"Status":"Enabled","Filter":{"Prefix":"nightly/"},"Expiration":{"Days":30}'
            if (state / 'early-transition').exists(): rule += ',"Transitions":[{"Days":1,"StorageClass":"GLACIER"}]'
            print('None' if 'get-bucket-versioning' in args else rule + '}]}')
        else:
            source, dest = args[4:6]
            stored = state / Path(source).name if source.startswith('s3://') else Path(source)
            target = state / Path(dest).name if dest.startswith('s3://') else Path(dest)
            shutil.copyfile(stored, target)
            if (state / 'corrupt-download').exists() and target.name == 'verify.dump':
                with target.open('ab') as output: output.write(b'corrupt')
    elif tool == 'systemctl':
        (state / 'service').write_text('on' if args[0] == 'enable' else 'off')
    elif tool == 'timeout':
        sys.exit(1 if (state / 'fail-health').exists() else 0)
    else:
        if (state / 'fail-restore').exists() and 'pg_restore --exit-on-error' in ' '.join(args):
            sys.exit(1)
        if (state / 'fail-verify').exists() and 'information_schema.tables' in ' '.join(args):
            sys.exit(1)
        config = next(a.split('=', 1)[1] for a in args if a.startswith('EnvironmentFile='))
        line = next(s for s in Path(config).read_text().splitlines() if s.startswith('DATABASE_URL='))
        env = dict(os.environ, DATABASE_URL=line.split('=', 1)[1])
        start = args.index('/usr/bin/bash') if '/usr/bin/bash' in args else args.index('/opt/ygo/node/bin/node')
        result = subprocess.run(args[start:], env=env)
        sys.exit(result.returncode)

def main():
    assert os.geteuid() == 0 and sys.platform == 'linux'
    assert Path('/.dockerenv').exists() or os.environ.get('GITHUB_ACTIONS') == 'true'
    assert not Path('/etc/ygo').exists() and not Path('/opt/ygo').exists(), 'Refusing existing YGo state'
    source = Path(__file__).resolve().parents[1]
    admin = os.environ['TEST_DATABASE_URL']
    names = [f'ygo_restore_{uuid4().hex}_{suffix}' for suffix in ('source', 'old')]
    with tempfile.TemporaryDirectory(prefix='ygo-restore-') as temporary:
        state = Path(temporary)
        for tool in ('aws', 'systemctl', 'systemd-run', 'timeout'):
            (state / tool).symlink_to(Path(__file__).resolve())
        env = dict(os.environ, YGO_RESTORE_TEST=temporary, PATH=f'{temporary}:' + os.environ['PATH'])
        def url(name):
            parsed = urlsplit(admin)
            return urlunsplit((parsed.scheme, parsed.netloc, '/' + name, parsed.query, ''))
        try:
            for name in names: cmd('psql', admin, '-c', f'CREATE DATABASE {name}')
            cmd('psql', url(names[0]), '-c', 'CREATE EXTENSION postgis; CREATE TABLE recovery_probe (id integer); INSERT INTO recovery_probe VALUES (130)')
            cmd('pg_dump', '-Fc', '-f', str(state / 'good.dump'), url(names[0]))
            digest = cmd('sha256sum', str(state / 'good.dump')).split()[0]
            (state / 'good.sha256').write_text(digest + '  good.dump\n')
            Path('/etc/ygo').mkdir()
            Path('/opt/ygo/production/current').mkdir(parents=True)
            Path('/opt/ygo/node/bin').mkdir(parents=True)
            Path('/opt/ygo/node/bin/node').symlink_to(shutil.which('node'))
            original = f'DATABASE_URL={url(names[1])}\nPORT=3001\n'
            Path('/etc/ygo/production.env').write_text(original)
            Path('/etc/ygo/production.env').write_text(f'DATABASE_URL={url(names[0])}\n')
            backup = subprocess.run(['bash', str(source / 'ops/backup.sh'), 'dump', 'test-bucket'], env=env, text=True, capture_output=True)
            assert backup.returncode == 0, backup.stdout + backup.stderr
            (state / 'early-transition').touch()
            backup = subprocess.run(['bash', str(source / 'ops/backup.sh'), 'dump', 'test-bucket'], env=env, text=True, capture_output=True)
            assert backup.returncode != 0 and 'earlier actions' in backup.stderr
            (state / 'early-transition').unlink()
            (state / 'corrupt-download').touch()
            backup = subprocess.run(['bash', str(source / 'ops/backup.sh'), 'dump', 'test-bucket'], env=env, text=True, capture_output=True)
            assert backup.returncode != 0 and 'mismatch' in backup.stderr
            (state / 'corrupt-download').unlink()
            Path('/etc/ygo/production.env').write_text(original)
            (state / 'service').write_text('on')
            replay = Path('/opt/ygo/production/current/replay-deletions.js')
            def attempt(kind, replay_code=None, archive='good.dump', checksum='good.sha256'):
                target = f'ygo_restore_{uuid4().hex}'
                names.append(target)
                cmd('psql', admin, '-c', f'CREATE DATABASE {target}')
                if kind == 'occupied target': cmd('psql', url(target), '-c', 'CREATE TABLE occupied (id integer)')
                recovery = state / 'recovery.env'
                recovery.write_text(f'DATABASE_URL={url(target)}\nPORT=3001\n')
                recovery.chmod(0o600)
                if replay_code is None: replay.unlink(missing_ok=True)
                else: replay.write_text(replay_code)
                (state / 'service').write_text('on')
                result = subprocess.run(['bash', str(source / 'ops/restore.sh'), str(state / archive), str(state / checksum), str(recovery)], env=env, text=True, capture_output=True)
                assert result.returncode != 0, (kind, result.stdout, result.stderr)
                assert (state / 'service').read_text() == 'off', (kind, result.stdout, result.stderr)
                assert Path('/etc/ygo/production.env').read_text() == original, kind
                assert cmd('psql', url(names[1]), '-Atc', 'SELECT current_database()') == names[1]
                return result.stderr
            assert '#92' in attempt('missing replay')
            assert 'not empty' in attempt('occupied target', 'process.exit(0)')
            (state / 'recovery.env').write_text(original)
            rejected = subprocess.run(['bash', str(source / 'ops/restore.sh'), str(state / 'good.dump'), str(state / 'good.sha256'), str(state / 'recovery.env')], env=env, text=True, capture_output=True)
            assert rejected.returncode != 0 and 'matches production' in rejected.stderr
            assert (state / 'service').read_text() == 'off' and Path('/etc/ygo/production.env').read_text() == original
            (state / 'bad.sha256').write_text('0'*64 + '  good.dump\n')
            assert 'SHA256 mismatch' in attempt('verification failure', 'process.exit(0)', checksum='bad.sha256')
            (state / 'broken.dump').write_bytes(b'not a pg archive')
            (state / 'broken.sha256').write_text(cmd('sha256sum', str(state / 'broken.dump')).split()[0] + '  broken.dump\n')
            assert 'Archive verification failed' in attempt('archive failure', 'process.exit(0)', 'broken.dump', 'broken.sha256')
            (state / 'fail-restore').touch()
            assert 'Restore failed' in attempt('restore failure', 'process.exit(0)')
            (state / 'fail-restore').unlink()
            (state / 'fail-verify').touch()
            assert 'Cannot verify restored database' in attempt('post-restore verification failure', 'process.exit(0)')
            (state / 'fail-verify').unlink()
            assert 'Deletion replay failed' in attempt('replay failure', 'process.exit(1)')
            (state / 'fail-health').touch()
            assert 'failed health check' in attempt('health failure', 'process.exit(0)')
            (state / 'fail-health').unlink()
            replay.write_text('process.exit(0)')
            target = f'ygo_restore_{uuid4().hex}'
            names.append(target)
            cmd('psql', admin, '-c', f'CREATE DATABASE {target}')
            recovery = state / 'recovery.env'
            recovery.write_text(f'DATABASE_URL={url(target)}\nPORT=3001\n')
            recovery.chmod(0o600)
            started = time.monotonic()
            result = subprocess.run(['bash', str(source / 'ops/restore.sh'), str(state / 'good.dump'), str(state / 'good.sha256'), str(recovery)], env=env, text=True, capture_output=True)
            elapsed = time.monotonic() - started
            assert result.returncode == 0, result.stdout + result.stderr
            assert (state / 'service').read_text() == 'on'
            assert cmd('psql', url(target), '-Atc', 'SELECT id FROM recovery_probe') == '130'
            print(f'PASS: exact backup/restore, data, failure paths; recovery elapsed {elapsed:.2f}s')
        finally:
            for name in names: cmd('psql', admin, '-c', f'DROP DATABASE {name} WITH (FORCE)')
            if Path('/etc/ygo').exists(): shutil.rmtree('/etc/ygo')
            if Path('/opt/ygo').exists(): shutil.rmtree('/opt/ygo')

if Path(sys.argv[0]).name in ('aws', 'systemctl', 'systemd-run', 'timeout'): fake()
else: main()
