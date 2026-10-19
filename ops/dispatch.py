#!/usr/bin/env python3
"""Actions orchestration; the instance executes the unchanged ops/deploy.sh."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time


def validate(sha):
    if os.environ.get("GITHUB_REF") != "refs/heads/main":
        raise RuntimeError("Dispatch must run from main")
    if not re.fullmatch(r"[a-f0-9]{40}", sha):
        raise RuntimeError("Supply a full lowercase commit SHA")
    if subprocess.run(["git", "merge-base", "--is-ancestor", sha, "origin/main"], capture_output=True).returncode:
        raise RuntimeError("Candidate commit must exist on main")


def aws(*args):
    result = subprocess.run(["aws", "--region", "ap-south-1", *args, "--output", "json"],
                            capture_output=True, text=True)
    if result.returncode:
        raise RuntimeError(result.stderr.strip())
    return json.loads(result.stdout or "{}")


def deploy(environment, sha):
    validate(sha)
    if environment not in ("staging", "production"):
        raise RuntimeError("Choose staging or production")
    bucket, instance, document = [os.environ[name] for name in
                                 ("DEPLOY_BUCKET", "DEPLOY_INSTANCE_ID", "DEPLOY_DOCUMENT")]
    with tempfile.TemporaryDirectory() as temporary:
        archive, proof = [Path(temporary) / name for name in ("release.tar.gz", "success.json")]
        def get(key, destination):
            return aws("s3api", "get-object", "--bucket", bucket, "--key", key, str(destination))
        def put(key, source, *options):
            return aws("s3api", "put-object", "--bucket", bucket, "--key", key,
                       "--body", str(source), *options)
        artifact_key, proof_key = f"staging/{sha}.tar.gz", f"staging/{sha}.json"
        if environment == "staging":
            # Never overwrite an artifact already associated with this commit.
            try:
                put(artifact_key, Path(os.environ["RELEASE_ARCHIVE"]), "--if-none-match", "*")
            except RuntimeError as error:
                if "PreconditionFailed" not in str(error):
                    raise
            get(artifact_key, archive)
        else:
            try:
                get(proof_key, proof)
                evidence = json.loads(proof.read_text())
                if not isinstance(evidence, dict) or evidence.get("sha") != sha or evidence.get("healthy") is not True:
                    raise ValueError("No successful staging health for this SHA")
                get(artifact_key, archive)
                if hashlib.sha256(archive.read_bytes()).hexdigest() != evidence.get("sha256"):
                    raise ValueError("Staged artifact checksum does not match success evidence")
            except (RuntimeError, ValueError) as error:
                raise RuntimeError(f"Production refused: exact commit must deploy and pass staging health: {error}") from error
        digest = hashlib.sha256(archive.read_bytes()).hexdigest()
        if environment == "production":
            put(f"production/{sha}.tar.gz", archive)
        command = aws("ssm", "send-command", "--instance-ids", instance, "--document-name", document,
                      "--document-version", "1", "--timeout-seconds", "60", "--parameters",
                      json.dumps({"SHA": [sha], "Digest": [digest]}))["Command"]["CommandId"]
        for _ in range(216):  # Covers delivery + 900s execution, unlike the 100s CLI waiter.
            time.sleep(5)
            try:
                result = aws("ssm", "get-command-invocation", "--command-id", command, "--instance-id", instance)
            except RuntimeError as error:
                if "InvocationDoesNotExist" in str(error):
                    continue
                raise
            status = result["Status"]
            if status in ("Pending", "InProgress", "Delayed", "Cancelling"):
                continue
            if status != "Success" or result["ResponseCode"] != 0:
                raise RuntimeError(f"Host deployment failed: SSM {status}; exit {result['ResponseCode']}")
            if environment == "staging":
                proof.write_text(json.dumps({"sha": sha, "sha256": digest, "healthy": True, "command": command}))
                put(proof_key, proof)
            print(f"Healthy {environment} {sha}; SSM command {command}")
            return
        raise RuntimeError(f"SSM deployment timed out; inspect command {command} before retrying")


if __name__ == "__main__":
    try:
        if sys.argv[1] == "validate":
            validate(sys.argv[2])
        else:
            deploy(sys.argv[1], sys.argv[2])
    except (RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
