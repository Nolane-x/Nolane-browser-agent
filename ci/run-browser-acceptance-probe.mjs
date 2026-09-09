import path from 'node:path';
import {runBrowserAcceptance} from '../scripts/browser-acceptance-lib.mjs';

const extensionDir = path.resolve('ci/probe-extension');
const report = await runBrowserAcceptance({extensionDir, timeoutMs: 30000});
console.log(JSON.stringify(report, null, 2));
if (report.status !== 'PASS') {
  process.exitCode = 1;
}
