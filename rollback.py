"""rollback.py — deploy auto-rollback driver (host-side, NOT a tgcloud module).

Invoked ONLY by the pb-serverless-tick cron body when the tick classifier
reports trigger=rollback (2 consecutive module-load tick failures), or
manually by the parent agent. NEVER run on a schedule by itself.

Steps:
  1. Refuse if a rollback is already marked in-progress in the manifest.
  2. Pick the newest *-pre-push-*.tgz (fallback *-pre-backup-*.tgz) in the
     bot dir. Rollback-victim tars are never candidates.
  3. Tar-backup the CURRENT tgcloud/ tree to rollback-victim-<ts>.tgz, so
     a mid-wave wave's unpushed work is never lost.
  4. Restore the chosen tar over tgcloud/ (entries peeked first: every
     entry must sit under tgcloud/).
  5. Load-check the restored tree (node --check over every tgcloud .js
     file). On failure: restore the victim backup, exit 1, NO push.
  6. Push via tgc.py. On failure: exit 2 (victim backup retained; the
     tree is left as restored and the manifest records it — a human
     wave decides next, never a second auto-attempt).
  7. Diff via tgc.py diff: must report no changes.
  8. Verify via tick_run.py: output must contain a cycles summary (ranAt).
     On failure: exit 3 (pushed but unverified — the page carries it;
     NO second auto-attempt: one rollback per episode).
  9. Append the rollback record to deployhealth-manifest.json, clear the
     in-progress marker, print JSON {restoredTar, pushed, tickClean}.

Safety: restores tgcloud/ ONLY. The Mini App dist/ build is untouched (it
is not part of the module graph that causes tick load failures; a Mini
App mismatch after a rollback is a manual-wave matter, recorded in the
receipt). The driver never pages by itself — the cron body pages once
from the driver's exit code + JSON. The cron body must also NOT re-fire
the driver after a failed rollback until a clean tick: see the cron
delta's rollbackBlocked flag (parent-applied, not here).
"""

import glob
import json
import os
import shutil
import subprocess
import sys
import tarfile
import time

BOT_DIR = os.path.expanduser("~/workspace/poorboyai-serverless-build/PoorBoyAI_bot")
MANIFEST = os.path.join(BOT_DIR, "deployhealth-manifest.json")


def run(cmd, timeout=300):
    """Run cmd in BOT_DIR, return (exit, stdout+stderr truncated)."""
    try:
        p = subprocess.run(cmd, cwd=BOT_DIR, capture_output=True, text=True, timeout=timeout)
        return p.returncode, (p.stdout + p.stderr)[-4000:]
    except subprocess.TimeoutExpired:
        return 124, "timeout after %ss: %s" % (timeout, " ".join(cmd))


def set_rollback_marker():
    """Best-effort: set bot config pb_outage_rollback_pending='1' via a
    run-only temp endpoint (deleted after use). The tick's outage hook
    consumes this marker on the first full successful tick after the
    episode and posts ONE combined recovery note. Never raises: a marker
    failure must not block the rollback itself."""
    tmp = os.path.join(BOT_DIR, "tgcloud", "endpoints", "tmpRollbackMark.js")
    try:
        with open(tmp, "w") as f:
            f.write("import { setConfig } from '../lib/config.js';\n"
                    "export default async function () {\n"
                    "  await setConfig('pb_outage_rollback_pending', '1');\n"
                    "  return { ok: true };\n"
                    "}\n")
        code, out = run([sys.executable, "run_endpoint.py", "endpoints/tmpRollbackMark"], timeout=120)
        if code != 0:
            print("rollback marker set failed (best-effort): %s" % out[-300:], file=sys.stderr)
        return code == 0
    except Exception as e:
        print("rollback marker set failed (best-effort): %s" % e, file=sys.stderr)
        return False
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def load_manifest():
    try:
        with open(MANIFEST) as f:
            m = json.load(f)
        if isinstance(m, dict):
            m.setdefault("rollbacks", [])
            return m
    except (OSError, ValueError):
        pass
    return {"version": 1, "rollbacks": [], "inProgress": None}


def save_manifest(m):
    tmp = MANIFEST + ".tmp"
    with open(tmp, "w") as f:
        json.dump(m, f, indent=2)
    os.replace(tmp, MANIFEST)


def newest_tar():
    cands = []
    for pat in ("*-pre-push-*.tgz", "*-pre-backup-*.tgz"):
        for path in glob.glob(os.path.join(BOT_DIR, pat)):
            base = os.path.basename(path)
            if base.startswith("rollback-victim-"):
                continue
            cands.append((os.path.getmtime(path), path))
    if not cands:
        return None
    cands.sort()
    return cands[-1][1]


