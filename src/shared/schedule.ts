import { Temporal } from '@js-temporal/polyfill'
import type {
  DateStyle,
  Locale,
  PreviewIssue,
  PreviewItem,
  ScheduleInput,
  SchedulePreview,
  TimeStyle
} from './types'
import { scheduleInputSchema } from './schemas'

const ALLOWED_PLACEHOLDERS = new Set(['session', 'date', 'time'])
const PLACEHOLDER_PATTERN = /\{([a-zA-Z][a-zA-Z0-9_-]*)\}/g

function localeTag(locale: Locale): string {
  return locale === 'fr' ? 'fr-FR' : 'en-US'
}

export function formatScheduleDate(date: Temporal.PlainDate, locale: Locale, style: DateStyle): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    dateStyle: style,
    timeZone: 'UTC'
  }).format(new Date(`${date.toString()}T12:00:00Z`))
}

export function formatScheduleTime(time: Temporal.PlainTime, locale: Locale, style: TimeStyle): string {
  return new Intl.DateTimeFormat(localeTag(locale), {
    hour: '2-digit',
    minute: '2-digit',
    hour12: style === '12h',
    timeZone: 'UTC'
  }).format(new Date(`2000-01-01T${time.toString({ smallestUnit: 'minute' })}:00Z`))
}

export function renderTemplate(
  template: string,
  values: { session: number; date: string; time: string }
): { value: string; unknown: string[] } {
  const unknown = new Set<string>()
  const value = template.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    if (!ALLOWED_PLACEHOLDERS.has(name)) {
      unknown.add(name)
      return whole
    }
    return String(values[name as keyof typeof values])
  })
  return { value, unknown: [...unknown] }
}

function candidateDates(input: ScheduleInput): Temporal.PlainDate[] {
  const start = Temporal.PlainDate.from(input.startDate)
  if (input.cadence === 'daily') {
    return Array.from({ length: input.periods }, (_, index) => start.add({ days: index }))
  }
  if (input.cadence === 'weekly') {
    return Array.from({ length: input.periods }, (_, index) => start.add({ weeks: index }))
  }

  const weekdays = new Set(input.weekdays)
  const result: Temporal.PlainDate[] = []
  const startOfFirstWeek = start.subtract({ days: start.dayOfWeek - 1 })
  const endExclusive = startOfFirstWeek.add({ weeks: input.periods })
  for (let day = 0; ; day += 1) {
    const candidate = start.add({ days: day })
    if (Temporal.PlainDate.compare(candidate, endExclusive) >= 0) break
    if (weekdays.has(candidate.dayOfWeek)) result.push(candidate)
  }
  return result
}

function wallClockMatches(
  value: Temporal.ZonedDateTime,
  date: Temporal.PlainDate,
  time: Temporal.PlainTime
): boolean {
  return (
    value.year === date.year &&
    value.month === date.month &&
    value.day === date.day &&
    value.hour === time.hour &&
    value.minute === time.minute
  )
}

function resolveWallClock(
  date: Temporal.PlainDate,
  time: Temporal.PlainTime,
  timeZone: string
): { value?: Temporal.ZonedDateTime; issue?: PreviewIssue } {
  const fields = {
    timeZone,
    year: date.year,
    month: date.month,
    day: date.day,
    hour: time.hour,
    minute: time.minute
  }
  const earlier = Temporal.ZonedDateTime.from(fields, { disambiguation: 'earlier' })
  const later = Temporal.ZonedDateTime.from(fields, { disambiguation: 'later' })
  const earlierMatches = wallClockMatches(earlier, date, time)
  const laterMatches = wallClockMatches(later, date, time)

  if (!earlierMatches || !laterMatches) {
    return {
      issue: {
        code: 'nonexistent-time',
        severity: 'error',
        message: 'This local time does not exist because of a daylight-saving transition.'
      }
    }
  }
  if (earlier.epochNanoseconds !== later.epochNanoseconds) {
    return {
      value: earlier,
      issue: {
        code: 'ambiguous-time',
        severity: 'warning',
        message: `This time occurs twice; the earlier occurrence (${earlier.offset}) will be used.`
      }
    }
  }
  return { value: earlier }
}

