import type { AuthState, ChannelSummary } from '../shared/types'
import { AppError, toAppError } from './errors'
import type { BrowserStore } from './storage'

const SCOPES = 'https://www.googleapis.com/auth/youtube.force-ssl'
const GIS_SCRIPT = 'https://accounts.google.com/gsi/client'

interface TokenResponse {
  access_token?: string
  expires_in?: number
  error?: string
  error_description?: string
}

interface TokenClient {
  requestAccessToken(configuration?: { prompt?: string }): void
}

interface GoogleIdentityServices {
  accounts: {
    oauth2: {
      initTokenClient(configuration: {
        client_id: string
        scope: string
        callback: (response: TokenResponse) => void
        error_callback: (error: { type?: string }) => void
      }): TokenClient
      revoke(token: string, callback?: () => void): void
    }
  }
}

declare global {
  interface Window {
    google?: GoogleIdentityServices
  }
}

let googleScriptPromise: Promise<void> | undefined

function loadGoogleIdentityServices(): Promise<void> {
  if (window.google?.accounts.oauth2) return Promise.resolve()
  if (googleScriptPromise) return googleScriptPromise
  const loading = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT}"]`)
    const script = existing ?? document.createElement('script')
    const timeout = window.setTimeout(() => reject(new AppError('OAUTH_SCRIPT', 'Google authentication did not load.')), 15_000)
    script.addEventListener('load', () => {
      window.clearTimeout(timeout)
      window.google?.accounts.oauth2 ? resolve() : reject(new AppError('OAUTH_SCRIPT', 'Google authentication did not initialize.'))
    }, { once: true })
    script.addEventListener('error', () => {
      window.clearTimeout(timeout)
      reject(new AppError('OAUTH_SCRIPT', 'Google authentication could not be loaded.'))
    }, { once: true })
    if (!existing) {
      script.src = GIS_SCRIPT
      script.async = true
      script.defer = true
      document.head.append(script)
    }
  })
  googleScriptPromise = loading.catch((error) => {
    googleScriptPromise = undefined
    document.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT}"]`)?.remove()
    throw error
  })
  return googleScriptPromise
}

export class AuthService {
  private accessToken?: string
  private expiresAt = 0
  private channels: ChannelSummary[] = []

  constructor(
    private readonly store: BrowserStore,
    private readonly clientId: string | undefined
  ) {
    // Start loading early so the eventual Connect button remains a direct user
    // gesture and is not delayed by downloading the GIS library.
    void loadGoogleIdentityServices().catch(() => undefined)
  }

  getAccessToken(): string {
    if (!this.accessToken || Date.now() >= this.expiresAt - 30_000) {
      this.accessToken = undefined
      throw new AppError('AUTH_REQUIRED', 'Your YouTube authorization expired. Reconnect and resume the batch.')
    }
    return this.accessToken
  }

  async connect(): Promise<AuthState> {
    const clientId = this.clientId
    if (!clientId) {
      return { status: 'unconfigured', channels: [], message: 'The site owner must configure VITE_GOOGLE_CLIENT_ID before deploying.' }
    }
    if (!window.google?.accounts.oauth2) await loadGoogleIdentityServices()
    const google = window.google
    if (!google) throw new AppError('OAUTH_SCRIPT', 'Google authentication is unavailable.')

    const response = await new Promise<TokenResponse>((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: SCOPES,
        callback: resolve,
        error_callback: (error) => reject(new AppError('OAUTH_POPUP', error.type === 'popup_closed'
          ? 'The Google sign-in window was closed.'
          : 'Google sign-in could not be completed.'))
      })
      client.requestAccessToken()
    })
    if (response.error || !response.access_token) {
      throw new AppError('OAUTH_DENIED', response.error_description ?? response.error ?? 'Google did not return an access token.')
    }
    this.accessToken = response.access_token
    this.expiresAt = Date.now() + (response.expires_in ?? 3600) * 1000
    this.channels = await this.listChannels()
    return await this.getState()
  }

  async disconnect(): Promise<void> {
    const token = this.accessToken
    this.accessToken = undefined
    this.expiresAt = 0
    this.channels = []
    if (token && window.google?.accounts.oauth2) {
      await Promise.race([
        new Promise<void>((resolve) => window.google!.accounts.oauth2.revoke(token, resolve)),
        new Promise<void>((resolve) => window.setTimeout(resolve, 3_000))
      ])
    }
  }

  async getState(): Promise<AuthState> {
    if (!this.clientId) {
      return { status: 'unconfigured', channels: [], message: 'The site owner must configure VITE_GOOGLE_CLIENT_ID before deploying.' }
    }
    if (!this.accessToken || Date.now() >= this.expiresAt - 30_000) {
      this.accessToken = undefined
      return { status: 'disconnected', channels: [], message: 'Connect your Google account to manage its YouTube channel.' }
    }
    if (!this.channels.length) this.channels = await this.listChannels()
    const settings = this.store.getSettings()
    const selectedChannelId = this.channels.some((channel) => channel.id === settings.selectedChannelId)
      ? settings.selectedChannelId
      : this.channels.length === 1 ? this.channels[0].id : undefined
    return { status: 'connected', channels: structuredClone(this.channels), selectedChannelId }
  }

  private async listChannels(): Promise<ChannelSummary[]> {
    const parameters = new URLSearchParams({ part: 'snippet', mine: 'true', maxResults: '50' })
    let response: Response
    try {
      response = await fetch(`https://www.googleapis.com/youtube/v3/channels?${parameters}`, {
        headers: { Authorization: `Bearer ${this.getAccessToken()}` }
      })
    } catch (error) {
      throw toAppError(error)
    }
    const data = await response.json() as {
      items?: Array<{ id?: string; snippet?: { title?: string; thumbnails?: { default?: { url?: string } } } }>
      error?: { message?: string; errors?: Array<{ reason?: string }> }
    }
    if (!response.ok) {
      throw toAppError({ status: response.status, message: data.error?.message, reason: data.error?.errors?.[0]?.reason })
    }
    return (data.items ?? []).flatMap((channel) => channel.id ? [{
      id: channel.id,
      title: channel.snippet?.title ?? 'YouTube channel',
      thumbnailUrl: channel.snippet?.thumbnails?.default?.url
    }] : [])
  }
}
