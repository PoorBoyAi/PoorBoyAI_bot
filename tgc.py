"""tgc.py — tgcloud CLI runner, workspace-durable (/tmp was wiped 2026-10-25).

Usage: python3 tgc.py <cli args...>   (e.g. push, fetch, diff)
Same rules as tick_run.py: direct node CLI (never npx — the env-passed
token never reaches the CLI through npx), full inherited environment,
surrogate via dynamic_credential_entry. For tick runs use tick_run.py
(it hardcodes --ctx as a literal argv element); push/fetch/diff take
no --ctx.
"""
import os
import sys

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import dynamic_credential_entry  # noqa: E402

entry = dynamic_credential_entry("custom.telegram-serverless")

env = dict(os.environ)
env["TGCLOUD_TOKEN"] = entry["surrogate"]
env["TGCLOUD_APP_ID"] = "app8667050062"

os.chdir(os.path.expanduser("~/workspace/poorboyai-serverless-build/PoorBoyAI_bot"))

os.execvpe(
    "node",
    ["node", "node_modules/@tgcloud/cli/bin/tgcloud.js", *sys.argv[1:]],
    env,
)