def load_check():
    """node --check over every tgcloud .js file. Returns list of failures."""
    failures = []
    for root, _dirs, files in os.walk(os.path.join(BOT_DIR, "tgcloud")):
        for name in files:
            if not name.endswith(".js"):
                continue
            path = os.path.join(root, name)
            code, _out = run(["node", "--check", path], timeout=60)
            if code != 0:
                failures.append(os.path.relpath(path, BOT_DIR))
    return failures


def main():
    manifest = load_manifest()
    if "--dry-run" in sys.argv:
        tar = newest_tar()
        if not tar:
            print(json.dumps({"dryRun": True, "error": "no pre-push backup tar found"}))
            return 4
        with tarfile.open(tar) as tf:
            members = tf.getnames()
        print(json.dumps({"dryRun": True, "tar": os.path.basename(tar),
                          "entries": len(members),
                          "allUnderTgcloud": bool(members) and all(n == "tgcloud" or n.startswith("tgcloud/") for n in members)}))
        return 0
    # Trigger=rollback: mark the outage episode for the tick's combined
    # recovery note (consumed + cleared by the outage hook on the first
    # full successful tick). Best-effort; never blocks the rollback.
    set_rollback_marker()
    if manifest.get("inProgress"):
        print(json.dumps({"error": "rollback already in progress", "inProgress": manifest["inProgress"]}))
        return 4
    tar = newest_tar()
    if not tar:
        print(json.dumps({"error": "no pre-push backup tar found"}))
        return 4
    ts = time.strftime("%Y-%m-%dT%H%M%SZ", time.gmtime())
    victim = os.path.join(BOT_DIR, "rollback-victim-%s.tgz" % ts)
    manifest["inProgress"] = {"startedAt": ts, "tar": os.path.basename(tar)}
    save_manifest(manifest)

    def finish(code, record):
        manifest["inProgress"] = None
        manifest["rollbacks"].append(record)
        save_manifest(manifest)
        print(json.dumps(record))
        return code

    # 3. Victim backup of the current tree (never lose wave work).
    code, out = run(["tar", "czf", victim, "tgcloud"], timeout=120)
    if code != 0:
        return finish(4, {"at": ts, "error": "victim backup failed", "detail": out[-300:]})
    # 4. Peek + restore the chosen tar (entries must sit under tgcloud/).
    try:
        with tarfile.open(tar) as tf:
            members = tf.getnames()
        if not members or any(not (n == "tgcloud" or n.startswith("tgcloud/")) for n in members):
            return finish(4, {"at": ts, "error": "tar entries outside tgcloud/", "tar": os.path.basename(tar)})
        shutil.rmtree(os.path.join(BOT_DIR, "tgcloud"))
        with tarfile.open(tar) as tf:
            tf.extractall(BOT_DIR)
    except (OSError, tarfile.TarError) as e:
        return finish(4, {"at": ts, "error": "restore failed", "detail": str(e)[:300]})
    # 5. Load check BEFORE any push.
    failures = load_check()
    if failures:
        # Restore the victim tree; nothing was pushed.
        shutil.rmtree(os.path.join(BOT_DIR, "tgcloud"))
        with tarfile.open(victim) as tf:
            tf.extractall(BOT_DIR)
        return finish(1, {"at": ts, "error": "restored tree failed load check, victim restored, no push",
                          "tar": os.path.basename(tar), "failures": failures[:10]})
    # 6. Push.
    code, out = run([sys.executable, "tgc.py", "push"], timeout=300)
    if code != 0:
        return finish(2, {"at": ts, "error": "push failed", "tar": os.path.basename(tar), "detail": out[-300:]})
    # 7. Diff must be empty.
    code, out = run([sys.executable, "tgc.py", "diff"], timeout=120)
    if "No changes" not in out:
        return finish(2, {"at": ts, "error": "post-push diff not empty", "tar": os.path.basename(tar), "detail": out[-300:]})
    # 8. Verify with a real tick.
    code, out = run([sys.executable, "tick_run.py"], timeout=300)
    if code != 0 or "ranAt" not in out or "cycles" not in out:
        return finish(3, {"at": ts, "error": "pushed but tick not clean", "tar": os.path.basename(tar),
                          "victim": os.path.basename(victim), "detail": out[-300:]})
    return finish(0, {"at": ts, "restoredTar": os.path.basename(tar), "victim": os.path.basename(victim),
                      "pushed": True, "tickClean": True})


if __name__ == "__main__":
    sys.exit(main())
