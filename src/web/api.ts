import packageJson from '../../package.json'
import { batchStartSchema, settingsSchema } from '../shared/schemas'
import type {
  AppSettings,
  AuthState,
  BatchRecord,
  ChannelSummary,
  PlaylistSummary,
  ProgressEvent,
  ScheduleInput,
  ThumbnailInfo
} from '../shared/types'
import { AuthService } from './auth'
import { AppError } from './errors'
import { configuredOAuthClientId } from './oauth-config'
import { SchedulerService } from './scheduler'
import { BrowserStore } from './storage'
import { YouTubeService } from './youtube'

const MAX_FILE_SIZE = 2_000_000
const ALLOWED_EXTERNAL_HOSTS = new Set([
  'console.cloud.google.com',
  'github.com',
  'studio.youtube.com',
  'www.youtube.com'
])

function chooseFile(accept: string): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.addEventListener('change', () => resolve(input.files?.[0]), { once: true })
    input.addEventListener('cancel', () => resolve(undefined), { once: true })
    input.click()
  })
}

function dataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.addEventListener('load', () => resolve(String(reader.result)), { once: true })
    reader.addEventListener('error', () => reject(reader.error ?? new Error('Could not read the image.')), { once: true })
    reader.readAsDataURL(file)
  })
}

async function validateThumbnail(file: File, store: BrowserStore): Promise<ThumbnailInfo> {
  if (file.size > MAX_FILE_SIZE) throw new AppError('THUMBNAIL_SIZE', 'Thumbnail must not exceed 2 MB.')
  const bytes = new Uint8Array(await file.slice(0, 8).arrayBuffer())
  const png = bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    .every((value, index) => bytes[index] === value)
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
  if (!png && !jpeg) throw new AppError('THUMBNAIL_FORMAT', 'Thumbnail must be a valid PNG or JPEG file.')
  const mimeType = png ? 'image/png' : 'image/jpeg'
  const reference = crypto.randomUUID()
  const blob = file.slice(0, file.size, mimeType)
  await store.saveThumbnail(reference, blob)
  return { path: reference, name: file.name, size: file.size, dataUrl: await dataUrl(blob) }
}

function selectedChannel(state: AuthState): ChannelSummary {
  if (state.status !== 'connected') throw new AppError('AUTH_REQUIRED', 'Connect a YouTube account first.')
  const channel = state.channels.find((candidate) => candidate.id === state.selectedChannelId)
  if (!channel) throw new AppError('CHANNEL_REQUIRED', 'Select the YouTube channel to schedule on.')
  return channel
}

export interface WebApi {
  bootstrap(): Promise<{
    version: string
    platform: string
    arch: string
    settings: AppSettings
    auth: AuthState
    batches: BatchRecord[]
  }>
  settings: { save(settings: AppSettings): Promise<AppSettings> }
  auth: {
    connect(): Promise<AuthState>
    state(): Promise<AuthState>
    selectChannel(channelId: string): Promise<AuthState>
    disconnect(): Promise<void>
  }
  youtube: { playlists(): Promise<PlaylistSummary[]> }
  thumbnail: {
    choose(): Promise<ThumbnailInfo | undefined>
    remove(reference: string): Promise<void>
    onDrop(callback: (result: { thumbnail?: ThumbnailInfo; error?: string }) => void): () => void
  }
  batches: {
    start(input: ScheduleInput, excludedIds: string[]): Promise<BatchRecord>
    resume(batchId: string): Promise<BatchRecord>
    stop(): Promise<void>
    list(): Promise<BatchRecord[]>
    clearHistory(): Promise<void>
    streamKey(batchId: string, streamId?: string): Promise<string>
  }
  clipboard: { write(text: string): Promise<void> }
  external: { open(url: string): Promise<void> }
  diagnostics: { copy(): Promise<boolean> }
  onProgress(callback: (event: ProgressEvent) => void): () => void
}

