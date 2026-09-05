// Bootstrap owns the listening port; Runtime adapters must not derive it from
// ambient subprocess variables or from the Global Sidecar's port file.
let sidecarPort = 0;

export function setSidecarPort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error('Invalid Sidecar listening port');
  }
  sidecarPort = port;
  if (port > 0) process.env.MYAGENTS_PORT = String(port);
  else delete process.env.MYAGENTS_PORT;
}

export function getSidecarPort(): number {
  return sidecarPort;
}
