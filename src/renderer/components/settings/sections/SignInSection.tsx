import { useState } from 'react'
import { SettingsSection } from '../SettingsSection'
import { SearchableRow } from '../SearchableRow'
import { FieldRow } from '../FieldRow'
import { Button } from '@renderer/ui/Button'
import { ConfirmDialog } from '../../ConfirmDialog'
import { signOutBrowser, type SignOutScope } from '../../../lib/browserSignOut'

// Server Edition only (the section is not listed under Electron — see nav.ts `browserOnly`).
const ROWS = {
  signOut: {
    title: 'Sign out of this browser',
    keywords: ['sign out', 'log out', 'logout', 'session', 'password', 'browser']
  },
  signOutEverywhere: {
    title: 'Sign out everywhere',
    keywords: ['sign out', 'log out', 'logout', 'everywhere', 'all', 'sessions', 'revoke', 'browser', 'stolen']
  }
}
const ENTRIES = Object.values(ROWS)

export function SignInSection({ isActive }: { isActive: boolean }): React.JSX.Element {
  const [busy, setBusy] = useState<SignOutScope | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const run = async (scope: SignOutScope): Promise<void> => {
    setBusy(scope)
    setError(null)
    const r = await signOutBrowser(scope, {
      fetch: (...a) => window.fetch(...a),
      assign: (url) => window.location.assign(url)
    })
    if (!r.ok) {
      setError(r.error)
      setBusy(null)
    }
  }

  return (
    <SettingsSection id="sign-in" title="Sign-in" isActive={isActive} searchEntries={ENTRIES}>
      <SearchableRow {...ROWS.signOut}>
        <FieldRow
          label="Sign out of this browser"
          description="Ends this browser's session on the server, so a copy of its cookie stops working too. If you signed in through your proxy's single sign-on, sign out there as well."
          control={
            <Button onClick={() => void run('this')} disabled={busy !== null}>
              {busy === 'this' ? 'Signing out…' : 'Sign out'}
            </Button>
          }
        />
      </SearchableRow>
      <SearchableRow {...ROWS.signOutEverywhere}>
        <FieldRow
          label="Sign out everywhere"
          description="Ends every browser session on this server, this one included. Every open tab is disconnected and has to sign in again with the password. Use it if a device was lost or a session may have been copied."
          control={
            <Button onClick={() => setConfirming(true)} disabled={busy !== null}>
              {busy === 'everywhere' ? 'Signing out…' : 'Sign out everywhere'}
            </Button>
          }
        />
      </SearchableRow>
      {error ? (
        <p role="alert" className="mt-2 text-[13px] text-danger">
          {error}
        </p>
      ) : null}
      {confirming ? (
        <ConfirmDialog
          message="Sign out every browser? Every open tab on this server is disconnected and has to sign in again with the password. Running terminals keep running."
          confirmLabel="Sign out everywhere"
          onConfirm={() => {
            setConfirming(false)
            void run('everywhere')
          }}
          onCancel={() => setConfirming(false)}
        />
      ) : null}
    </SettingsSection>
  )
}
