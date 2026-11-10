import { promises as fs } from 'node:fs'
import path from 'node:path'
import { renameAtomic, sweepForeignTempFiles, tempNameFor } from '../core/fs-atomic'
import type { GitHubSecretStore } from '../core/github/credentials'
import type { SecretStore } from '../core/secret-store'
import type { CorePlatform } from '../core/platform'
import type { GitHubHostController } from '../core/github/host'
import { IPC } from '../shared/ipc'

const FILE_NAME = 'github-issues-token.json'

export class ServerSecretStoreError extends Error {
  constructor(readonly code: 'invalid-token') {
    super(code)
  }
}

function validToken(token: string): boolean {
  return token.trim() === token && token.length > 0 && token.length <= 4096 && !/[\r\n\0]/.test(token)
}

/** Generic headless secret store. Server Edition has no OS keyring, so callers receive the same
 *  owner-only atomic file semantics instead of copying the GitHub token implementation. */
export class ServerSecretStore implements SecretStore {
  readonly availability = 'restricted-file' as const

  /** Mutations run FIFO (the WorkspaceStore.saveChain idiom): a clear's rm must never land inside
   *  an in-flight save's write-to-rename window — the parked rename would resurrect the PAT the
   *  UI just reported cleared. Each caller still sees only its own mutation's failure. */
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly userDataDir: string,
    private readonly fileName: string
  ) {}

  private chained<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn)
    this.chain = run.catch(() => {})
    return run
  }

  private get filePath(): string {
    return path.join(this.userDataDir, this.fileName)
  }

  save(token: string): Promise<void> {
    return this.chained(() => this.saveNow(token))
  }

  private async saveNow(token: string): Promise<void> {
    if (!validToken(token)) throw new ServerSecretStoreError('invalid-token')
    await fs.mkdir(this.userDataDir, { recursive: true })
    await sweepForeignTempFiles(this.filePath)
    // The store's per-instance chain orders this write against its sibling mutations; the per-call
    // temp name covers the writers the chain cannot see — a second `nodeterm-server --data-dir X`
    // process on the same dir (every process's counter starts at 0, hence the pid) and a crash
    // between tmp-write and rename. With a shared name one writer's rename publishes the other's
    // half-written PAT, or moves the file out from under it entirely and the loser's rename fails.
    const temporary = tempNameFor(this.filePath)
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, token }), {
        encoding: 'utf-8',
        mode: 0o600
      })
      await fs.chmod(temporary, 0o600)
      await renameAtomic(temporary, this.filePath)
    } catch (error) {
      // A failed write MUST remove its own temp, because here a leaked temp IS a leaked PAT: a
      // unique name is never written again, so only this cleanup (or a later run's sweep above,
      // once the pid is dead) will ever collect it. The error still propagates.
      await fs.rm(temporary, { force: true }).catch(() => {})
      throw error
    }
    await fs.chmod(this.filePath, 0o600)
  }

  clear(): Promise<void> {
    return this.chained(async () => {
      // Sweep here too: clearing a token that leaves an orphan temp behind has not cleared anything.
      await sweepForeignTempFiles(this.filePath)
      await fs.rm(this.filePath, { force: true })
    })
  }

  async readForHost(): Promise<string | null> {
    try {
      const value: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf-8'))
      const token = value && typeof value === 'object' &&
        (value as { version?: unknown }).version === 1
        ? (value as { token?: unknown }).token
        : null
      return typeof token === 'string' && validToken(token) ? token : null
    } catch {
      return null
    }
  }
}

export class ServerGitHubSecretStore extends ServerSecretStore implements GitHubSecretStore {
  constructor(userDataDir: string) {
    super(userDataDir, FILE_NAME)
  }
}

type Controller = Pick<GitHubHostController,
  'status' | 'approve' | 'revoke' | 'selectProvider' | 'saveToken' | 'clearToken'>

export function registerServerGitHubControl(
  platform: CorePlatform,
  controller: Controller
): void {
  platform.handle(IPC.githubControlStatus, (projectId?: string) => controller.status(projectId))
  platform.handle(IPC.githubControlApprove, (input) => controller.approve(input))
  platform.handle(IPC.githubControlRevoke, (input) => controller.revoke(input))
  platform.handle(IPC.githubControlSelectProvider, (input) => controller.selectProvider(input))
  platform.handle(IPC.githubControlSaveToken, (token: string) => controller.saveToken(token))
  platform.handle(IPC.githubControlClearToken, () => controller.clearToken())
}
