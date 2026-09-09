export function classifyMacosCftResult({report, logText = ''} = {}) {
  if (report?.status === 'PASS') {
    return Object.freeze({classification: 'PASS', gatingFailure: false});
  }
  const text = String(logText || '');
  const hasMachPort = text.includes('MachPortRendezvousServer') && text.includes('Unknown service name (1102)');
  const hasChildTermination = text.includes('No rendezvous client, terminating process');
  const timeoutLike = ['CDP_COMMAND_TIMEOUT', 'CDP_PIPE_FAILED', 'BROWSER_PROCESS_EXITED'].includes(String(report?.errorCode || ''));
  if (hasMachPort && hasChildTermination && timeoutLike) {
    return Object.freeze({classification: 'KNOWN_MACOS_CFT_MACHPORT_LIMITATION', gatingFailure: false});
  }
  return Object.freeze({classification: 'UNEXPECTED_FAILURE', gatingFailure: true});
}
