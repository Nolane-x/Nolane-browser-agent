import fs from 'node:fs';
import path from 'node:path';
import {runBrowserAcceptance} from '../scripts/browser-acceptance-lib.mjs';

const extensionDir = path.resolve('ci/probe-extension');
const attempts = Math.max(1, Math.min(100, Number.parseInt(process.env.NOLANE_ACCEPTANCE_ATTEMPTS || '10', 10) || 10));
const timeoutMs = Math.max(5000, Math.min(120000, Number.parseInt(process.env.NOLANE_ACCEPTANCE_TIMEOUT_MS || '30000', 10) || 30000));
const chromiumPath = String(process.env.NOLANE_CHROMIUM_PATH || '').trim();
const reports = [];
console.log(`configured_chromium=${chromiumPath || 'auto-detect'} attempts=${attempts} timeout_ms=${timeoutMs}`);

function printLogTail(logPath, maxBytes = 16384) {
  if (!logPath || !fs.existsSync(logPath)) {
    console.log('chromium_log=unavailable');
    return;
  }
  try {
    const stat = fs.statSync(logPath);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(logPath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      console.log(`\n--- chromium log tail (${logPath}, bytes ${start}-${stat.size}) ---`);
      process.stdout.write(buffer.toString('utf8'));
      if (!buffer.toString('utf8').endsWith('\n')) process.stdout.write('\n');
      console.log('--- end chromium log tail ---');
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    console.log(`chromium_log_read_error=${error?.message || error}`);
  }
}

for (let attempt = 1; attempt <= attempts; attempt += 1) {
  const report = await runBrowserAcceptance({extensionDir, chromiumPath, timeoutMs});
  reports.push(report);
  console.log(`\n=== acceptance attempt ${attempt}/${attempts} ===`);
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'PASS') {
    printLogTail(report.logPath);
    process.exitCode = 1;
  }
}

const passCount = reports.filter((report) => report.status === 'PASS').length;
const versions = [...new Set(reports.map((report) => String(report.browserVersion || '')).filter(Boolean))];
console.log(`\nacceptance_passes=${passCount}/${attempts} browser_versions=${versions.join(',') || 'unknown'}`);
if (passCount !== attempts) process.exitCode = 1;
