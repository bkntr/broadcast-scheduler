export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false
  ) {
    super(message)
    this.name = 'AppError'
  }
}

interface GoogleApiError {
  status?: number
  code?: string | number
  message?: string
  reason?: string
}

export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  const candidate = error as GoogleApiError
  const status = candidate.status
  const reason = candidate.reason
  const message = candidate.message ?? 'Unexpected error'

  if (status === 401 || reason === 'authError' || /invalid_grant/i.test(message)) {
    return new AppError('AUTH_REQUIRED', 'Your YouTube authorization expired. Reconnect and resume the batch.')
  }
  if (reason === 'quotaExceeded' || reason === 'dailyLimitExceeded') {
    return new AppError('QUOTA_EXCEEDED', 'The YouTube API quota is exhausted. Resume after the quota resets.')
  }
  if (status === 403) return new AppError(reason ?? 'FORBIDDEN', message)
  if (status === 429) return new AppError('RATE_LIMITED', message, true)
  if (status && status >= 500) return new AppError(`YOUTUBE_${status}`, message, true)
  if (candidate.code === 'NETWORK_ERROR' || error instanceof TypeError) {
    return new AppError('NETWORK_ERROR', 'The network request failed.', true)
  }
  return new AppError(String(candidate.code ?? 'UNEXPECTED'), message)
}
