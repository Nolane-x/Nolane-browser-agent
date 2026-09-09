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
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nolane-mv3-lifecycle-'));
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

async function waitForExtensionPageContext(sessionId, extensionId, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastInfo = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const evaluated = await client.send('Runtime.evaluate', {
        expression: '({href: location.href, ready: document.readyState, runtimeId: globalThis.chrome?.runtime?.id || "", version: globalThis.chrome?.runtime?.getManifest?.().version || ""})',
        returnByValue: true,
        awaitPromise: true,
      }, {sessionId, timeoutMs: 3000});
      const info = valueOf(evaluated);
      lastInfo = info;
      if (
        info?.runtimeId === extensionId &&
        info?.version === expectedVersion &&
        typeof info?.href === 'string' &&
        info.href.startsWith(`chrome-extension://${extensionId}/`) &&
        ['interactive', 'complete'].includes(info?.ready)
      ) return info;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  throw Object.assign(
    new Error(`extension page did not become runtime-ready: ${lastError?.message || JSON.stringify(lastInfo) || 'unknown state'}`),
    {code: 'EXTENSION_PAGE_NOT_READY'}
  );
}

async function createPersistentWakePage(extensionId) {
  const target = await client.send('Target.createTarget', {
    url: `chrome-extension://${extensionId}/panel.html?lifecycle_probe=${Date.now()}`,
  }, {timeoutMs: 5000});
  const targetId = String(target?.targetId || '');
  if (!targetId) throw Object.assign(new Error('wake page target id is missing'), {code: 'WAKE_PAGE_TARGET_ID_MISSING'});
  const attached = await client.send('Target.attachToTarget', {targetId, flatten: true}, {timeoutMs: 5000});
  const sessionId = String(attached?.sessionId || '');
  if (!sessionId) throw Object.assign(new Error('wake page session id is missing'), {code: 'WAKE_PAGE_SESSION_MISSING'});
  await waitForExtensionPageContext(sessionId, extensionId, 10000);
  return Object.freeze({targetId, sessionId});
}

async function pingWorkerFromPage(pageSessionId, extensionId, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let lastResponse = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const evaluated = await client.send('Runtime.evaluate', {
        expression: '(async () => { try { return await chrome.runtime.sendMessage({type:"probe.ping"}); } catch (error) { return {__probeError: String(error?.message || error)}; } })()',
        returnByValue: true,
        awaitPromise: true,
      }, {sessionId: pageSessionId, timeoutMs: 5000});
      const response = valueOf(evaluated);
      lastResponse = response;
      if (
        response?.ok === true &&
        response?.id === extensionId &&
        response?.version === expectedVersion &&
        response?.bootId
      ) return String(response.bootId);
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw Object.assign(
    new Error(`service worker did not answer wake ping: ${lastError?.message || JSON.stringify(lastResponse) || 'unknown error'}`),
    {code: 'SERVICE_WORKER_WAKE_TIMEOUT'}
  );
}

async function terminateWorkerTarget(targetId) {
  if (!targetId) throw new TypeError('worker target id is required');
  const closed = await client.send('Target.closeTarget', {targetId}, {timeoutMs: 5000});
  if (closed?.success !== true) {
    throw Object.assign(new Error(`Chrome did not close service-worker target ${targetId}`), {code: 'SERVICE_WORKER_TARGET_CLOSE_FAILED'});
  }
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const targets = await client.send('Target.getTargets', {}, {timeoutMs: 3000});
    const stillPresent = Array.isArray(targets?.targetInfos) && targets.targetInfos.some((target) => String(target?.targetId || '') === targetId);
    if (!stillPresent) return;
    await sleep(100);
  }
  throw Object.assign(new Error(`service-worker target remained after close: ${targetId}`), {code: 'SERVICE_WORKER_TARGET_CLOSE_TIMEOUT'});
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
  const wakePage = await createPersistentWakePage(extensionId);

  const rounds = 5;
  for (let round = 1; round <= rounds; round += 1) {
    const previousTargetId = String(runtime.found?.target?.targetId || '');
    const previousBootId = bootId;
    if (!previousTargetId) throw new Error('missing current worker target id');

    await terminateWorkerTarget(previousTargetId);
    const wakeBootId = await pingWorkerFromPage(wakePage.sessionId, extensionId, 12000);

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
    if (wakeBootId !== bootId) {
      throw Object.assign(new Error(`wake response and attached worker disagree on round ${round}: ${wakeBootId} != ${bootId}`), {code: 'SERVICE_WORKER_GENERATION_MISMATCH'});
    }
    console.log(`restart_round=${round} old_target=${previousTargetId} new_target=${nextTargetId} old_boot=${previousBootId} new_boot=${bootId} status=PASS`);
  }
  console.log('mv3_worker_restart_reacquire=5/5');
} finally {
  client.close();
  try { child.kill('SIGTERM'); } catch {}
  await sleep(200);
  try { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); } catch {}
  try { fs.closeSync(out); } catch {}
}
