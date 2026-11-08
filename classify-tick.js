// classify-tick.js — host-side tick-outcome classifier for the
// pb-serverless-tick cron body. Reads JSON from stdin:
//   { hasSummary: bool, outputText: string, lockSkipped: bool,
//     prevModuleStreak: number, prevLockStreak: number }
// Prints classifyTickOutcome(...) as JSON to stdout.
// It reuses the self-heal harness resolve hook because the classifier
// lives in tgcloud/lib/tick.js (module cap: no new lib file). The pure
// classifier touches no SDK surface, so stubbing is safe. Nothing here
// sends, pages, or pushes — the cron body decides actions from the
// output. Usage: echo '<json>' | node classify-tick.js
import './harness-selfheal-register.mjs';

const { __test } = await import('./tgcloud/lib/tick.js');

let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const parsed = input.trim() ? JSON.parse(input) : {};
process.stdout.write(JSON.stringify(__test.classifyTickOutcome(parsed)) + '\n');
