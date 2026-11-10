// The ONE kind of node allowed to run on THIS machine while it sits on an SSH project's canvas
// (issue #1186): the login node Settings → Accounts drops onto whatever canvas is active when the
// user adds a LOCAL account. Every other terminal of an SSH project runs on the project's host, and
// core refuses a local spawn for it (`PtyManager.setSshProjectCheck`).
//
// In memory only, on purpose. The mark must not travel through anything another writer can touch —
// node data reaches the SSH project's shared file on the host — so it lives here for this app run and
// is set by exactly one caller (Canvas's add-account-login listener). After a restart the node is an
// ordinary node of the SSH project again and runs on the host.
const marked = new Set<string>()

export function markLocalOnSshCanvas(nodeId: string): void {
  marked.add(nodeId)
}

export function isLocalOnSshCanvas(nodeId: string): boolean {
  return marked.has(nodeId)
}
