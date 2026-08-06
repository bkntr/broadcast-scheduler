import { describe, expect, it } from 'vitest'
import { configuredOAuthClientId } from '../src/web/oauth-config'

describe('configured Google OAuth client ID', () => {
  it('accepts and trims a Web application client ID', () => {
    expect(configuredOAuthClientId(' 123-example.apps.googleusercontent.com '))
      .toBe('123-example.apps.googleusercontent.com')
  })

  it('treats a missing value as an unconfigured deployment', () => {
    expect(configuredOAuthClientId(undefined)).toBeUndefined()
    expect(configuredOAuthClientId('')).toBeUndefined()
  })

  it('rejects a malformed value or copied client secret', () => {
    expect(() => configuredOAuthClientId('GOCSPX-example-secret')).toThrow(/VITE_GOOGLE_CLIENT_ID/)
  })
})
