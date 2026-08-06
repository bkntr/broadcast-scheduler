import { generateSchedulePreview } from '../shared/schedule'
import type {
  BatchItemRecord,
  BatchRecord,
  ChannelSummary,
  ProgressEvent,
  ScheduleInput,
  StreamKeyMode
} from '../shared/types'
import { AppError, toAppError } from './errors'
import type { BrowserStore } from './storage'
import type { YouTubeService } from './youtube'

const RETRY_DELAYS_MS = [1_000, 3_000, 8_000]

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds))
}

function streamKeyMode(input: ScheduleInput): StreamKeyMode {
  const legacy = input as ScheduleInput & {
    sharedStreamKey?: boolean
    rotateStreamKey?: boolean
  }
  return input.streamKeyMode
    ?? (legacy.sharedStreamKey === false ? 'broadcast' : legacy.rotateStreamKey ? 'batch' : 'existing')
}

export class SchedulerService {
  private activeBatchId?: string
  private stopRequested = false
  private readonly listeners = new Set<(event: ProgressEvent) => void>()
  private readonly sessionStreamKeys = new Map<string, Map<string, string>>()

  constructor(
    private readonly store: BrowserStore,
    private readonly youtube: YouTubeService
  ) {}

  onProgress(callback: (event: ProgressEvent) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  isRunning(): boolean {
    return Boolean(this.activeBatchId)
  }

  async start(input: ScheduleInput, excludedIds: string[], channel: ChannelSummary): Promise<BatchRecord> {
    if (this.activeBatchId) throw new AppError('BATCH_RUNNING', 'Another batch is already running.')
    if (streamKeyMode(input) === 'existing' && !input.existingStreamId) {
      throw new AppError('STREAM_REQUIRED', 'Choose an existing stream key or create a new one.')
    }
    const excluded = new Set(excludedIds)
    const preview = generateSchedulePreview(input, excluded)
    if (preview.errors.length) throw new AppError('INVALID_SCHEDULE', preview.errors.join(' '))
    const included = preview.items.filter((item) => item.included)
    if (!included.length) throw new AppError('EMPTY_SCHEDULE', 'Include at least one broadcast.')
    const invalid = included.find((item) => item.issues.some((issue) => issue.severity === 'error'))
    if (invalid) throw new AppError('INVALID_OCCURRENCE', invalid.issues.map((issue) => issue.message).join(' '))

    const now = new Date().toISOString()
    const batch: BatchRecord = {
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
      channel,
      status: 'pending',
      input,
      items: included.map((item): BatchItemRecord => ({
        id: item.id,
        localDate: item.localDate,
        localTime: item.localTime,
        scheduledUtc: item.scheduledUtc,
        session: item.session,
        title: item.title,
        status: 'pending',
        attempts: 0
      })),
      completedCount: 0,
      failedCount: 0
    }
    await this.store.putBatch(batch)
    void this.run(batch.id)
    return batch
  }

  async resume(batchId: string): Promise<BatchRecord> {
    if (this.activeBatchId) throw new AppError('BATCH_RUNNING', 'Another batch is already running.')
    const batch = this.store.getBatch(batchId)
    if (!batch) throw new AppError('BATCH_NOT_FOUND', 'Scheduling batch was not found.')
    if (batch.status === 'completed') return batch
    for (const item of batch.items) {
      if (item.status === 'failed' || item.status === 'running') item.status = 'pending'
    }
    batch.status = 'pending'
    batch.failedCount = 0
    batch.lastError = undefined
    await this.store.putBatch(batch)
    void this.run(batch.id)
    return batch
  }

  requestStop(): void {
    if (this.activeBatchId) this.stopRequested = true
  }

  async streamKey(batchId: string, requestedStreamId?: string): Promise<string> {
    const batch = this.store.getBatch(batchId)
    const streamId = requestedStreamId ?? batch?.items.find((item) => item.streamId)?.streamId
    if (!streamId) throw new AppError('STREAM_KEY_UNAVAILABLE', 'This batch does not have a stream yet.')
    const inMemory = this.sessionStreamKeys.get(batchId)?.get(streamId)
    if (inMemory) return inMemory
    const key = await this.youtube.retrieveStreamKey(streamId)
    this.rememberStreamKey(batchId, streamId, key)
    return key
  }

  private async run(batchId: string): Promise<void> {
    this.activeBatchId = batchId
    this.stopRequested = false
    const batch = this.store.getBatch(batchId)
    if (!batch) {
      this.activeBatchId = undefined
      return
    }
    batch.status = 'running'
    await this.saveAndEmit(batch)

    try {
      let shared: { streamId: string; streamKey: string } | undefined
      const mode = streamKeyMode(batch.input)
      if (mode !== 'broadcast') {
        const existingStreamId = batch.items.find((item) => item.streamId)?.streamId
        if (existingStreamId) {
          shared = {
            streamId: existingStreamId,
            streamKey: await this.retry('shared-stream', () => this.youtube.retrieveStreamKey(existingStreamId))
          }
        } else if (mode === 'existing' && batch.input.existingStreamId) {
          const streamId = batch.input.existingStreamId
          shared = {
            streamId,
            streamKey: await this.retry('shared-stream', () => this.youtube.retrieveStreamKey(streamId))
          }
        } else {
          shared = await this.retry('shared-stream', () =>
            this.youtube.getOrCreateSharedStream(batch.channel, mode === 'batch', batch.id))
        }
        this.rememberStreamKey(batch.id, shared.streamId, shared.streamKey)
      }

      for (const item of batch.items) {
        if (item.status === 'completed') continue
        if (this.stopRequested) {
          batch.status = 'paused'
          break
        }
        await this.runItem(batch, item, shared)
        if (this.stopRequested) {
          batch.status = 'paused'
          break
        }
      }
      if (batch.items.every((item) => item.status === 'completed')) batch.status = 'completed'
      else if (batch.status === 'running') batch.status = 'paused'
    } catch (error) {
      const appError = toAppError(error)
      batch.status = 'failed'
      batch.lastError = appError.message
    } finally {
      batch.completedCount = batch.items.filter((item) => item.status === 'completed').length
      batch.failedCount = batch.items.filter((item) => item.status === 'failed').length
      await this.saveAndEmit(batch)
      this.activeBatchId = undefined
      this.stopRequested = false
    }
  }

  private async runItem(
    batch: BatchRecord,
    item: BatchItemRecord,
    shared?: { streamId: string; streamKey: string }
  ): Promise<void> {
    const previewItem = generateSchedulePreview(batch.input).items.find((candidate) => candidate.id === item.id)
    if (!previewItem) throw new AppError('OCCURRENCE_MISSING', 'Could not reconstruct this scheduled occurrence.')
    item.status = 'running'
    item.errorCode = undefined
    item.errorMessage = undefined
    await this.saveAndEmit(batch)

    try {
      if (!item.streamId) {
        item.step = 'stream'
        if (shared) {
          item.streamId = shared.streamId
        } else {
          const stream = await this.retry('item-stream', () =>
            this.youtube.createItemStream(`${batch.id.slice(0, 8)} — ${item.session}`))
          item.streamId = stream.streamId
          this.rememberStreamKey(batch.id, stream.streamId, stream.streamKey)
        }
        await this.saveAndEmit(batch)
      }

      if (!item.broadcastId) {
        item.step = 'broadcast'
        item.broadcastId = await this.retry('broadcast', () => this.youtube.createBroadcast({
          input: batch.input,
          title: item.title,
          description: previewItem.description,
          scheduledUtc: item.scheduledUtc
        }))
        await this.saveAndEmit(batch)
      }

      if (batch.input.privacy === 'public-at-start') {
        item.step = 'visibility'
        await this.retry('visibility', () => this.youtube.schedulePublicAtStart(item.broadcastId!, item.scheduledUtc))
        await this.saveAndEmit(batch)
      }

      item.step = 'bind'
      await this.retry('bind', () => this.youtube.bindBroadcast(item.broadcastId!, item.streamId!))
      await this.saveAndEmit(batch)

      if (batch.input.thumbnailPath) {
        item.step = 'thumbnail'
        await this.retry('thumbnail', () => this.youtube.uploadThumbnail(item.broadcastId!, batch.input.thumbnailPath!))
        await this.saveAndEmit(batch)
      }

      const playlistId = batch.input.playlistId === '__custom__'
        ? batch.input.customPlaylistId
        : batch.input.playlistId
      if (playlistId && !item.playlistItemId) {
        item.step = 'playlist'
        item.playlistItemId = await this.retry('playlist', () => this.youtube.addToPlaylist(item.broadcastId!, playlistId))
        await this.saveAndEmit(batch)
      }

      item.status = 'completed'
      item.step = undefined
      await this.saveAndEmit(batch)
    } catch (error) {
      const appError = toAppError(error)
      item.status = 'failed'
      item.errorCode = appError.code
      item.errorMessage = appError.message
      await this.saveAndEmit(batch)
      throw appError
    }
  }

  private async retry<T>(operation: string, task: () => Promise<T>): Promise<T> {
    let failure: AppError | undefined
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
      try {
        return await task()
      } catch (error) {
        failure = toAppError(error)
        if (!failure.retryable || attempt === RETRY_DELAYS_MS.length) throw failure
        const milliseconds = RETRY_DELAYS_MS[attempt]
        const batch = this.store.getBatch(this.activeBatchId ?? '')
        if (batch) this.emit({ batch, message: `Retrying ${operation}`, retryInSeconds: Math.ceil(milliseconds / 1000) })
        await delay(milliseconds)
      }
    }
    throw failure ?? new AppError('RETRY_FAILED', 'Operation failed after retries.')
  }

  private async saveAndEmit(batch: BatchRecord): Promise<void> {
    batch.updatedAt = new Date().toISOString()
    batch.completedCount = batch.items.filter((item) => item.status === 'completed').length
    batch.failedCount = batch.items.filter((item) => item.status === 'failed').length
    await this.store.putBatch(batch)
    this.emit({ batch: structuredClone(batch) })
  }

  private emit(event: ProgressEvent): void {
    for (const listener of this.listeners) listener(event)
  }

  private rememberStreamKey(batchId: string, streamId: string, streamKey: string): void {
    const keys = this.sessionStreamKeys.get(batchId) ?? new Map<string, string>()
    keys.set(streamId, streamKey)
    this.sessionStreamKeys.set(batchId, keys)
  }
}
