import type { AppSettings, BatchRecord } from '../shared/types'
import { DEFAULT_SETTINGS } from '../shared/types'
import { settingsSchema } from '../shared/schemas'

interface PersistedState {
  version: 1
  settings: AppSettings
  batches: BatchRecord[]
  channelStreams: Record<string, string>
}

const DATABASE_NAME = 'youtube-scheduler'
const STORE_NAME = 'app-data'
const STATE_KEY = 'state'
const THUMBNAIL_PREFIX = 'thumbnail:'

function defaultState(): PersistedState {
  return {
    version: 1,
    settings: structuredClone(DEFAULT_SETTINGS),
    batches: [],
    channelStreams: {}
  }
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), { once: true })
    request.addEventListener('error', () => reject(request.error ?? new Error('Browser storage failed.')), { once: true })
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true })
    transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('Browser storage was aborted.')), { once: true })
    transaction.addEventListener('error', () => reject(transaction.error ?? new Error('Browser storage failed.')), { once: true })
  })
}

async function openDatabase(): Promise<IDBDatabase> {
  if (!('indexedDB' in globalThis)) throw new Error('This browser does not support IndexedDB.')
  const request = indexedDB.open(DATABASE_NAME, 1)
  request.addEventListener('upgradeneeded', () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME)
  })
  return await requestResult(request)
}

export class BrowserStore {
  private state = defaultState()
  private database?: IDBDatabase
  private persistQueue: Promise<void> = Promise.resolve()

  async load(): Promise<void> {
    this.database = await openDatabase()
    const raw = await this.get<Partial<PersistedState>>(STATE_KEY).catch(() => undefined)
    const settings = settingsSchema.safeParse(raw?.settings)
    const locale = navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en'
    this.state = {
      version: 1,
      settings: settings.success ? settings.data : { ...structuredClone(DEFAULT_SETTINGS), locale },
      batches: Array.isArray(raw?.batches) ? raw.batches.slice(0, 30) : [],
      channelStreams: raw?.channelStreams && typeof raw.channelStreams === 'object' ? raw.channelStreams : {}
    }

    let recovered = false
    for (const batch of this.state.batches) {
      if (batch.status !== 'running') continue
      recovered = true
      batch.status = 'paused'
      batch.lastError = 'The browser was closed or refreshed while this batch was running. Reconnect and resume it.'
      for (const item of batch.items) {
        if (item.status === 'running') item.status = 'pending'
      }
    }
    if (recovered) await this.persist()
  }

  getSettings(): AppSettings {
    return structuredClone(this.state.settings)
  }

  async setSettings(settings: AppSettings): Promise<AppSettings> {
    this.state.settings = settingsSchema.parse(settings)
    await this.persist()
    return this.getSettings()
  }

  listBatches(): BatchRecord[] {
    return structuredClone(this.state.batches)
  }

  getBatch(id: string): BatchRecord | undefined {
    const batch = this.state.batches.find((candidate) => candidate.id === id)
    return batch ? structuredClone(batch) : undefined
  }

  async putBatch(batch: BatchRecord): Promise<void> {
    const existing = this.state.batches.findIndex((candidate) => candidate.id === batch.id)
    if (existing >= 0) this.state.batches.splice(existing, 1)
    this.state.batches.unshift(structuredClone(batch))
    this.state.batches = this.state.batches.slice(0, 30)
    await this.persist()
  }

  async clearHistory(): Promise<void> {
    this.state.batches = []
    await this.persist()
  }

  getChannelStream(channelId: string): string | undefined {
    return this.state.channelStreams[channelId]
  }

  async setChannelStream(channelId: string, streamId: string): Promise<void> {
    this.state.channelStreams[channelId] = streamId
    await this.persist()
  }

  async clearChannelStream(channelId: string): Promise<void> {
    delete this.state.channelStreams[channelId]
    await this.persist()
  }

  async saveThumbnail(reference: string, blob: Blob): Promise<void> {
    await this.set(`${THUMBNAIL_PREFIX}${reference}`, blob)
  }

  async loadThumbnail(reference: string): Promise<Blob | undefined> {
    return await this.get<Blob>(`${THUMBNAIL_PREFIX}${reference}`).catch(() => undefined)
  }

  async deleteThumbnail(reference: string): Promise<void> {
    await this.delete(`${THUMBNAIL_PREFIX}${reference}`)
  }

  private async persist(): Promise<void> {
    const snapshot = structuredClone(this.state)
    this.persistQueue = this.persistQueue.catch(() => undefined).then(() => this.set(STATE_KEY, snapshot))
    await this.persistQueue
  }

  private async get<T>(key: string): Promise<T | undefined> {
    if (!this.database) throw new Error('Browser storage is not initialized.')
    const transaction = this.database.transaction(STORE_NAME, 'readonly')
    return await requestResult(transaction.objectStore(STORE_NAME).get(key)) as T | undefined
  }

  private async set(key: string, value: unknown): Promise<void> {
    if (!this.database) throw new Error('Browser storage is not initialized.')
    const transaction = this.database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(value, key)
    await transactionDone(transaction)
  }

  private async delete(key: string): Promise<void> {
    if (!this.database) throw new Error('Browser storage is not initialized.')
    const transaction = this.database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).delete(key)
    await transactionDone(transaction)
  }
}
