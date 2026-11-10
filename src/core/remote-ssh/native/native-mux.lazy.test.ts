// ssh2 must not load when the native transport is merely IMPORTED.
// native-runtime → native-mux sits on main's module-scope import graph, and main's module scope runs
// before Chromium's `ready`: a top-level ssh2 import cost every launch 14–25 ms warm (~680 ms in one
// cold-cache sample) for a transport that only runs on Windows or with NODETERM_NATIVE_SSH=1.
//
// This file deliberately imports nothing from ssh2 itself (not even test-keys.ts), so the module
// cache it inspects is this file's alone — the other native-* suites import ssh2 directly. It is in
// this directory so it rides the windows-latest CI job with the rest of the transport.
import { createRequire } from 'module'
import { describe, expect, it } from 'vitest'

const req = createRequire(import.meta.url)
const ssh2Entry = req.resolve('ssh2')

describe('native SSH transport: ssh2 is loaded lazily', () => {
  it('importing native-runtime (and so native-mux) does not evaluate ssh2', async () => {
    // A cached entry from elsewhere in this worker would make the assertion meaningless; drop it so
    // only this import can put it back. (Node's ESM loader of a CJS package populates this cache.)
    delete req.cache[ssh2Entry]
    const runtime = await import('./native-runtime')
    const mux = await import('./native-mux')
    expect(typeof runtime.useNativeSsh).toBe('function')
    expect(typeof mux.NativeMux).toBe('function')
    expect(req.cache[ssh2Entry]).toBeUndefined()
  })
})
