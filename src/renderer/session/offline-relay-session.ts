import type { NodeTerminalApi } from '@shared/types'
import { E_DISCONNECTED } from '../../shared/rpc'
import { buildRelayApi } from '../bridge/relay-api'
import type { FrameTransport } from '../bridge/frame-transport'
import { OFFLINE_RELAY_SESSION_ID, setOfflineRelayApiFactory } from './session'

/**
 * A relay carrier that is already gone. `send` reports the connection closed SYNCHRONOUSLY, every
 * time: `RpcClient.request` registers its pending entry before it sends, so the close fails that
 * request at once with `E_DISCONNECTED` instead of leaving it pending forever (a promise that never
 * settles strands every caller's cleanup — see `RpcClient.failPending`). Casts go nowhere, nothing
 * ever arrives (`onMessage` keeps no listener), and `ready()` rejects.
 */
export function deadRelayTransport(): FrameTransport {
  const closeCbs: Array<() => void> = []
  return {
    send: () => {
      for (const cb of closeCbs) cb()
    },
    onMessage: () => {},
    onClose: (cb) => {
      closeCbs.push(cb)
    },
    // A fresh rejection per call, so constructing the transport leaves no unhandled rejection.
    ready: () =>
      Promise.reject(
        Object.assign(new Error('This tab is not connected to its host.'), { code: E_DISCONNECTED })
      )
  }
}

/**
 * The api of the offline relay session an unbound REMOTE project resolves to (session.ts,
 * `sessionForProject`). It is a real relay api — the same core-bound / local split a live relay tab
 * has — over a dead carrier, so every core-bound call (pty, fs, git, workspace, files, …) rejects:
 * no terminal can be created on THIS machine's core under a node id that lives on another machine.
 * It is not a wall around this machine: like a live relay tab's api it spreads `...local`, so the
 * namespaces a relay tab keeps local (contextLink, transcripts, handoff, media, the app-global ones)
 * still act here, and its `boardLog` read answers `unsupported: true` rather than rejecting.
 * Built here rather than in session.ts because relay-api imports session.ts.
 */
export function offlineRelayApi(): NodeTerminalApi {
  return buildRelayApi(OFFLINE_RELAY_SESSION_ID, deadRelayTransport()).api
}

setOfflineRelayApiFactory(offlineRelayApi)
