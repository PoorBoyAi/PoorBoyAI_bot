// endpoints/decideReport.js — owner-only shadow/calibration report for the
// decision layer (PB-DECISION-LAYER-DESIGN §3.4). Read-only analysis over
// decision_log: per-question-set agreement vs the incumbent, precision at
// the act line, calibration buckets, confusion pairs, failure histogram,
// latency percentiles, and the live flag posture of every set.
//
// NOT a member surface: refuses anyone whose verified initData user is not
// an owner. Run it with:
//   tgcloud run endpoints/decideReport '{"days":30}' --ctx owner-ctx
//
// The Batch 1 exit gate reads off `batch1Gate`: ≥300 shadowed nl_intent
// messages AND intent precision ≥97% at the 0.85 act line (agreement with
// the incumbent is the shadow-phase proxy for precision; ground-truth
// precision is reported alongside wherever groundTruth has been filled).

import { EndpointError } from 'sdk';
import db, { gte } from 'sdk/db';
import { decision_log } from '../schema.js';
import { getConfig } from '../lib/config.js';
import { isOwnerId } from '../lib/groups.js';
import { QUESTION_SETS } from '../lib/decide.js';

const MAX_ROWS = 10_000;

function pct(n, d) {
  return d > 0 ? Math.round((n / d) * 1000) / 10 : null;
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

export default async function (input, ctx) {
  const userId = ctx?.initData?.user?.id;
  if (!userId || !(await isOwnerId(userId))) {
    throw new EndpointError('Owner only.', { code: 'FORBIDDEN' });
  }
  const days = Math.min(90, Math.max(1, Number(input?.days ?? 30) || 30));
  const onlySet = input?.questionSet ? String(input.questionSet) : null;
  const cutoffSec = Math.floor(Date.now() / 1000) - days * 24 * 3600;

  let rows = [];
  try {
    rows = await db.select().from(decision_log)
      .where(gte(decision_log.createdAt, cutoffSec)).all();
  } catch (err) {
    throw new EndpointError('decision_log read failed: ' + (err?.message ?? 'unknown'), { code: 'READ_FAILED' });
  }
  rows = rows.slice(0, MAX_ROWS);

  const bySet = {};
  for (const r of rows) {
    if (onlySet && r.questionSet !== onlySet) continue;
    (bySet[r.questionSet] ??= []).push(r);
  }

  const sets = {};
  for (const [setId, setRows] of Object.entries(bySet)) {
    const set = QUESTION_SETS[setId];
    const primary = set?.questions?.[0]?.name ?? null;
    const actLine = set?.actLine ?? null;
    const failures = {};
    const models = {};
    const bySurfaceShadow = {};
    let okCount = 0, shadowCount = 0;
    const latencies = [];
    // Shadow calibration (outcomeNote 'agree' | 'diverge…' written by callers)
    let agree = 0, diverge = 0;
    let actN = 0, actAgree = 0;
    let gtCorrect = 0, gtWrong = 0, actGtCorrect = 0, actGtWrong = 0;
    const buckets = {};
    const confusion = {};
    for (const r of setRows) {
      if (r.failureReason) failures[r.failureReason] = (failures[r.failureReason] ?? 0) + 1;
      else okCount++;
      if (r.shadow) {
        shadowCount++;
        bySurfaceShadow[r.surface] = (bySurfaceShadow[r.surface] ?? 0) + 1;
      }
      if (r.modelUsed) models[r.modelUsed] = (models[r.modelUsed] ?? 0) + 1;
      if (typeof r.latencyMs === 'number') latencies.push(r.latencyMs);
      const ans = r.answersJson ?? null;
      const primaryAns = primary && ans ? ans[primary] : null;
      const conf = typeof primaryAns?.confidence === 'number' ? primaryAns.confidence : null;
      const isAgree = r.outcomeNote === 'agree';
      const isDiverge = typeof r.outcomeNote === 'string' && r.outcomeNote.startsWith('diverge');
      if (isAgree) agree++;
      if (isDiverge) {
        diverge++;
        const incumbent = typeof r.actionTaken === 'string' && r.actionTaken.startsWith('incumbent:')
          ? r.actionTaken.slice('incumbent:'.length) : '?';
        const pair = `${incumbent} -> ${primaryAns?.value ?? '?'}`;
        confusion[pair] = (confusion[pair] ?? 0) + 1;
      }
      if (r.groundTruth === 'correct') gtCorrect++;
      if (r.groundTruth === 'wrong') gtWrong++;
      const atAct = actLine != null && conf != null && conf >= actLine;
      if (atAct) {
        // The agreement-based act-line sample counts ONLY rows a caller
        // actually compared (agree/diverge) — a raw decide() probe with
        // no recorded outcome is not evidence either way.
        if (isAgree || isDiverge) {
          actN++;
          if (isAgree) actAgree++;
        }
        if (r.groundTruth === 'correct') actGtCorrect++;
        if (r.groundTruth === 'wrong') actGtWrong++;
      }
      if (conf != null && (isAgree || isDiverge)) {
        const b = conf >= 0.9 ? '0.9-1.0' : conf >= 0.8 ? '0.8-0.9' : conf >= 0.7 ? '0.7-0.8'
          : conf >= 0.6 ? '0.6-0.7' : conf >= 0.5 ? '0.5-0.6' : '0.0-0.5';
        const bk = (buckets[b] ??= { n: 0, agree: 0 });
        bk.n++;
        if (isAgree) bk.agree++;
      }
    }
    latencies.sort((a, b) => a - b);
    const bucketOut = {};
    for (const [b, v] of Object.entries(buckets)) {
      bucketOut[b] = { n: v.n, agreeRatePct: pct(v.agree, v.n) };
    }
    sets[setId] = {
      version: set?.version ?? null,
      primaryQuestion: primary,
      actLine,
      flags: {
        off: (await getConfig(`decide_off_${setId}`, '')) || null,
        shadow: (await getConfig(`decide_shadow_${setId}`, '')) || null,
        live: (await getConfig(`decide_live_${setId}`, '')) || null,
        sample: (await getConfig(`decide_sample_${setId}`, '')) || null,
      },
      calls: setRows.length,
      ok: okCount,
      failures,
      shadowCalls: shadowCount,
      bySurfaceShadow,
      liveCalls: setRows.length - shadowCount,
      models,
      latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
      shadowCalibration: {
        compared: agree + diverge,
        agreementRatePct: pct(agree, agree + diverge),
        precisionAtActLinePct: pct(actAgree, actN),
        actLineSample: actN,
        groundTruth: {
          correct: gtCorrect, wrong: gtWrong,
          precisionPct: pct(gtCorrect, gtCorrect + gtWrong),
          precisionAtActLinePct: pct(actGtCorrect, actGtCorrect + actGtWrong),
        },
        calibrationBuckets: bucketOut,
        topConfusions: Object.entries(confusion).sort((a, b) => b[1] - a[1]).slice(0, 8)
          .map(([pair, n]) => ({ pair, n })),
      },
    };
  }

  // Batch 1 exit gate (design §5): ≥300 shadowed nl_intent messages and
  // intent precision ≥97% at the 0.85 line. While shadowed, agreement with
  // the incumbent is the precision proxy; ground truth refines it later.
  const nl = sets.nl_intent;
  const gatePrecision = nl?.shadowCalibration?.precisionAtActLinePct ?? null;
  // Only real NL-path messages count toward the 300 — raw decide() probes
  // (other surfaces) are not shadowed owner messages. Freechat rows ARE
  // real NL-path messages: a live decide() call on a real message PB
  // answered, with a compared incumbent outcome in outcomeNote
  // (agree/diverge) — so they count alongside nlcmd rows. Threshold
  // stays 300; no other gate math changes.
  const nlShadowedMessages = (nl?.bySurfaceShadow?.nlcmd ?? 0) + (nl?.bySurfaceShadow?.freechat ?? 0);
  const batch1Gate = {
    set: 'nl_intent',
    shadowedMessages: nlShadowedMessages,
    messagesNeeded: 300,
    actLine: 0.85,
    precisionBarPct: 97,
    precisionProxyPct: gatePrecision,
    status: !nl || nlShadowedMessages < 300
      ? 'collecting'
      : (gatePrecision != null && gatePrecision >= 97 ? 'pass' : 'below-bar-reword-and-reshadow'),
  };

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    windowDays: days,
    totalRows: rows.length,
    sets,
    batch1Gate,
  };
}
