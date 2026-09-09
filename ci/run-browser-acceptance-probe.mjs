import path from 'node:path';
import {runBrowserAcceptance} from '../scripts/browser-acceptance-lib.mjs';

const extensionDir = path.resolve('ci/probe-extension');
const attempts = Math.max(1, Math.min(50, Number.parseInt(process.env.NOLANE_ACCEPTANCE_ATTEMPTS || '10', 10) || 10));
const reports = [];
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const report = await runBrowserAcceptance({extensionDir, timeoutMs: 30000});
  reports.push(report);
  console.log(`\n=== acceptance attempt ${attempt}/${attempts} ===`);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
}

const passCount = reports.filter((report) => report.status === 'PASS').length;
console.log(`\nacceptance_passes=${passCount}/${attempts}`);
