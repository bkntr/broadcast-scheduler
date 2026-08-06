import { describe, expect, it } from 'vitest'
import { Temporal } from '@js-temporal/polyfill'
import { generateSchedulePreview, renderTemplate } from '../src/shared/schedule'
import type { ScheduleInput } from '../src/shared/types'

function input(overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    cadence: 'weekly',
    periods: 3,
    startDate: '2026-07-20',
    startTimes: ['20:00'],
    weekdays: [1],
    timeZone: 'Europe/Paris',
    locale: 'en',
    dateStyle: 'medium',
    timeStyle: '24h',
    titleTemplate: 'Session {session} — {date} at {time}',
    descriptionTemplate: 'Description for {session}',
    startingSession: 1,
    privacy: 'unlisted',
    playlistId: '',
    customPlaylistId: '',
    thumbnailPath: '',
    streamKeyMode: 'existing',
    existingStreamId: 'existing-stream',
    autoStart: true,
    autoStop: true,
    madeForKids: false,
    ...overrides
  }
}

const beforeSchedule = Temporal.Instant.from('2026-07-19T10:00:00Z')

describe('generateSchedulePreview', () => {
  it('creates weekly occurrences and chronologically numbers multiple times', () => {
    const result = generateSchedulePreview(input({ periods: 2, startTimes: ['20:00', '08:00'] }), new Set(), beforeSchedule)
    expect(result.errors).toEqual([])
    expect(result.items.map((item) => `${item.localDate} ${item.localTime} #${item.session}`)).toEqual([
      '2026-07-20 08:00 #1',
      '2026-07-20 20:00 #2',
      '2026-07-27 08:00 #3',
      '2026-07-27 20:00 #4'
    ])
  })

  it('treats custom weekday periods as calendar weeks', () => {
    const result = generateSchedulePreview(input({
      cadence: 'weekdays',
      periods: 2,
      startDate: '2026-07-22',
      weekdays: [1, 3, 5]
    }), new Set(), beforeSchedule)
    expect(result.items.map((item) => item.localDate)).toEqual([
      '2026-07-22',
      '2026-07-24',
      '2026-07-27',
      '2026-07-29',
      '2026-07-31'
    ])
  })

  it('does not let exclusions consume session numbers', () => {
    const initial = generateSchedulePreview(input({ cadence: 'daily', periods: 3 }), new Set(), beforeSchedule)
    const excluded = new Set([initial.items[1].id])
    const result = generateSchedulePreview(input({ cadence: 'daily', periods: 3, startingSession: 8 }), excluded, beforeSchedule)
    expect(result.items.filter((item) => item.included).map((item) => item.session)).toEqual([8, 9])
  })

  it('marks past occurrences instead of silently shifting them', () => {
    const result = generateSchedulePreview(
      input({ startDate: '2026-07-19', periods: 1 }),
      new Set(),
      Temporal.Instant.from('2026-07-19T20:00:00Z')
    )
    expect(result.items[0].issues.map((issue) => issue.code)).toContain('past')
    expect(result.items[0].localDate).toBe('2026-07-19')
  })

  it('rejects duplicate start times', () => {
    const result = generateSchedulePreview(input({ startTimes: ['08:00', '08:00'] }), new Set(), beforeSchedule)
    expect(result.errors.join(' ')).toMatch(/duplicate/i)
  })

  it('rejects nonexistent DST times', () => {
    const result = generateSchedulePreview(input({
      startDate: '2026-03-29',
      startTimes: ['02:30'],
      periods: 1
    }), new Set(), Temporal.Instant.from('2026-03-01T00:00:00Z'))
    expect(result.items[0].issues.map((issue) => issue.code)).toContain('nonexistent-time')
    expect(result.items[0].scheduledUtc).toBe('')
  })

  it('uses and warns about the earlier occurrence of an ambiguous DST time', () => {
    const result = generateSchedulePreview(input({
      startDate: '2026-10-25',
      startTimes: ['02:30'],
      periods: 1
    }), new Set(), Temporal.Instant.from('2026-10-01T00:00:00Z'))
    expect(result.items[0].issues.map((issue) => issue.code)).toContain('ambiguous-time')
    expect(result.items[0].timezoneOffset).toBe('+02:00')
  })

  it('validates rendered title and description lengths', () => {
    const result = generateSchedulePreview(input({
      periods: 1,
      titleTemplate: 'x'.repeat(101),
      descriptionTemplate: 'x'.repeat(5001)
    }), new Set(), beforeSchedule)
    expect(result.items[0].issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(['title-too-long', 'description-too-long']))
  })

  it('estimates operations from optional features', () => {
    const result = generateSchedulePreview(input({
      periods: 2,
      privacy: 'public-at-start',
      thumbnailPath: 'thumbnail.png',
      playlistId: 'playlist'
    }), new Set(), beforeSchedule)
    expect(result.operationCount).toBe(16)
  })

  it('keeps legacy stream-key settings compatible with saved batches', () => {
    const legacy = { ...input(), sharedStreamKey: false, rotateStreamKey: false } as ScheduleInput & {
      sharedStreamKey: boolean
      rotateStreamKey: boolean
    }
    delete (legacy as Partial<ScheduleInput>).streamKeyMode
    delete (legacy as Partial<ScheduleInput>).existingStreamId
    const result = generateSchedulePreview(legacy, new Set(), beforeSchedule)
    expect(result.errors).toEqual([])
    expect(result.operationCount).toBe(15)
  })

  it('requires a value for the manual playlist option', () => {
    const result = generateSchedulePreview(input({ playlistId: '__custom__', customPlaylistId: '' }), new Set(), beforeSchedule)
    expect(result.errors.join(' ')).toMatch(/playlist ID/i)
  })
})

describe('renderTemplate', () => {
  it('renders friendly placeholders and reports unknown ones', () => {
    expect(renderTemplate('{session}: {date} {time} {unknown}', { session: 3, date: 'Jul 20, 2026', time: '20:00' })).toEqual({
      value: '3: Jul 20, 2026 20:00 {unknown}',
      unknown: ['unknown']
    })
  })
})
