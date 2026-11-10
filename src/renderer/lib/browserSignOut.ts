// Sign out of the Server Edition from the browser (security audit 2026-10, S3).
//
// Server Edition only: the page is served by the server it signs out of, so this is a plain POST
// to that server's own /auth routes — no `window.nodeTerminal` member, nothing for Electron or a
// relay tab (neither has a browser session to end). The POST carries the page's Origin, which the
// server's same-origin check requires (src/server/origin.ts).
//
//  - `this`:       /auth/logout     — deletes THIS browser's session on the server.
//  - `everywhere`: /auth/logout-all — deletes every session; every other open tab's connection is
//                  closed by the server and lands on the sign-in page.

export type SignOutScope = 'this' | 'everywhere'

export interface SignOutDeps {
  fetch: typeof fetch
  /** Navigate the page (window.location.assign). */
  assign: (url: string) => void
}

export type SignOutResult = { ok: true } | { ok: false; error: string }

export const SIGN_OUT_PATH: Record<SignOutScope, string> = {
  this: '/auth/logout',
  everywhere: '/auth/logout-all'
}

export async function signOutBrowser(scope: SignOutScope, deps: SignOutDeps): Promise<SignOutResult> {
  let res: Response
  try {
    // `manual`: the server answers 303 → /login, and following it inside fetch would only fetch
    // the login page into nothing. An opaque redirect IS the success answer.
    res = await deps.fetch(SIGN_OUT_PATH[scope], { method: 'POST', credentials: 'same-origin', redirect: 'manual' })
  } catch {
    return { ok: false, error: 'Could not reach the server. Nothing was signed out.' }
  }
  if (res.type === 'opaqueredirect' || res.ok || (res.status >= 300 && res.status < 400)) {
    deps.assign('/login')
    return { ok: true }
  }
  if (res.status === 401) {
    // The session was already gone (signed out elsewhere, or expired): the sign-in page is next anyway.
    deps.assign('/login')
    return { ok: true }
  }
  return { ok: false, error: `The server refused to sign out (HTTP ${res.status}). Nothing was signed out.` }
}
