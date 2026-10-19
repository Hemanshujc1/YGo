#!/usr/bin/env python3
"""Disposable Linux/root harness: real bundles, PostGIS and uids; recorded AWS/systemd/public-DNS substitutes."""
import fcntl
import json
import os
from pathlib import Path
import pwd
import shutil
import signal
import subprocess
import sys
import tarfile
import tempfile
from urllib.parse import urlsplit, urlunsplit


def command(*args, **kwargs):
    return subprocess.run(args, check=True, text=True, capture_output=True, **kwargs).stdout.strip()


def fake():
    state = Path(os.environ["YGO_TEST_STATE"])
    settings = json.loads((state / "settings").read_text())
    tool, args = Path(sys.argv[0]).name, sys.argv[1:]
    with (state / "calls").open("a") as log:
        log.write(json.dumps([tool, args]) + "\n")
    if tool == "aws":
        if "s3" in args:
            if settings.get("fail") == "artifact": sys.exit(1)
            shutil.copyfile(state / args[4].split("/")[-1], args[5])
            if settings.get("fail") == "checksum":
                with open(args[5], "ab") as artifact: artifact.write(b"corrupted")
        else:
            if settings.get("fail") == "secrets": sys.exit(1)
            environment = args[args.index("--name") + 1].split("/")[2]
            print((state / f"{environment}.env").read_text(), end="")
    elif tool == "systemd-run":
        user = next(a.split("=", 1)[1] for a in args if a.startswith("--uid="))
        assert "RuntimeMaxSec=600" in args and "--wait" in args and "--collect" in args
        assert f"--gid={user}" in args
        config = next(a.split("=", 1)[1] for a in args if a.startswith("EnvironmentFile="))
        assert Path(config).stat().st_mode & 0o777 == 0o600
        if settings.get("fail") == "migration": sys.exit(1)
        env = dict(os.environ, **dict(line.split("=", 1) for line in Path(config).read_text().splitlines()))
        start = args.index("/opt/ygo/node/bin/node")
        subprocess.run(args[start:], check=True, env=env, user=user, group=user, timeout=600)
    elif tool == "systemctl":
        assert args[0] in ["reset-failed", "enable", "restart", "disable"]
        environment = args[-1].split("@")[-1]
        pidfile = state / f"{environment}.pid"
        if args[0] in ["restart", "disable"]:
            if pidfile.exists():
                try: os.killpg(int(pidfile.read_text()), signal.SIGTERM)
                except ProcessLookupError: pass
                pidfile.unlink()
            if args[0] == "restart":
                if settings.get("fail") == "recovery" and Path(f"/opt/ygo/{environment}/current").resolve().name == settings["old"]:
                    sys.exit(1)
                env = dict(os.environ, **dict(line.split("=", 1) for line in Path(f"/etc/ygo/{environment}.env").read_text().splitlines()))
                with (state / "server.log").open("a") as output:
                    server = subprocess.Popen(["/opt/ygo/node/bin/node", f"/opt/ygo/{environment}/current/main.js"], env=env,
                                              user=f"ygo-{environment}", group=f"ygo-{environment}",
                                              stdout=output, stderr=output, start_new_session=True)
                pidfile.write_text(str(server.pid))
    elif tool == "curl":
        if args[-1].startswith("https:"):
            environment = args[-1].split("/")[2].split(".")[0]
            if Path(f"/opt/ygo/{environment}/current").resolve().name == settings.get("bad_health"):
                sys.exit(1)
            args[-1] = f"http://127.0.0.1:{3000 if environment == 'staging' else 3001}/v1/healthz"
        sys.exit(subprocess.run(["/usr/bin/curl", *args]).returncode)
    elif tool == "timeout":
        assert args[:2] == ["--kill-after=5", "60"]
        sys.exit(subprocess.run(["/usr/bin/timeout", "--kill-after=5", "4", *args[2:]]).returncode)


