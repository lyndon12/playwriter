// Sign-out button using better-auth client POST endpoint.
// The GET /api/auth/sign-out endpoint does not work reliably,
// so we use authClient.signOut() which POSTs to the correct endpoint.
'use client'

import { useState } from 'react'
import { createAuthClient } from 'better-auth/react'

const authClient = createAuthClient()

export function SignOutButton() {
  const [loading, setLoading] = useState(false)

  return (
    <button
      type='button'
      disabled={loading}
      onClick={async () => {
        setLoading(true)
        await authClient.signOut()
        window.location.href = '/login'
      }}
      className='inline-flex h-9 items-center justify-center rounded-md border border-foreground/15 bg-white dark:bg-background px-4 text-sm font-medium transition-colors hover:border-foreground/25 hover:text-accent-foreground disabled:opacity-50'
    >
      {loading ? 'Signing out...' : 'Sign out'}
    </button>
  )
}
