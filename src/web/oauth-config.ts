import { AppError } from './errors'

export function configuredOAuthClientId(rawValue: string | undefined): string | undefined {
  const clientId = rawValue?.trim()
  if (!clientId) return undefined
  if (clientId.length > 500 || !clientId.endsWith('.apps.googleusercontent.com')) {
    throw new AppError(
      'OAUTH_CONFIG_INVALID',
      'VITE_GOOGLE_CLIENT_ID must be the client ID from a Google Web application OAuth client.'
    )
  }
  return clientId
}
