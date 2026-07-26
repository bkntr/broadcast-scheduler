import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { youtube, type youtube_v3 } from '@googleapis/youtube'
import type { AuthService } from './auth'
import { AppError } from './errors'
import type { AppStore } from './storage'
import type { ChannelSummary, PlaylistSummary, ScheduleInput, ThumbnailInfo } from '../shared/types'

const MAX_THUMBNAIL_SIZE = 2_000_000

export class YouTubeService {
  constructor(
    private readonly authService: AuthService,
    private readonly store: AppStore
  ) {}

  private async client(): Promise<youtube_v3.Youtube> {
    return youtube({ version: 'v3', auth: await this.authService.getClient() })
  }

  async playlists(): Promise<PlaylistSummary[]> {
    const youtube = await this.client()
    const result: PlaylistSummary[] = []
    let pageToken: string | undefined
    do {
      const response = await youtube.playlists.list({
        part: ['snippet'],
        mine: true,
        maxResults: 50,
        pageToken
      })
      result.push(...(response.data.items ?? []).flatMap((item) =>
        item.id ? [{ id: item.id, title: item.snippet?.title ?? item.id }] : []
      ))
      pageToken = response.data.nextPageToken ?? undefined
    } while (pageToken)
    return result.sort((left, right) => left.title.localeCompare(right.title))
  }

