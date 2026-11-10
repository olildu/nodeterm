// What the boot prints about the sign-in configuration. Pure (config in, lines out) so the exact
// wording — which is the operator's only chance to notice a misconfiguration — is pinned by tests.
import type { ServerConfig } from './config'
import { describeTrustedNets } from './proxy-trust'
import { MIN_PASSWORD_LENGTH, passwordTooShort } from './auth'

export interface AuthBootMessages {
  /** console.error — something the operator asked for is OFF, or unsafe. */
  errors: string[]
  /** console.log — loud, but working as configured. */
  notices: string[]
}

export function authBootMessages(
  config: Pick<ServerConfig, 'trustProxy' | 'trustProxyRefused' | 'passwordSeed'>
): AuthBootMessages {
  const errors: string[] = []
  const notices: string[] = []

  // S2: header trust on loopback nets with no secret was refused — say exactly what to set.
  if (config.trustProxyRefused) errors.push(`✖ ${config.trustProxyRefused}`)

  if (config.trustProxy) {
    const nets = describeTrustedNets(config.trustProxy.nets)
    const header = config.trustProxy.header
    if (config.trustProxy.secret) {
      notices.push(
        `⚠️  Proxy header trust ENABLED: requests from [${nets}] carrying a non-empty "${header}" header ` +
          `AND the X-Nodeterm-Proxy-Secret header are authenticated WITHOUT a password. Ensure your proxy ` +
          `strips/overwrites "${header}" on client requests and sends the secret on every request.`
      )
    } else {
      // Non-loopback nets without a secret keep working (an existing deployment must not break), but
      // every host that can reach this server from those nets is "the proxy" — other containers on
      // the same network, the Docker host's bridge address.
      notices.push(
        `⚠️  Proxy header trust ENABLED without a secret: requests from [${nets}] carrying a non-empty ` +
          `"${header}" header are authenticated WITHOUT a password. EVERY host that can reach this server ` +
          `from those networks counts as your proxy — other containers on the same network, the Docker ` +
          `host. Set NODETERM_TRUST_PROXY_SECRET and have the proxy send it as X-Nodeterm-Proxy-Secret.`
      )
    }
  }

  // S8: the setup form refuses a password shorter than 8; the env seed used to skip that rule.
  // Warn, never refuse: an existing deployment with a short seeded password must still boot.
  if (config.passwordSeed !== undefined && passwordTooShort(config.passwordSeed)) {
    errors.push(
      `✖ NODETERM_SERVER_PASSWORD is shorter than ${MIN_PASSWORD_LENGTH} characters. It is still used, but ` +
        `the setup form would refuse it: anyone who can reach the login page can guess a short password. ` +
        `Choose a longer one (if a password already exists, delete auth.json in the data directory and ` +
        `restart to re-seed it).`
    )
  }
  return { errors, notices }
}