export function installWebApi(): void {
  const store = new BrowserStore()
  const auth = new AuthService(store, configuredOAuthClientId(import.meta.env.VITE_GOOGLE_CLIENT_ID))
  const youtube = new YouTubeService(auth, store)
  const scheduler = new SchedulerService(store, youtube)
  let initialized: Promise<void> | undefined
  const initialize = (): Promise<void> => initialized ??= store.load()

  window.addEventListener('beforeunload', (event) => {
    if (!scheduler.isRunning()) return
    event.preventDefault()
    event.returnValue = ''
  })

  const api: WebApi = {
    bootstrap: async () => {
      await initialize()
      return {
        version: packageJson.version,
        platform: 'web',
        arch: navigator.userAgentData?.platform ?? navigator.platform ?? 'browser',
        settings: store.getSettings(),
        auth: await auth.getState(),
        batches: store.listBatches()
      }
    },
    settings: {
      save: async (settings) => {
        await initialize()
        return await store.setSettings(settingsSchema.parse(settings))
      }
    },
    auth: {
      connect: async () => {
        await initialize()
        const state = await auth.connect()
        if (state.status === 'connected' && state.channels.length === 1) {
          const settings = store.getSettings()
          settings.selectedChannelId = state.channels[0].id
          await store.setSettings(settings)
          state.selectedChannelId = state.channels[0].id
        }
        return state
      },
      state: async () => {
        await initialize()
        return await auth.getState()
      },
      selectChannel: async (channelId) => {
        await initialize()
        const state = await auth.getState()
        if (!state.channels.some((channel) => channel.id === channelId)) {
          throw new AppError('CHANNEL_INVALID', 'That channel is not available.')
        }
        const settings = store.getSettings()
        settings.selectedChannelId = channelId
        await store.setSettings(settings)
        state.selectedChannelId = channelId
        return state
      },
      disconnect: async () => {
        await initialize()
        await auth.disconnect()
        const settings = store.getSettings()
        delete settings.selectedChannelId
        await store.setSettings(settings)
      }
    },
    youtube: {
      playlists: async () => {
        await initialize()
        return await youtube.playlists()
      }
    },
    thumbnail: {
      choose: async () => {
        await initialize()
        const file = await chooseFile('.png,.jpg,.jpeg,image/png,image/jpeg')
        return file ? await validateThumbnail(file, store) : undefined
      },
      remove: async (reference) => {
        await initialize()
        await store.deleteThumbnail(reference)
      },
      onDrop: (callback) => {
        const dragover = (event: DragEvent): void => {
          if ((event.target as Element | null)?.closest('[data-thumbnail-drop]')) event.preventDefault()
        }
        const drop = (event: DragEvent): void => {
          if (!(event.target as Element | null)?.closest('[data-thumbnail-drop]')) return
          event.preventDefault()
          const file = event.dataTransfer?.files[0]
          if (!file) return
          void initialize()
            .then(() => validateThumbnail(file, store))
            .then((thumbnail) => callback({ thumbnail }))
            .catch((error: unknown) => callback({ error: error instanceof Error ? error.message : String(error) }))
        }
        window.addEventListener('dragover', dragover)
        window.addEventListener('drop', drop)
        return () => {
          window.removeEventListener('dragover', dragover)
          window.removeEventListener('drop', drop)
        }
      }
    },
    batches: {
      start: async (rawInput, excludedIds) => {
        await initialize()
        const request = batchStartSchema.parse({ input: rawInput, excludedIds })
        const channel = selectedChannel(await auth.getState())
        const settings = store.getSettings()
        const { startDate: _startDate, thumbnailPath: _thumbnailPath, rotateStreamKey: _rotateStreamKey, ...remembered } = request.input
        settings.lastSchedule = remembered
        await store.setSettings(settings)
        return await scheduler.start(request.input, request.excludedIds, channel)
      },
      resume: async (batchId) => {
        await initialize()
        auth.getAccessToken()
        return await scheduler.resume(batchId)
      },
      stop: async () => scheduler.requestStop(),
      list: async () => {
        await initialize()
        return store.listBatches()
      },
      clearHistory: async () => {
        await initialize()
        if (scheduler.isRunning()) throw new AppError('BATCH_RUNNING', 'Stop the active batch before clearing history.')
        await store.clearHistory()
      },
      streamKey: async (batchId, streamId) => {
        await initialize()
        return await scheduler.streamKey(batchId, streamId)
      }
    },
    clipboard: {
      write: async (text) => navigator.clipboard.writeText(text)
    },
    external: {
      open: async (url) => {
        const parsed = new URL(url)
        if (parsed.protocol !== 'https:' || !ALLOWED_EXTERNAL_HOSTS.has(parsed.hostname)) {
          throw new AppError('URL_BLOCKED', 'This external URL is not allowed.')
        }
        window.open(parsed.toString(), '_blank', 'noopener,noreferrer')
      }
    },
    diagnostics: {
      copy: async () => {
        await navigator.clipboard.writeText([
          `Broadcast Scheduler ${packageJson.version}`,
          `Platform: ${navigator.userAgentData?.platform ?? navigator.platform ?? 'browser'}`,
          `Browser: ${navigator.userAgent}`
        ].join('\n'))
        return true
      }
    },
    onProgress: (callback) => scheduler.onProgress(callback)
  }

  window.desktop = api
}

declare global {
  interface Navigator {
    userAgentData?: { platform?: string }
  }

  interface Window {
    desktop: WebApi
  }
}