  async validateThumbnail(path: string): Promise<ThumbnailInfo> {
    const file = await stat(path).catch(() => undefined)
    if (!file?.isFile()) throw new AppError('THUMBNAIL_MISSING', 'The selected thumbnail no longer exists.')
    if (file.size > MAX_THUMBNAIL_SIZE) throw new AppError('THUMBNAIL_SIZE', 'Thumbnail must not exceed 2 MB.')
    const bytes = await readFile(path)
    let mimeType: 'image/png' | 'image/jpeg'
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      mimeType = 'image/png'
    } else if (bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
      mimeType = 'image/jpeg'
    } else {
      throw new AppError('THUMBNAIL_FORMAT', 'Thumbnail must be a valid PNG or JPEG file.')
    }
    return {
      path,
      name: basename(path),
      size: file.size,
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`
    }
  }

  async getOrCreateSharedStream(
    channel: ChannelSummary,
    rotate: boolean,
    batchId: string
  ): Promise<{ streamId: string; streamKey: string }> {
    const youtube = await this.client()
    const savedId = rotate ? undefined : this.store.getChannelStream(channel.id)
    if (savedId) {
      const response = await youtube.liveStreams.list({ part: ['id', 'cdn'], id: [savedId] })
      const existing = response.data.items?.[0]
      const key = existing?.cdn?.ingestionInfo?.streamName
      if (existing?.id && key) return { streamId: existing.id, streamKey: key }
      await this.store.clearChannelStream(channel.id)
    }
    const title = rotate
      ? `YouTube Scheduler — ${channel.title} — ${batchId.slice(0, 8)}`
      : `YouTube Scheduler — ${channel.title}`
    const created = await this.createStream(
      youtube,
      title,
      'Reusable stream managed by YouTube Scheduler.',
      true
    )
    await this.store.setChannelStream(channel.id, created.streamId)
    return created
  }

  async createItemStream(identifier: string): Promise<{ streamId: string; streamKey: string }> {
    const youtube = await this.client()
    const title = `YouTube Scheduler — ${identifier}`
    return await this.findRecentStream(youtube, title)
      ?? this.createStream(youtube, title, 'Stream managed by YouTube Scheduler.', true)
  }

  async retrieveStreamKey(streamId: string): Promise<string> {
    const response = await (await this.client()).liveStreams.list({ part: ['cdn'], id: [streamId] })
    const key = response.data.items?.[0]?.cdn?.ingestionInfo?.streamName
    if (!key) throw new AppError('STREAM_KEY_UNAVAILABLE', 'YouTube did not return a stream key.')
    return key
  }

  async createBroadcast(args: {
    input: ScheduleInput
    title: string
    description: string
    scheduledUtc: string
  }): Promise<string> {
    const youtube = await this.client()
    const existing = await this.findBroadcast(youtube, args.title, args.scheduledUtc)
    if (existing) return existing
    const insertPrivacy = args.input.privacy === 'public-at-start' ? 'private' : args.input.privacy
    const response = await youtube.liveBroadcasts.insert({
      part: ['snippet', 'status', 'contentDetails'],
      requestBody: {
        snippet: {
          title: args.title,
          description: args.description,
          scheduledStartTime: args.scheduledUtc
        },
        status: {
          privacyStatus: insertPrivacy,
          selfDeclaredMadeForKids: args.input.madeForKids
        },
        contentDetails: {
          enableAutoStart: args.input.autoStart,
          enableAutoStop: args.input.autoStop,
          enableDvr: true
        }
      }
    })
    if (!response.data.id) throw new AppError('BROADCAST_ID_MISSING', 'YouTube created a broadcast without returning its ID.')
    return response.data.id
  }

  async schedulePublicAtStart(broadcastId: string, scheduledUtc: string): Promise<void> {
    await (await this.client()).videos.update({
      part: ['status'],
      requestBody: {
        id: broadcastId,
        status: { privacyStatus: 'private', publishAt: scheduledUtc }
      }
    })
  }

  async bindBroadcast(broadcastId: string, streamId: string): Promise<void> {
    await (await this.client()).liveBroadcasts.bind({
      part: ['id', 'contentDetails'],
      id: broadcastId,
      streamId
    })
  }

  async uploadThumbnail(broadcastId: string, path: string): Promise<void> {
    await this.validateThumbnail(path)
    const extension = extname(path).toLowerCase()
    const mimeType = extension === '.png' ? 'image/png' : 'image/jpeg'
    await (await this.client()).thumbnails.set({
      videoId: broadcastId,
      media: { mimeType, body: createReadStream(path) }
    })
  }

  async addToPlaylist(broadcastId: string, playlistId: string): Promise<string | undefined> {
    const youtube = await this.client()
    const existing = await youtube.playlistItems.list({
      part: ['id'],
      playlistId,
      videoId: broadcastId,
      maxResults: 1
    })
    if (existing.data.items?.[0]?.id) return existing.data.items[0].id
    const response = await youtube.playlistItems.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          playlistId,
          resourceId: { kind: 'youtube#video', videoId: broadcastId }
        }
      }
    })
    return response.data.id ?? undefined
  }

  private async createStream(
    youtube: youtube_v3.Youtube,
    title: string,
    description: string,
    reusable: boolean
  ): Promise<{ streamId: string; streamKey: string }> {
    const response = await youtube.liveStreams.insert({
      part: ['snippet', 'cdn', 'contentDetails', 'status'],
      requestBody: {
        snippet: { title, description },
        cdn: { frameRate: 'variable', ingestionType: 'rtmp', resolution: 'variable' },
        contentDetails: { isReusable: reusable }
      }
    })
    const streamId = response.data.id
    const streamKey = response.data.cdn?.ingestionInfo?.streamName
    if (!streamId || !streamKey) throw new AppError('STREAM_DETAILS_MISSING', 'YouTube did not return complete stream details.')
    return { streamId, streamKey }
  }

  private async findBroadcast(
    youtube: youtube_v3.Youtube,
    title: string,
    scheduledUtc: string
  ): Promise<string | undefined> {
    let pageToken: string | undefined
    do {
      const response = await youtube.liveBroadcasts.list({
        part: ['id', 'snippet'],
        broadcastStatus: 'upcoming',
        maxResults: 50,
        pageToken
      })
      const match = response.data.items?.find((item) =>
        item.snippet?.title === title && item.snippet?.scheduledStartTime === scheduledUtc
      )
      if (match?.id) return match.id
      pageToken = response.data.nextPageToken ?? undefined
    } while (pageToken)
    return undefined
  }

  private async findRecentStream(
    youtube: youtube_v3.Youtube,
    title: string
  ): Promise<{ streamId: string; streamKey: string } | undefined> {
    // Retry recovery only needs the newest page: a stream created by an earlier
    // attempt will be recent. Scanning a channel's full stream history can fail
    // on old YouTube pagination pages and prevent otherwise valid insertions.
    const response = await youtube.liveStreams.list({
      part: ['id', 'snippet', 'cdn'],
      mine: true,
      maxResults: 50
    })
    const match = response.data.items?.find((item) => item.snippet?.title === title)
    const streamKey = match?.cdn?.ingestionInfo?.streamName
    if (match?.id && streamKey) return { streamId: match.id, streamKey }
    return undefined
  }
}
