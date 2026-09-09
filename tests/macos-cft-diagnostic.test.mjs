import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyMacosCftResult } from '../ci/macos-cft-diagnostic-lib.mjs';

test('passes through a successful browser acceptance result', () => {
  assert.deepEqual(classifyMacosCftResult({ report: {status: 'PASS'}, logText: '' }), {
    classification: 'PASS',
    gatingFailure: false,
  });
});

test('classifies the exact hosted macOS Chrome-for-Testing MachPort failure as infrastructure', () => {
  const logText = [
    'bootstrap_look_up com.google.chrome.for.testing.MachPortRendezvousServer.123: Unknown service name (1102)',
    'No rendezvous client, terminating process (parent died?)',
  ].join('\n');
  assert.deepEqual(classifyMacosCftResult({ report: {status: 'FAIL', errorCode: 'CDP_COMMAND_TIMEOUT'}, logText }), {
    classification: 'KNOWN_MACOS_CFT_MACHPORT_LIMITATION',
    gatingFailure: false,
  });
});

test('fails closed for any different Chrome-for-Testing failure', () => {
  assert.deepEqual(classifyMacosCftResult({
    report: {status: 'FAIL', errorCode: 'CDP_PIPE_FAILED'},
    logText: 'unexpected browser crash without known MachPort signature',
  }), {
    classification: 'UNEXPECTED_FAILURE',
    gatingFailure: true,
  });
});
