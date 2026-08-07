import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthService } from '../src/web/auth'

const CHANNEL = { id: 'UC-current', snippet: { title: 'Current channel' } }

function authHarness(selectedChannelId?: string) {
  let tokenCallback: ((response: { access_token: string; expires_in: number }) => void) | undefined
  const requestAccessToken = vi.fn((configuration?: { prompt?: string }) => {
    tokenCallback?.({ access_token: 'ephemeral-access-token', expires_in: 3600 })
  })
  vi.stubGlobal('window', {
    google: {
      accounts: {
        oauth2: {
          initTokenClient: vi.fn((configuration: { callback: typeof tokenCallback }) => {
            tokenCallback = configuration.callback
            return { requestAccessToken }
          }),
          revoke: vi.fn()
        }
      }
    }
  })
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ items: [CHANNEL] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  })))

  const store = {
    getSettings: () => ({ locale: 'en', theme: 'system', selectedChannelId })
  }
  return {
    auth: new AuthService(store as never, 'client-id.apps.googleusercontent.com'),
    requestAccessToken
  }
}

afterEach(() => vi.unstubAllGlobals())

describe('browser OAuth reconnect', () => {
  it('reuses prior consent without persisting a token', async () => {
    const { auth, requestAccessToken } = authHarness(CHANNEL.id)

    const state = await auth.connect()

    expect(requestAccessToken).toHaveBeenCalledWith({ prompt: '' })
    expect(state.selectedChannelId).toBe(CHANNEL.id)
  })

  it('can explicitly show the Google account chooser', async () => {
    const { auth, requestAccessToken } = authHarness(CHANNEL.id)

    await auth.connect(true)

    expect(requestAccessToken).toHaveBeenCalledWith({ prompt: 'select_account' })
  })

  it('does not replace a remembered channel with a different account', async () => {
    const { auth } = authHarness('UC-remembered')

    const state = await auth.connect()

    expect(state.status).toBe('connected')
    expect(state.selectedChannelId).toBeUndefined()
    expect(state.channels).toEqual([{ id: CHANNEL.id, title: 'Current channel' }])
  })
})