def main():
    assert os.geteuid() == 0 and sys.platform == "linux", "Use a disposable Linux host/container only"
    assert Path("/.dockerenv").is_file() or os.environ.get("GITHUB_ACTIONS") == "true", "Docker or GitHub Actions only"
    assert not Path("/opt/ygo").exists() and not Path("/etc/ygo").exists(), "Refusing existing YGo state"
    source = Path(__file__).resolve().parents[1]
    admin = os.environ["TEST_DATABASE_URL"]
    databases = []
    with tempfile.TemporaryDirectory(prefix="ygo-deploy-") as temporary:
        state = Path(temporary)
        settings = {}
        env = dict(os.environ, YGO_TEST_STATE=temporary, PATH=f"{temporary}:" + os.environ["PATH"])
        for tool in ["aws", "systemctl", "systemd-run", "curl", "timeout"]:
            (state / tool).symlink_to(Path(__file__).resolve())
        (state / "calls").touch()
        Path("/etc/ygo").mkdir(mode=0o755)
        Path("/opt/ygo/node/bin").mkdir(parents=True)
        Path("/opt/ygo/node/bin/node").symlink_to(shutil.which("node"))
        try:
            for environment in ["staging", "production"]:
                command("useradd", "--system", "--no-create-home", f"ygo-{environment}")
                (Path(f"/opt/ygo/{environment}") / "releases").mkdir(parents=True)
                database = f"ygo_deploy_{os.getpid()}_{environment}"
                command("psql", admin, "-c", f"CREATE DATABASE {database}")
                databases.append(database)
                url = urlsplit(admin)
                url = urlunsplit((url.scheme, url.netloc, "/" + database, url.query, ""))
                port = 3000 if environment == "staging" else 3001
                (state / f"{environment}.env").write_text(f"DATABASE_URL={url}\nHOST=127.0.0.1\nPORT={port}\nLOG_LEVEL=info\nREVISION=initial\n")
            def invoke(sha, mode="deploy", environment="staging", fail=False):
                (state / "settings").write_text(json.dumps(settings))
                args = ["bash", str(source / "ops/deploy.sh"), mode, environment, sha]
                if mode == "deploy": args += ["test-bucket", command("sha256sum", str(state / f"{sha}.tar.gz")).split()[0]]
                args += [f"https://{environment}.example.invalid/v1/healthz"]
                result = subprocess.run(args, env=env, text=True, capture_output=True)
                assert (result.returncode != 0) == fail, result.stdout + result.stderr
                return result.stderr
            def artifact(number, additive=False):
                sha = f"{number:040x}"
                bundle = state / "bundle"
                shutil.copytree(source / "apps/server/dist", bundle)
                uids = {str(port): pwd.getpwnam(f"ygo-{environment}").pw_uid for port, environment in [(3000, "staging"), (3001, "production")]}
                migrate = bundle / "migrate.js"
                migrate.write_text(f"if (process.getuid() !== ({json.dumps(uids)})[process.env.PORT]) throw Error('wrong migration uid');\n" + migrate.read_text())
                if additive:
                    journal = bundle / "migrations/meta/_journal.json"
                    data = json.loads(journal.read_text())
                    data["entries"].append(dict(idx=1, version="7", when=data["entries"][-1]["when"] + 1, tag="0001_probe", breakpoints=True))
                    journal.write_text(json.dumps(data))
                    (bundle / "migrations/0001_probe.sql").write_text("CREATE TABLE deployment_probe (id integer); INSERT INTO deployment_probe VALUES (133);")
                with tarfile.open(state / f"{sha}.tar.gz", "w:gz") as archive:
                    for file in bundle.iterdir(): archive.add(file, arcname=file.name)
                shutil.rmtree(bundle)
                return sha
            a, b, c, d, failed = artifact(1), artifact(2, True), artifact(3, True), artifact(4, True), artifact(5, True)
            settings["bad_health"] = a
            assert "First deployment failed" in invoke(a, fail=True)
            assert not Path("/opt/ygo/staging/current").exists() and not (state / "staging.pid").exists()
            settings.clear()
            invoke(a)
            original = Path("/etc/ygo/staging.env").read_text()
            invoke(a)
            invoke(a, environment="production")
            production = Path("/opt/ygo/production/current").resolve()
            for failure in ["artifact", "checksum", "secrets", "migration"]:
                settings["fail"] = failure
                invoke(b, fail=True)
                assert Path("/opt/ygo/staging/current").resolve().name == a
                assert Path("/etc/ygo/staging.env").read_text() == original
            settings.clear()
            calls_before = (state / "calls").read_text().count('"systemd-run"')
            running = (state / "staging.pid").read_text()
            for override in ["HOST=0.0.0.0", " PORT =3001"]:
                (state / "staging.env").write_text(original + override + "\n")
                assert "assigned loopback host/port" in invoke(b, fail=True)
                assert Path("/etc/ygo/staging.env").read_text() == original
                assert (state / "staging.pid").read_text() == running
            assert (state / "calls").read_text().count('"systemd-run"') == calls_before
            settings["bad_health"] = b
            (state / "staging.env").write_text(original.replace("initial", "rotated"))
            assert "previous application is healthy" in invoke(b, fail=True)
            assert Path("/etc/ygo/staging.env").read_text() == original
            settings.clear()
            invoke(b)
            calls_before = (state / "calls").read_text().count('"systemd-run"')
            invoke(a, mode="rollback")
            assert "rotated" in Path("/etc/ygo/staging.env").read_text()
            assert (state / "calls").read_text().count('"systemd-run"') == calls_before
            url = dict(line.split("=", 1) for line in (state / "staging.env").read_text().splitlines())["DATABASE_URL"]
            assert command("psql", url, "-Atc", "SELECT id FROM deployment_probe") == "133"
            assert Path("/opt/ygo/staging/current").resolve().name == a
            settings.update(bad_health=failed, fail="recovery", old=a)
            assert "Recovery failed" in invoke(failed, fail=True)
            assert not (state / "staging.pid").exists()
            assert Path(f"/opt/ygo/staging/releases/{failed}").exists()
            settings.clear()
            with open("/run/lock/ygo-deploy.lock", "w") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                assert "host lock" in invoke(c, fail=True)
            invoke(c)
            invoke(d)
            releases = {p.name for p in Path("/opt/ygo/staging/releases").iterdir()}
            assert len(releases) == 3 and failed not in releases and a in releases and d in releases
            assert Path("/opt/ygo/staging/previous").resolve().name == c
            assert Path("/opt/ygo/production/current").resolve() == production
            print("PASS: real migration uid, deploy/retry/isolation, failure recovery, additive-schema rollback, lock, retention")
        finally:
            for pidfile in state.glob("*.pid"):
                try: os.killpg(int(pidfile.read_text()), signal.SIGTERM)
                except ProcessLookupError: pass
            for database in databases:
                command("psql", admin, "-c", f"DROP DATABASE {database} WITH (FORCE)")
            # Host paths/users belong to the disposable runner/container and are never deleted here.


if Path(sys.argv[0]).name in ["aws", "systemctl", "systemd-run", "curl", "timeout"]:
    fake()
else:
    main()
