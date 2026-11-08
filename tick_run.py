"""pb-serverless-tick runner. Pulls the vault surrogate and runs the tgcloud CLI.

DO NOT run tgcloud through `npx` (env-passed TGCLOUD_TOKEN never reaches it) and
do NOT pass --ctx through a shell or as a file path. argv is passed literally,
with the full inherited environment plus TGCLOUD_TOKEN/TGCLOUD_APP_ID.

RETRY (tick-hardening wave, 2026-11-07): the tgcloud `run` endpoint flakes with
burst 429s ("Too many requests: retry after N") and HTTP 500 non-JSON responses
(~12% of tick runs failed outright in 24h). A failed invocation is retried up
to 3 attempts total, honoring the platform's own retry-after (capped at 15s;
5s for 500/timeout) — bounded, server-directed, then it stops and exits with
the last failure exactly as a single-attempt failure would. The CLI's output
is printed through on every attempt so the cron worker's log capture, the
full-output file, and the cycles-summary check see the same bytes as a direct
invocation.
"""
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

MAX_ATTEMPTS = 3
ATTEMPT_TIMEOUT = 45  # seconds; a healthy tick returns in <=~40s (isolate kills at ~33s)
TAG = "tick-retry"


def _retry_wait_seconds(combined):
    m = re.search(r"retry after (\d+)", combined or "", re.IGNORECASE)
    if m:
        return min(int(m.group(1)), 15)
    return 5


def _is_retryable(combined):
    text = combined or ""
    return (
        "Too many requests" in text
        or "HTTP 500" in text
        or "Invalid response from server" in text
        or "not JSON" in text
        or "timed out after" in text
    )


def run_with_retry(argv, env):
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            proc = subprocess.run(
                argv, env=env, capture_output=True, text=True, timeout=ATTEMPT_TIMEOUT
            )
            rc, out, err = proc.returncode, proc.stdout or "", proc.stderr or ""
        except subprocess.TimeoutExpired as exc:
            rc = 124
            out = exc.stdout or ""
            err = (exc.stderr or "") + f"\n[{TAG}] attempt timed out after {ATTEMPT_TIMEOUT}s\n"
        sys.stdout.write(out)
        sys.stdout.flush()
        sys.stderr.write(err)
        sys.stderr.flush()
        if rc == 0:
            return 0
        combined = out + err
        if attempt < MAX_ATTEMPTS and _is_retryable(combined):
            wait = _retry_wait_seconds(combined)
            print(
                f"[{TAG}] attempt {attempt}/{MAX_ATTEMPTS} failed; retrying in {wait}s",
                file=sys.stderr,
            )
            time.sleep(wait)
            continue
        return rc
    return 1


entry = dynamic_credential_entry("custom.telegram-serverless")

env = dict(os.environ)
env["TGCLOUD_TOKEN"] = entry["surrogate"]
env["TGCLOUD_APP_ID"] = "app8667050062"

os.chdir(os.path.expanduser("~/workspace/poorboyai-serverless-build/PoorBoyAI_bot"))

ctx = '{"initData":{"user":{"id":8429146850}}}'
sys.exit(
    run_with_retry(
        ["node", "node_modules/@tgcloud/cli/bin/tgcloud.js",
         "run", "endpoints/tick", "{}", "--ctx", ctx],
        env,
    )
)
