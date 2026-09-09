import path from 'node:path';
import {runBrowserAcceptance} from '../scripts/browser-acceptance-lib.mjs';

const extensionDir = path.resolve('ci/probe-extension');
const attempts = Math.max(1, Math.min(100, Number.parseInt(process.env.NOLANE_ACCEPTANCE_ATTEMPTS || '10', 10) || 10));
const timeoutMs = Math.max(5000, Math.min(120000, Number.parseInt(process.env.NOLANE_ACCEPTANCE_TIMEOUT_MS || '30000', 10) || 30000));
const chromiumPath = String(process.env.NOLANE_CHROMIUM_PATH || '').trim();
const reports = [];
console.log(`configured_chromium=${chromiumPath || 'auto-detect'} attempts=${attempts} timeout_ms=${timeoutMs}`);
for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const report = await runBrowserAcceptance({extensionDir, chromiumPath, timeoutMs});
  reports.push(report);
  console.log(`\n=== acceptance attempt ${attempt}/${attempts} ===`);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') process.exitCode = 1;
}

const passCount = reports.filter((report) => report.status === 'PASS').length;
const versions = [...new Set(reports.map((report) => String(report.browserVersion || '')).filter(Boolean))];
console.log(`\nacceptance_passes=${passCount}/${attempts} browser_versions=${versions.join(',') || 'unknown'}`);
if (passCount !== attempts) process.exitCode = 1;
