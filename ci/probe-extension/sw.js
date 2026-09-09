const PROBE_KEY = 'nolane_acceptance_probe';
const BOOT_ID = crypto.randomUUID();
globalThis.__NOLANE_PROBE_BOOT_ID = BOOT_ID;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    [PROBE_KEY]: {
      installed: true,
      version: chrome.runtime.getManifest().version,
      at: Date.now()
    }
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'probe.ping') return false;
  sendResponse({
    ok: true,
    id: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    bootId: BOOT_ID
  });
  return false;
});