function operationCount(input: ScheduleInput, includedItems: number): number {
  if (includedItems === 0) return 0
  // Stream and broadcast inserts are preceded by recovery lookups so a lost
  // response can be resumed without blindly creating duplicates.
  const sharedStreams = input.streamKeyMode === 'broadcast' ? includedItems * 2 : 2
  const perItem = 3
    + (input.privacy === 'public-at-start' ? 1 : 0)
    + (input.thumbnailPath ? 1 : 0)
    + (input.playlistId || input.customPlaylistId ? 2 : 0)
  return sharedStreams + perItem * includedItems
}

export function generateSchedulePreview(
  rawInput: ScheduleInput,
  excludedIds: ReadonlySet<string> = new Set(),
  now: Temporal.Instant = Temporal.Now.instant()
): SchedulePreview {
  const parsed = scheduleInputSchema.safeParse(rawInput)
  if (!parsed.success) {
    return {
      items: [],
      errors: parsed.error.issues.map((issue) => issue.message),
      operationCount: 0
    }
  }
  const input = parsed.data
  const errors: string[] = []
  if (new Set(input.startTimes).size !== input.startTimes.length) {
    errors.push('Start times cannot contain duplicates.')
  }
  if (input.cadence === 'weekdays' && input.weekdays.length === 0) {
    errors.push('Choose at least one weekday.')
  }
  if (input.playlistId === '__custom__' && !input.customPlaylistId?.trim()) {
    errors.push('Enter a playlist ID or choose “No playlist”.')
  }
  try {
    Temporal.Now.zonedDateTimeISO(input.timeZone)
  } catch {
    errors.push(`Unknown timezone: ${input.timeZone}`)
  }
  if (errors.length) return { items: [], errors, operationCount: 0 }

  const raw: Array<Omit<PreviewItem, 'session' | 'title' | 'description' | 'included' | 'issues'> & { baseIssues: PreviewIssue[] }> = []
  const times = [...input.startTimes].sort().map((value) => Temporal.PlainTime.from(value))

  for (const date of candidateDates(input)) {
    for (const time of times) {
      const id = `${date.toString()}T${time.toString({ smallestUnit: 'minute' })}[${input.timeZone}]`
      const resolved = resolveWallClock(date, time, input.timeZone)
      const issues = resolved.issue ? [resolved.issue] : []
      if (resolved.value && Temporal.Instant.compare(resolved.value.toInstant(), now) <= 0) {
        issues.push({
          code: 'past',
          severity: 'error',
          message: 'This occurrence is in the past.'
        })
      }
      raw.push({
        id,
        localDate: date.toString(),
        localTime: time.toString({ smallestUnit: 'minute' }),
        scheduledUtc: resolved.value?.toInstant().toString() ?? '',
        timezoneOffset: resolved.value?.offset ?? '',
        baseIssues: issues
      })
    }
  }

  let nextSession = input.startingSession
  const items = raw.map((item): PreviewItem => {
    const included = !excludedIds.has(item.id)
    const session = nextSession
    if (included) nextSession += 1
    const date = Temporal.PlainDate.from(item.localDate)
    const time = Temporal.PlainTime.from(item.localTime)
    const values = {
      session,
      date: formatScheduleDate(date, input.locale, input.dateStyle),
      time: formatScheduleTime(time, input.locale, input.timeStyle)
    }
    const renderedTitle = renderTemplate(input.titleTemplate, values)
    const renderedDescription = renderTemplate(input.descriptionTemplate, values)
    const issues = [...item.baseIssues]
    const unknown = [...new Set([...renderedTitle.unknown, ...renderedDescription.unknown])]
    if (unknown.length) {
      issues.push({
        code: 'unknown-placeholder',
        severity: 'error',
        message: `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`
      })
    }
    if (renderedTitle.value.length > 100) {
      issues.push({
        code: 'title-too-long',
        severity: 'error',
        message: `The rendered title is ${renderedTitle.value.length} characters; YouTube allows 100.`
      })
    }
    if (renderedDescription.value.length > 5000) {
      issues.push({
        code: 'description-too-long',
        severity: 'error',
        message: `The rendered description is ${renderedDescription.value.length} characters; YouTube allows 5000.`
      })
    }
    return {
      id: item.id,
      localDate: item.localDate,
      localTime: item.localTime,
      scheduledUtc: item.scheduledUtc,
      timezoneOffset: item.timezoneOffset,
      session,
      title: renderedTitle.value,
      description: renderedDescription.value,
      included,
      issues
    }
  })

  const included = items.filter((item) => item.included).length
  return { items, errors, operationCount: operationCount(input, included) }
}
