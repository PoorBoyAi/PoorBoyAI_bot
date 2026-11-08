"""run_endpoint.py — run one tgcloud endpoint server-side WITHOUT pushing.

Usage (from the bot dir):
  python3 run_endpoint.py <module> [json-input]

Established rules, same as tick_run.py/tgc.py:
- Surrogate via dynamic_credential_entry('custom.telegram-serverless');
  the entry is a DICT, entry['surrogate'] is the token. Never printed.
- Direct node, NEVER npx. FULL inherited env + TGCLOUD_TOKEN/APP_ID.
- --ctx as a LITERAL argv string, never a file path, never via shell.
"""
import os
import sys

sys.path.insert(0, '/opt/muse/skills/custom-connector-setup/bin')
from dynamic_credentials import dynamic_credential_entry

entry = dynamic_credential_entry('custom.telegram-serverless')
env = dict(os.environ)
env['TGCLOUD_TOKEN'] = entry['surrogate']
env['TGCLOUD_APP_ID'] = 'app8667050062'

module = sys.argv[1]
args = sys.argv[2] if len(sys.argv) > 2 else '{}'
os.execvpe('node', ['node', 'node_modules/@tgcloud/cli/bin/tgcloud.js',
                    'run', module, args, '--ctx',
                    '{"initData":{"user":{"id":8429146850}}}'], env)
