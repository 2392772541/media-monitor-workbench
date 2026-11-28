import { PendingLiveError } from './lib/helpers.mjs';
import { getTier1Checks } from './tier1.mjs';
import { getTier2Checks } from './tier2.mjs';
import { getTier3Checks } from './tier3.mjs';
import { getTier4Checks } from './tier4.mjs';

function parseArgs(argv) {
  const opts = {
    tier: 'all',
    offlineCheck: false,
    json: false,
    baseUrl: 'http://127.0.0.1:18910',
    sauUrl: 'http://127.0.0.1:5409',
  };
  for (const arg of argv) {
    if (arg === '--offline-check' || arg === '--dry-verify') {
      opts.offlineCheck = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg.startsWith('--tier=')) {
      opts.tier = arg.slice('--tier='.length).trim().toLowerCase();
    } else if (arg.startsWith('--base-url=')) {
      opts.baseUrl = arg.slice('--base-url='.length).replace(/\/+$/, '');
    } else if (arg.startsWith('--sau-url=')) {
      opts.sauUrl = arg.slice('--sau-url='.length).replace(/\/+$/, '');
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node tests/e2e-suite/run-e2e.mjs [--tier=1|2|3|4|all] [--offline-check|--dry-verify] [--json] [--base-url=http://127.0.0.1:18910] [--sau-url=http://127.0.0.1:5409]'
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  if (!['1', '2', '3', '4', 'all'].includes(opts.tier)) {
    console.error(`Invalid --tier=${opts.tier}. Expected 1|2|3|4|all`);
    process.exit(2);
  }
  return opts;
}

async function runTier(tierNum, checks, ctx, emitLogs) {
  const results = [];
  let passed = 0;
  let failed = 0;
  let pending = 0;

  if (emitLogs) {
    console.log(`\n=== Tier ${tierNum} (${checks.length} checks) ===`);
  }

  for (const chk of checks) {
    const started = Date.now();
    let status = 'PASS';
    let detail = '';
    try {
      await chk.run(ctx);
      passed++;
    } catch (err) {
      if (err instanceof PendingLiveError && ctx.offlineCheck) {
        status = 'PENDING_LIVE';
        detail = err.message;
        pending++;
      } else {
        status = 'FAIL';
        detail = err?.message || String(err);
        failed++;
      }
    }
    const durationMs = Date.now() - started;
    results.push({
      id: chk.id,
      tier: tierNum,
      feature: chk.feature,
      name: chk.name,
      status,
      durationMs,
      detail: detail || undefined,
    });
    if (emitLogs) {
      const suffix = detail ? ` -> ${detail}` : '';
      console.log(`[${status}] ${chk.id} (${chk.feature}) ${chk.name} (${durationMs}ms)${suffix}`);
    }
  }

  return {
    tier: tierNum,
    total: checks.length,
    passed,
    failed,
    pending,
    results,
  };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const ctx = {
    baseUrl: opts.baseUrl,
    sauUrl: opts.sauUrl,
    offlineCheck: opts.offlineCheck,
  };

  const tierMap = [
    { num: 1, minThreshold: 50, checks: getTier1Checks() },
    { num: 2, minThreshold: 50, checks: getTier2Checks() },
    { num: 3, minThreshold: 10, checks: getTier3Checks() },
    { num: 4, minThreshold: 5, checks: getTier4Checks() },
  ];

  const selected = opts.tier === 'all' ? tierMap : tierMap.filter((t) => String(t.num) === opts.tier);
  const emitLogs = !opts.json;
  const tierSummaries = [];

  for (const t of selected) {
    const summary = await runTier(t.num, t.checks, ctx, emitLogs);
    summary.minThreshold = t.minThreshold;
    summary.thresholdMet = summary.total >= t.minThreshold;
    tierSummaries.push(summary);
  }

  const totalChecks = tierSummaries.reduce((acc, t) => acc + t.total, 0);
  const totalPassed = tierSummaries.reduce((acc, t) => acc + t.passed, 0);
  const totalFailed = tierSummaries.reduce((acc, t) => acc + t.failed, 0);
  const totalPending = tierSummaries.reduce((acc, t) => acc + t.pending, 0);
  const thresholdsAllMet = tierSummaries.every((t) => t.thresholdMet);
  const allPassed = totalFailed === 0 && (opts.offlineCheck || totalPending === 0) && thresholdsAllMet;

  const report = {
    mode: opts.offlineCheck ? 'offline-check' : 'live',
    tier: opts.tier,
    baseUrl: opts.baseUrl,
    sauUrl: opts.sauUrl,
    timestamp: new Date().toISOString(),
    totals: {
      total: totalChecks,
      passed: totalPassed,
      failed: totalFailed,
      pending: totalPending,
      thresholdsAllMet,
      ok: allPassed,
    },
    tiers: tierSummaries.map(({ results: _r, ...meta }) => meta),
    failures: tierSummaries.flatMap((t) => t.results.filter((r) => r.status === 'FAIL')),
    pendingItems: tierSummaries.flatMap((t) => t.results.filter((r) => r.status === 'PENDING_LIVE')),
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('\n=== E2E Suite Summary ===');
    console.log(`Mode: ${report.mode} | Base: ${opts.baseUrl} | SAU: ${opts.sauUrl}`);
    for (const t of tierSummaries) {
      console.log(
        `Tier ${t.tier}: total=${t.total} (min=${t.minThreshold}) | PASS=${t.passed} | FAIL=${t.failed} | PENDING_LIVE=${t.pending}`
      );
    }
    console.log(
      `TOTAL: ${totalChecks} | PASS=${totalPassed} | FAIL=${totalFailed} | PENDING_LIVE=${totalPending} | RESULT=${allPassed ? 'PASS' : 'FAIL'}`
    );
    if (report.failures.length > 0) {
      console.log('\nFailures:');
      for (const f of report.failures) {
        console.log(`  - ${f.id}: ${f.detail}`);
      }
    }
  }

  process.exitCode = allPassed ? 0 : 1;
}

main().catch((err) => {
  console.error('Fatal E2E runner error:', err);
  process.exitCode = 1;
});
