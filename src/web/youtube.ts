import type { ChannelSummary, PlaylistSummary, ScheduleInput } from '../shared/types'
import type { AuthService } from './auth'
import { AppError, toAppError } from './errors'
import type { BrowserStore } from './storage'

interface ApiErrorBody {
  error?: { message?: string; errors?: Array<{ reason?: string }> }
}

interface ListResponse<T> extends ApiErrorBody {
  items?: T[]
  nextPageToken?: string
}

export class YouTubeService {
  constructor(
    private readonly auth: AuthService,
    private readonly store: BrowserStore
  ) {}

  async playlists(): Promise<PlaylistSummary[]> {
    const result: PlaylistSummary[] = []
    let pageToken: string | undefined
    do {
      const response = await this.request<ListResponse<{ id?: string; snippet?: { title?: string } }>>('playlists', {
        part: 'snippet', mine: 'true', maxResults: '50', pageToken
      })
      result.push(...(response.items ?? []).flatMap((item) => item.id
        ? [{ id: item.id, title: item.snippet?.title ?? item.id }]
        : []))
      pageToken = response.nextPageToken
    } while (pageToken)
    return result.sort((left, right) => left.title.localeCompare(right.title))
  }

  async getOrCreateSharedStream(
    channel: ChannelSummary,
    rotate: boolean,
    batchId: string
  ): Promise<{ streamId: string; streamKey: string }> {
    const savedId = rotate ? undefined : this.store.getChannelStream(channel.id)
    if (savedId) {
      const response = await this.request<ListResponse<{
        id?: string
        cdn?: { ingestionInfo?: { streamName?: string } }
      }>>('liveStreams', { part: 'id,cdn', id: savedId })
      const existing = response.items?.[0]
      const streamKey = existing?.cdn?.ingestionInfo?.streamName
      if (existing?.id && streamKey) return { streamId: existing.id, streamKey }
      await this.store.clearChannelStream(channel.id)
    }

    const title = rotate
      ? `YouTube Scheduler — ${channel.title} — ${batchId.slice(0, 8)}`
      : `YouTube Scheduler — ${channel.title}`
    const created = await this.createStream(title, 'Reusable stream managed by YouTube Scheduler.', true)
    await this.store.setChannelStream(channel.id, created.streamId)
    return created
  }

  async createItemStream(identifier: string): Promise<{ streamId: string; streamKey: string }> {
    const title = `YouTube Scheduler — ${identifier}`
    return await this.findRecentStream(title)
      ?? await this.createStream(title, 'Stream managed by YouTube Scheduler.', true)
  }

  async retrieveStreamKey(streamId: string): Promise<string> {
    const response = await this.request<ListResponse<{
      cdn?: { ingestionInfo?: { streamName?: string } }
    }>>('liveStreams', { part: 'cdn', id: streamId })
    const key = response.items?.[0]?.cdn?.ingestionInfo?.streamName
    if (!key) throw new AppError('STREAM_KEY_UNAVAILABLE', 'YouTube did not return a stream key.')
    return key
  }

  async createBroadcast(args: {
    input: ScheduleInput
    title: string
    description: string
    scheduledUtc: string
  }): Promise<string> {
    const existing = await this.findBroadcast(args.title, args.scheduledUtc)
    if (existing) return existing
    const privacyStatus = args.input.privacy === 'public-at-start' ? 'private' : args.input.privacy
    const response = await this.request<{ id?: string }>('liveBroadcasts', {
      part: 'snippet,status,contentDetails'
    }, 'POST', {
      snippet: {
        title: args.title,
        description: args.description,
        scheduledStartTime: args.scheduledUtc
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: args.input.madeForKids
      },
      contentDetails: {
        enableAutoStart: args.input.autoStart,
        enableAutoStop: args.input.autoStop,
        enableDvr: true
      }
    })
    if (!response.id) throw new AppError('BROADCAST_ID_MISSING', 'YouTube created a broadcast without returning its ID.')
    return response.id
  }

  async schedulePublicAtStart(broadcastId: string, scheduledUtc: string): Promise<void> {
    await this.request('videos', { part: 'status' }, 'PUT', {
      id: broadcastId,
      status: { privacyStatus: 'private', publishAt: scheduledUtc }
    })
  }

