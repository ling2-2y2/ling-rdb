// Test-environment shim for confined sandboxes on Windows. Vite's
// `optimizeSafeRealPathSync` unconditionally spawns `net use` (piped
// stdio) on the first safe-realpath call, which a sandbox that forbids
// piped child spawns denies with EPERM — `npx vitest run` then dies while
// loading vitest.config.ts. The probe only feeds network-drive mapping;
// answering "no network mappings" (empty stdout) is semantically exact.
//
// Normal runs (unconfined shell) do NOT need this file. Confined runs opt
// in via:
//   NODE_OPTIONS="--require ./tests/sandbox-shim.cjs" npx vitest run --pool=threads
// (Same file as dsh-rbac/tests/sandbox-shim.cjs; each package stays
// self-contained per the bsh-scratch-plugin layout.)
'use strict'
const cp = require('node:child_process')
const origExec = cp.exec
cp.exec = function shimmedExec(command, options, callback) {
  const cb = typeof options === 'function' ? options : callback
  if (typeof command === 'string' && command.trim() === 'net use') {
    if (typeof cb === 'function') process.nextTick(() => cb(null, ''))
    return { kill() {}, on() { return this }, once() { return this }, off() { return this } }
  }
  return origExec.apply(this, arguments)
}
