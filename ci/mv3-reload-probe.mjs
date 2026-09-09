import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {
  buildChromiumArgs,
  createCdpPipeClient,
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

function valueOf(result) {
  return result?.result?.value;
}

async function readBootId(runtime) {
  if (!runtime?.ready || !runtime.sessionId) throw new Error('worker runtime is not attached');
  const evaluated = await client.send('Runtime.evaluate', {
    expression: 'globalThis.__NOLANE_PROBE_BOOT_ID || ""',
    returnByValue: true,
    awaitPromise: true,
  }, {sessionId: runtime.sessionId, timeoutMs: 5000});
  const bootId = String(valueOf(evaluated) || '');
  if (!bootId) throw Object.assign(new Error('worker boot generation id is unavailable'), {code: 'SERVICE_WORKER_BOOT_ID_MISSING'});
  return bootId;
}

async function wakeExtensionWorker(extensionId, round, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const target = await client.send('Target.createTarget', {
        url: `chrome-extension://${extensionId}/panel.html?reload_round=${round}&wake=${Date.now()}`,
      }, {timeoutMs: 4000});
      const targetId = String(target?.targetId || '');
      if (!targetId) throw new Error('wake target id is missing');
      const attached = await client.send('Target.attachToTarget', {targetId, flatten: true}, {timeoutMs: 4000});
      const sessionId = String(attached?.sessionId || '');
      if (!sessionId) throw new Error('wake target session id is missing');
      const evaluated = await client.send('Runtime.evaluate', {
        expression: 'chrome.runtime.sendMessage({type:"probe.ping"})',
        returnByValue: true,
        awaitPromise: true,
      }, {sessionId, timeoutMs: 5000});
      const response = valueOf(evaluated);
      if (response?.ok === true && response?.id === extensionId && response?.version === expectedVersion && response?.bootId) {
        return Object.freeze({targetId, bootId: String(response.bootId)});
      }
      lastError = new Error(`wake ping returned invalid response: ${JSON.stringify(response)}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw Object.assign(new Error(`service worker did not wake after reload: ${lastError?.message || lastError || 'unknown error'}`), {code: 'SERVICE_WORKER_WAKE_TIMEOUT'});
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
  let bootId = await readBootId(runtime);

  const rounds = 5;
  for (let round = 1; round <= rounds; round += 1) {
    const previousTargetId = String(runtime.found?.target?.targetId || '');
    const previousBootId = bootId;
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

    const wake = await wakeExtensionWorker(extensionId, round, 12000);
    runtime = await waitForExtensionServiceWorkerRuntime(client, {
      expectedPath,
      expectedExtensionId: extensionId,
      expectedVersion,
      timeoutMs: 20000,
    });
    if (!runtime.ready) throw new Error(`replacement worker not runtime-ready on round ${round}: ${runtime.errorCode} ${runtime.errorMessage}`);
    bootId = await readBootId(runtime);
    const nextTargetId = String(runtime.found?.target?.targetId || '');
    if (!nextTargetId) throw new Error(`replacement worker target id missing on round ${round}`);
    if (bootId === previousBootId) {
      throw Object.assign(new Error(`worker generation did not rotate on round ${round}: ${previousBootId}`), {code: 'SERVICE_WORKER_GENERATION_NOT_ROTATED'});
    }
    if (wake.bootId !== bootId) {
      throw Object.assign(new Error(`wake response and attached worker disagree on round ${round}: ${wake.bootId} != ${bootId}`), {code: 'SERVICE_WORKER_GENERATION_MISMATCH'});
    }
    console.log(`reload_round=${round} old_target=${previousTargetId} new_target=${nextTargetId} old_boot=${previousBootId} new_boot=${bootId} status=PASS`);
  }
  console.log('mv3_reload_reacquire=5/5');
} finally {
  client.close();
  try { child.kill('SIGTERM'); } catch {}
  await sleep(200);
  try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(out); } catch {}
}
