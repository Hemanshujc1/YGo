"""Run exact Actions orchestration with recorded AWS calls; no cloud access."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
import dispatch

SHA = subprocess.check_output(["git", "rev-parse", "origin/main"], text=True).strip()


class Promotion(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        archive = Path(self.directory.name) / "release.tar.gz"
        archive.write_bytes(b"packaged staging release")
        self.objects, self.calls = {}, []
        self.responses = [dict(Status="Success", ResponseCode=0)]
        settings = dict(GITHUB_REF="refs/heads/main", DEPLOY_BUCKET="test-bucket",
                        DEPLOY_INSTANCE_ID="i-test", DEPLOY_DOCUMENT="YGo-staging", RELEASE_ARCHIVE=str(archive))
        for mock in (patch.dict(os.environ, settings), patch.object(dispatch, "aws", self.aws),
                     patch.object(dispatch.time, "sleep")):
            mock.start()
            self.addCleanup(mock.stop)

    def aws(self, *args):
        self.calls.append(args)
        if args[0] == "s3api":
            key = args[args.index("--key") + 1]
            if args[1] == "get-object":
                if key not in self.objects:
                    raise RuntimeError("NoSuchKey")
                Path(args[-1]).write_bytes(self.objects[key])
            else:
                if "--if-none-match" in args and key in self.objects:
                    raise RuntimeError("PreconditionFailed")
                self.objects[key] = Path(args[args.index("--body") + 1]).read_bytes()
            return {}
        if args[1] == "send-command":
            self.assertEqual(args[args.index("--document-version") + 1], "1")
            if os.environ["DEPLOY_DOCUMENT"] == "YGo-staging":
                self.assertNotIn(f"staging/{SHA}.json", self.objects)
            return {"Command": {"CommandId": "command-133"}}
        response = self.responses.pop(0) if len(self.responses) > 1 else self.responses[0]
        if isinstance(response, Exception):
            raise response
        return response

    def stage(self):
        dispatch.deploy("staging", SHA)
        os.environ["DEPLOY_DOCUMENT"] = "YGo-production"
        self.calls.clear()

    def test_promote_exact_bytes_and_retry_immutable_artifact(self):
        self.stage()
        evidence = json.loads(self.objects[f"staging/{SHA}.json"])
        self.assertEqual(evidence["sha256"], hashlib.sha256(self.objects[f"staging/{SHA}.tar.gz"]).hexdigest())
        dispatch.deploy("production", SHA)
        self.assertEqual(self.objects[f"production/{SHA}.tar.gz"], self.objects[f"staging/{SHA}.tar.gz"])
        del self.objects[f"staging/{SHA}.json"]
        os.environ["DEPLOY_DOCUMENT"] = "YGo-staging"
        Path(os.environ["RELEASE_ARCHIVE"]).write_bytes(b"different rebuild")
        dispatch.deploy("staging", SHA)
        self.assertEqual(self.objects[f"staging/{SHA}.tar.gz"], b"packaged staging release")

    def test_production_refusals_leave_production_untouched(self):
        for reason in ("never-staged", "failed-staging", "failed-health", "wrong-sha", "tampered"):
            with self.subTest(reason=reason):
                self.objects = {"production/existing.tar.gz": b"active"}
                if reason != "never-staged":
                    self.objects[f"staging/{SHA}.tar.gz"] = b"candidate"
                if reason in ("failed-health", "wrong-sha", "tampered"):
                    self.objects[f"staging/{SHA}.json"] = json.dumps(dict(
                        sha="f" * 40 if reason == "wrong-sha" else SHA,
                        healthy=reason != "failed-health", sha256="0" * 64)).encode()
                before = dict(self.objects)
                self.calls.clear()
                with self.assertRaisesRegex(RuntimeError, "Production refused"):
                    dispatch.deploy("production", SHA)
                self.assertEqual(self.objects, before)
                self.assertFalse(any(call[0] == "ssm" or call[1] == "put-object" for call in self.calls))

    def test_ssm_failures_never_publish_success(self):
        for response in (dict(Status="Failed", ResponseCode=1), dict(Status="TimedOut", ResponseCode=-1),
                         dict(Status="Cancelled", ResponseCode=-1), dict(Status="Success", ResponseCode=1),
                         RuntimeError("AccessDenied"), dict(Status="InProgress", ResponseCode=-1)):
            with self.subTest(response=response):
                self.responses = [response]
                with self.assertRaises(RuntimeError):
                    dispatch.deploy("staging", SHA)
                self.assertNotIn(f"staging/{SHA}.json", self.objects)

    def test_eventual_consistency_and_progress(self):
        self.responses = [RuntimeError("InvocationDoesNotExist"), dict(Status="InProgress", ResponseCode=-1),
                          dict(Status="Success", ResponseCode=0)]
        self.stage()

    def test_cli_host_failure_returns_nonzero_to_actions(self):
        executable = Path(self.directory.name) / "aws"
        executable.write_text("""#!/usr/bin/env python3
import json, sys
from pathlib import Path
if 'get-object' in sys.argv: Path(sys.argv[-3]).write_bytes(b'release')
if 'get-command-invocation' in sys.argv:
    print(json.dumps(dict(Status='Failed', ResponseCode=1)))
elif 'send-command' in sys.argv:
    print(json.dumps(dict(Command=dict(CommandId='failed-host'))))
else: print('{}')
""")
        executable.chmod(0o700)
        result = subprocess.run([sys.executable, str(Path(dispatch.__file__)), "staging", SHA],
                                env={**os.environ, "PATH": f"{self.directory.name}:{os.environ['PATH']}"},
                                capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Host deployment failed: SSM Failed; exit 1", result.stderr)

    def test_dispatch_validation_precedes_aws(self):
        for ref, sha in (("refs/heads/134-oidc-deploy", SHA), ("refs/heads/main", "main"),
                         ("refs/heads/main", "f" * 40)):
            with patch.dict(os.environ, GITHUB_REF=ref), self.assertRaises((RuntimeError, subprocess.CalledProcessError)):
                dispatch.deploy("production", sha)
        self.assertEqual(self.calls, [])


if __name__ == "__main__":
    unittest.main()
