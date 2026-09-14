import { createAuthClient } from 'better-auth/react'
import { apiKeyClient } from '@better-auth/api-key/client'

export const authClient = createAuthClient({
  // omit baseURL — client and server share the same domain
  plugins: [apiKeyClient()],
})
