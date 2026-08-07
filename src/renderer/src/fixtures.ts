import { generateSchedulePreview } from '../../shared/schedule'
import type {
  AppSettings,
  AuthState,
  BatchItemRecord,
  BatchRecord,
  LiveStreamSummary,
  Locale,
  ScheduleInput,
  SchedulePreview
} from '../../shared/types'

export type FixtureView = 'schedule' | 'review' | 'batch' | 'history' | 'settings'

export interface UiFixture {
  boot: {
    version: string
    platform: string
    arch: string
    settings: AppSettings
    auth: AuthState
    batches: BatchRecord[]
  }
  view: FixtureView
  locale: Locale
  settings: AppSettings
  auth: AuthState
  batches: BatchRecord[]
  form: ScheduleInput
  preview?: SchedulePreview
  activeBatch?: BatchRecord
  globalError?: string
  description?: string
  liveStreams?: LiveStreamSummary[]
}

const channel = {
  id: 'UC-fixture-channel',
  title: 'Atelier vidéo'
}

function batchFromPreview(
  preview: SchedulePreview,
  input: ScheduleInput,
  status: BatchRecord['status'],
  id: string
): BatchRecord {
  const items: BatchItemRecord[] = preview.items.slice(0, 6).map((item, index) => ({
    id: item.id,
    localDate: item.localDate,
    localTime: item.localTime,
    scheduledUtc: item.scheduledUtc,
    session: item.session,
    title: item.title,
    status: status === 'completed'
      ? 'completed'
      : status === 'failed' && index === 2
        ? 'failed'
        : status === 'paused' && index > 1
          ? 'pending'
          : status === 'running'
            ? index < 2 ? 'completed' : index === 2 ? 'running' : 'pending'
            : 'pending',
    step: status === 'running' && index === 2 ? 'broadcast' : undefined,
    broadcastId: status === 'completed' || index < 2 ? `fixture-broadcast-${index}` : undefined,
    streamId: status === 'completed' || index < 3 ? 'fixture-stream' : undefined,
    errorCode: status === 'failed' && index === 2 ? 'NETWORK_ERROR' : undefined,
    errorMessage: status === 'failed' && index === 2 ? 'The network request failed.' : undefined,
    attempts: status === 'failed' && index === 2 ? 3 : 0
  }))
  const completedCount = items.filter((item) => item.status === 'completed').length
  return {
    id,
    createdAt: new Date(Date.now() - 45 * 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    channel,
    status,
    input: structuredClone(input),
    items,
    completedCount,
    failedCount: items.filter((item) => item.status === 'failed').length,
    lastError: status === 'failed' ? 'The network request failed after three retries.' : undefined
  }
}

export function createUiFixture(
  name: string,
  baseForm: ScheduleInput,
  requestedLocale: Locale,
  requestedTheme: AppSettings['theme']
): UiFixture {
  const locale = requestedLocale
  const settings: AppSettings = { locale, theme: requestedTheme, selectedChannelId: channel.id }
  const connected: AuthState = { status: 'connected', channels: [channel], selectedChannelId: channel.id }
  const form: ScheduleInput = {
    ...structuredClone(baseForm),
    cadence: 'weekdays',
    periods: name === 'large' ? 5 : 3,
    weekdays: [1, 3, 5],
    startTimes: ['09:30', '18:00'],
    titleTemplate: locale === 'fr'
      ? 'Session {session} — {date} à {time}'
      : 'Session {session} — {date} at {time}',
    descriptionTemplate: locale === 'fr'
      ? 'Bienvenue à la session {session}.\n\nRendez-vous le {date} à {time}.\n\nPréparez vos questions et votre matériel avant le direct.'
      : 'Welcome to session {session}.\n\nJoin us on {date} at {time}.\n\nPlease prepare your questions and equipment before the broadcast.',
    privacy: 'unlisted',
    streamKeyMode: 'existing',
    existingStreamId: 'fixture-stream',
    autoStart: true,
    autoStop: true
  }
  const preview = generateSchedulePreview(form)
  const completed = batchFromPreview(preview, form, 'completed', 'fixture-completed')
  const failed = batchFromPreview(preview, form, 'failed', 'fixture-failed')
  failed.createdAt = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
  const paused = batchFromPreview(preview, form, 'paused', 'fixture-paused')
  paused.createdAt = new Date(Date.now() - 3 * 24 * 60 * 60_000).toISOString()
  const batches = [completed, failed, paused]

  const fixture: UiFixture = {
    boot: { version: '0.1.0', platform: 'win32', arch: 'arm64', settings, auth: connected, batches },
    view: 'schedule',
    locale,
    settings,
    auth: connected,
    batches,
    form,
    liveStreams: [{ id: 'fixture-stream', title: 'Atelier vidéo — default' }]
  }

  if (name === 'auth') {
    fixture.auth = { status: 'unconfigured', channels: [] }
    fixture.boot.auth = fixture.auth
  } else if (name === 'reconnect') {
    fixture.auth = { status: 'disconnected', channels: [], message: 'Connect your Google account to manage its YouTube channel.' }
    fixture.boot.auth = fixture.auth
  } else if (name === 'review' || name === 'description' || name === 'large') {
    fixture.view = 'review'
    fixture.preview = preview
    if (name === 'description') fixture.description = preview.items[0]?.description
  } else if (name === 'progress') {
    fixture.view = 'batch'
    fixture.activeBatch = batchFromPreview(preview, form, 'running', 'fixture-running')
  } else if (name === 'success') {
    fixture.view = 'batch'
    fixture.activeBatch = completed
  } else if (name === 'history') {
    fixture.view = 'history'
  } else if (name === 'settings') {
    fixture.view = 'settings'
  } else if (name === 'error') {
    fixture.globalError = locale === 'fr'
      ? 'La connexion à YouTube a expiré. Reconnectez votre compte pour continuer.'
      : 'Your YouTube authorization expired. Reconnect your account to continue.'
  }
  return fixture
}
