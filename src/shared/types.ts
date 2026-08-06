export type Locale = 'en' | 'fr'
export type Cadence = 'daily' | 'weekly' | 'weekdays'
export type Privacy = 'private' | 'unlisted' | 'public' | 'public-at-start'
export type DateStyle = 'short' | 'medium' | 'long'
export type TimeStyle = '24h' | '12h'
export type BatchStatus = 'pending' | 'running' | 'paused' | 'failed' | 'completed'
export type ItemStatus = 'pending' | 'running' | 'failed' | 'completed'

export interface ChannelSummary {
  id: string
  title: string
  thumbnailUrl?: string
}

export interface PlaylistSummary {
  id: string
  title: string
}

export interface AuthState {
  status: 'disconnected' | 'connected' | 'reauth-required' | 'unconfigured'
  channels: ChannelSummary[]
  selectedChannelId?: string
  message?: string
}

export interface ScheduleInput {
  cadence: Cadence
  periods: number
  startDate: string
  startTimes: string[]
  weekdays: number[]
  timeZone: string
  locale: Locale
  dateStyle: DateStyle
  timeStyle: TimeStyle
  titleTemplate: string
  descriptionTemplate: string
  startingSession: number
  privacy: Privacy
  playlistId?: string
  customPlaylistId?: string
  thumbnailPath?: string
  sharedStreamKey: boolean
  rotateStreamKey: boolean
  autoStart: boolean
  autoStop: boolean
  madeForKids: boolean
}

export interface PreviewIssue {
  code:
    | 'past'
    | 'nonexistent-time'
    | 'ambiguous-time'
    | 'title-too-long'
    | 'description-too-long'
    | 'unknown-placeholder'
  severity: 'error' | 'warning'
  message: string
}

export interface PreviewItem {
  id: string
  localDate: string
  localTime: string
  scheduledUtc: string
  timezoneOffset: string
  session: number
  title: string
  description: string
  included: boolean
  issues: PreviewIssue[]
}

export interface SchedulePreview {
  items: PreviewItem[]
  errors: string[]
  operationCount: number
}

export interface BatchItemRecord {
  id: string
  localDate: string
  localTime: string
  scheduledUtc: string
  session: number
  title: string
  status: ItemStatus
  step?: 'stream' | 'broadcast' | 'visibility' | 'bind' | 'thumbnail' | 'playlist'
  broadcastId?: string
  streamId?: string
  playlistItemId?: string
  errorCode?: string
  errorMessage?: string
  attempts: number
}

export interface BatchRecord {
  id: string
  createdAt: string
  updatedAt: string
  channel: ChannelSummary
  status: BatchStatus
  input: ScheduleInput
  items: BatchItemRecord[]
  completedCount: number
  failedCount: number
  stopRequested?: boolean
  lastError?: string
}

export interface AppSettings {
  locale: Locale
  theme: 'system' | 'light' | 'dark'
  selectedChannelId?: string
  lastSchedule?: Partial<ScheduleInput>
}

export interface ThumbnailInfo {
  path: string
  name: string
  size: number
  dataUrl: string
}

export interface ProgressEvent {
  batch: BatchRecord
  message?: string
  retryInSeconds?: number
}

export const DEFAULT_SETTINGS: AppSettings = {
  locale: 'en',
  theme: 'system'
}