  async bindBroadcast(broadcastId: string, streamId: string): Promise<void> {
    await this.request('liveBroadcasts/bind', {
      part: 'id,contentDetails', id: broadcastId, streamId
    }, 'POST')
  }

  async uploadThumbnail(broadcastId: string, reference: string): Promise<void> {
    const blob = await this.store.loadThumbnail(reference)
    if (!blob) throw new AppError('THUMBNAIL_MISSING', 'The selected thumbnail is no longer available in this browser.')
    const parameters = new URLSearchParams({ videoId: broadcastId, uploadType: 'media' })
    await this.fetchJson(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?${parameters}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.auth.getAccessToken()}`,
        'Content-Type': blob.type || 'application/octet-stream'
      },
      body: blob
    })
  }

  async addToPlaylist(broadcastId: string, playlistId: string): Promise<string | undefined> {
    const existing = await this.request<ListResponse<{ id?: string }>>('playlistItems', {
      part: 'id', playlistId, videoId: broadcastId, maxResults: '1'
    })
    if (existing.items?.[0]?.id) return existing.items[0].id
    const response = await this.request<{ id?: string }>('playlistItems', { part: 'snippet' }, 'POST', {
      snippet: {
        playlistId,
        resourceId: { kind: 'youtube#video', videoId: broadcastId }
      }
    })
    return response.id
  }

  private async createStream(
    title: string,
    description: string,
    reusable: boolean
  ): Promise<{ streamId: string; streamKey: string }> {
    const response = await this.request<{
      id?: string
      cdn?: { ingestionInfo?: { streamName?: string } }
    }>('liveStreams', { part: 'snippet,cdn,contentDetails,status' }, 'POST', {
      snippet: { title, description },
      cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
      contentDetails: { isReusable: reusable }
    })
    const streamId = response.id
    const streamKey = response.cdn?.ingestionInfo?.streamName
    if (!streamId || !streamKey) throw new AppError('STREAM_DETAILS_MISSING', 'YouTube did not return complete stream details.')
    return { streamId, streamKey }
  }

  private async findBroadcast(title: string, scheduledUtc: string): Promise<string | undefined> {
    let pageToken: string | undefined
    do {
      const response = await this.request<ListResponse<{
        id?: string
        snippet?: { title?: string; scheduledStartTime?: string }
      }>>('liveBroadcasts', {
        part: 'id,snippet', broadcastStatus: 'upcoming', maxResults: '50', pageToken
      })
      const match = response.items?.find((item) =>
        item.snippet?.title === title && item.snippet?.scheduledStartTime === scheduledUtc)
      if (match?.id) return match.id
      pageToken = response.nextPageToken
    } while (pageToken)
    return undefined
  }

  private async findRecentStream(title: string): Promise<{ streamId: string; streamKey: string } | undefined> {
    const response = await this.request<ListResponse<{
      id?: string
      snippet?: { title?: string }
      cdn?: { ingestionInfo?: { streamName?: string } }
    }>>('liveStreams', { part: 'id,snippet,cdn', mine: 'true', maxResults: '50' })
    const match = response.items?.find((item) => item.snippet?.title === title)
    const streamKey = match?.cdn?.ingestionInfo?.streamName
    return match?.id && streamKey ? { streamId: match.id, streamKey } : undefined
  }

  private async request<T>(
    path: string,
    parameters: Record<string, string | undefined>,
    method: 'GET' | 'POST' | 'PUT' = 'GET',
    body?: unknown
  ): Promise<T> {
    const query = new URLSearchParams()
    for (const [key, value] of Object.entries(parameters)) {
      if (value !== undefined) query.set(key, value)
    }
    return await this.fetchJson<T>(`https://www.googleapis.com/youtube/v3/${path}?${query}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.auth.getAccessToken()}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  }

  private async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    let response: Response
    try {
      response = await fetch(url, init)
    } catch (error) {
      throw toAppError(error)
    }
    const data = await response.json().catch(() => ({})) as T & ApiErrorBody
    if (!response.ok) {
      throw toAppError({
        status: response.status,
        message: data.error?.message,
        reason: data.error?.errors?.[0]?.reason
      })
    }
    return data
  }
}
