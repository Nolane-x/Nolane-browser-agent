import fs from 'node:fs';
import path from 'node:path';
import { runBrowserAcceptance } from '../scripts/browser-acceptance-lib.mjs';
import { classifyMacosCftResult } from './macos-cft-diagnostic-lib.mjs';

const extensionDir = path.resolve('ci/probe-extension');
const chromiumPath = String(process.env.NOLANE_CHROMIUM_PATH || '').trim();
if (!chromiumPath) throw new Error('NOLANE_CHROMIUM_PATH is required for macOS CFT diagnostic');

const report = await runBrowserAcceptance({
  extensionDir,
  chromiumPath,
  timeoutMs: 30000,
});

let logText = '';
if (report?.logPath && fs.existsSync(report.logPath)) {
  logText = fs.readFileSync(report.logPath, 'utf8');
}

const result = classifyMacosCftResult({report, logText});
console.log(JSON.stringify({
  browserVersion: report?.browserVersion || '',
  status: report?.status || '',
  errorCode: report?.errorCode || '',
  classification: result.classification,
}, null, 2));

if (result.gatingFailure) {
  if (logText) process.stderr.write(logText.slice(-32768));
  process.exitCode = 1;
}
