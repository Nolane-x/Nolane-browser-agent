import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {
  buildChromiumArgs,
  createCdpPipeClient,
  findExtensionServiceWorker,
  resolveChromiumPath,
  waitForExtensionServiceWorkerRuntime,
} from '../scripts/browser-acceptance-lib.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const extensionDir = path.resolve('ci/probe-extension');
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
const expectedVersion = String(manifest.version || '');
const expectedPath = String(manifest.background?.service_worker || 'sw.js');
const chromiumPath = resolveChromiumPath();
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nolane-mv3-reload-'));
const logPath = path.join(profileDir, 'chromium.log');
const out = fs.openSync(logPath, 'a');
const args = buildChromiumArgs({extensionDir, profileDir, port: 9444, startUrl: 'about:blank'});
const child = spawn(chromiumPath, args, {stdio: ['ignore', out, out, 'pipe', 'pipe'], detached: false, env: {...process.env}});
const client = createCdpPipeClient({commandPipe: child.stdio[3], responsePipe: child.stdio[4], timeoutMs: 30000});

async function waitForReplacementTarget(previousTargetId, extensionId, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const targets = await client.send('Target.getTargets', {}, {timeoutMs: 3000});
    const found = findExtensionServiceWorker(targets?.targetInfos, expectedPath);
    if (found && found.extensionId === extensionId && String(found.target?.targetId || '') !== previousTargetId) return found;
    await sleep(100);
  }
  throw Object.assign(new Error(`replacement service worker did not appear after ${previousTargetId}`), {code: 'SERVICE_WORKER_RELOAD_TIMEOUT'});
}

try {
  const browser = await client.send('Browser.getVersion', {}, {timeoutMs: 30000});
  console.log(`browser=${browser?.product || ''}`);
  const installed = await client.send('Extensions.loadUnpacked', {path: extensionDir}, {timeoutMs: 30000});
  const extensionId = String(installed?.id || '');
  if (!/^[a-p]{32}$/.test(extensionId)) throw new Error(`invalid extension id: ${extensionId}`);

  let runtime = await waitForExtensionServiceWorkerRuntime(client, {
    expectedPath,
    expectedExtensionId: extensionId,
    expectedVersion,
    timeoutMs: 30000,
  });
  if (!runtime.ready) throw new Error(`initial worker not ready: ${runtime.errorCode} ${runtime.errorMessage}`);

  const rounds = 5;
  for (let round = 1; round <= rounds; round += 1) {
    const previousTargetId = String(runtime.found?.target?.targetId || '');
    if (!previousTargetId) throw new Error('missing current worker target id');
    try {
      await client.send('Runtime.evaluate', {
        expression: 'chrome.runtime.reload(); true',
        returnByValue: true,
        awaitPromise: false,
      }, {sessionId: runtime.sessionId, timeoutMs: 3000});
    } catch (error) {
      console.log(`reload command detached during round ${round}: ${error?.code || ''} ${error?.message || error}`);
    }

    const replacement = await waitForReplacementTarget(previousTargetId, extensionId, 20000);
    runtime = await waitForExtensionServiceWorkerRuntime(client, {
      expectedPath,
      expectedExtensionId: extensionId,
      expectedVersion,
      timeoutMs: 20000,
    });
    if (!runtime.ready) throw new Error(`replacement worker not runtime-ready on round ${round}: ${runtime.errorCode} ${runtime.errorMessage}`);
    const nextTargetId = String(runtime.found?.target?.targetId || '');
    if (!nextTargetId || nextTargetId === previousTargetId || nextTargetId !== String(replacement.target?.targetId || '')) {
      throw new Error(`worker identity did not rotate on round ${round}: ${previousTargetId} -> ${nextTargetId}`);
    }
    console.log(`reload_round=${round} old=${previousTargetId} new=${nextTargetId} status=PASS`);
  }
  console.log('mv3_reload_reacquire=5/5');
} finally {
  client.close();
  try { child.kill('SIGTERM'); } catch {}
  await sleep(200);
  try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(out); } catch {}
}
