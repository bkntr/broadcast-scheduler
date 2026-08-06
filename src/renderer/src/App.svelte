<script lang="ts">
  import { onMount } from 'svelte'
  import { Temporal } from '@js-temporal/polyfill'
  import { Dialog } from 'bits-ui'
  import {
    CalendarDays,
    Check,
    ChevronRight,
    CircleAlert,
    CircleHelp,
    Clipboard,
    ExternalLink,
    Eye,
    EyeOff,
    History,
    Image,
    LoaderCircle,
    Plus,
    RotateCw,
    Settings,
    Trash2,
    UserRoundCheck,
    X
  } from '@lucide/svelte'
  import { generateSchedulePreview } from '../../shared/schedule'
  import type {
    AppSettings,
    AuthState,
    BatchRecord,
    Locale,
    PlaylistSummary,
    ScheduleInput,
    SchedulePreview,
    ThumbnailInfo
  } from '../../shared/types'
  import { translate } from './i18n'

  type View = 'schedule' | 'review' | 'batch' | 'history' | 'settings'
  interface Bootstrap {
    version: string
    platform: string
    arch: string
    settings: AppSettings
    auth: AuthState
    batches: BatchRecord[]
  }

  let boot = $state<Bootstrap>()
  let view = $state<View>('schedule')
  let locale = $state<Locale>('en')
  let auth = $state<AuthState>({ status: 'disconnected', channels: [] })
  let settings = $state<AppSettings>({ locale: 'en', theme: 'system' })
  let batches = $state<BatchRecord[]>([])
  let playlists = $state<PlaylistSummary[]>([])
  let thumbnail = $state<ThumbnailInfo>()
  let form = $state<ScheduleInput>(defaultForm('en'))
  let preview = $state<SchedulePreview>()
  let excluded = $state(new Set<string>())
  let activeBatch = $state<BatchRecord>()
  let busy = $state(false)
  let globalError = $state<string>()
  let descriptionModal = $state<string>()
  let descriptionDialogOpen = $state(false)
  let largeBatchConfirmed = $state(false)
  let streamKeys = $state<Record<string, string>>({})
  let visibleStreamIds = $state(new Set<string>())
  let copied = $state(false)
  let diagnosticsMessage = $state<string>()
  let oauthHelpOpen = $state(false)

  const selectedChannel = $derived(auth.channels.find((channel) => channel.id === auth.selectedChannelId))
  const includedItems = $derived(preview?.items.filter((item) => item.included) ?? [])
  const hasIncludedErrors = $derived(includedItems.some((item) => item.issues.some((issue) => issue.severity === 'error')))
  const batchPercent = $derived(activeBatch && activeBatch.items.length
    ? Math.round((activeBatch.completedCount / activeBatch.items.length) * 100)
    : 0)
  const activeStreamIds = $derived([...new Set(activeBatch?.items.flatMap((item) => item.streamId ? [item.streamId] : []) ?? [])])
  const t = (key: string, values: Record<string, string | number> = {}): string => translate(locale, key, values)

  function showDescription(description: string): void {
    descriptionModal = description
    descriptionDialogOpen = true
  }

  function systemTimeZone(): string {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  }

  function defaultForm(language: Locale): ScheduleInput {
    const zone = systemTimeZone()
    const start = Temporal.Now.plainDateISO(zone).add({ days: 1 })
    return {
      cadence: 'weekly',
      periods: 3,
      startDate: start.toString(),
      startTimes: ['20:00'],
      weekdays: [start.dayOfWeek],
      timeZone: zone,
      locale: language,
      dateStyle: 'medium',
      timeStyle: '24h',
      titleTemplate: language === 'fr'
        ? 'Session {session} — {date} à {time}'
        : 'Session {session} — {date} at {time}',
      descriptionTemplate: '',
      startingSession: 1,
      privacy: 'unlisted',
      playlistId: '',
      customPlaylistId: '',
      thumbnailPath: '',
      sharedStreamKey: true,
      rotateStreamKey: false,
      autoStart: true,
      autoStop: true,
      madeForKids: false
    }
  }

  function mergeRemembered(base: ScheduleInput, remembered?: Partial<ScheduleInput>): ScheduleInput {
    if (!remembered) return base
    return {
      ...base,
      ...remembered,
      startDate: base.startDate,
      thumbnailPath: '',
      rotateStreamKey: false,
      locale: base.locale,
      startTimes: remembered.startTimes?.length ? [...remembered.startTimes] : base.startTimes,
      weekdays: remembered.weekdays?.length ? [...remembered.weekdays] : base.weekdays
    }
  }

  function applyTheme(theme: AppSettings['theme']): void {
    const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches)
    document.documentElement.classList.toggle('dark', dark)
  }

  function applyLocale(nextLocale: Locale): void {
    document.documentElement.lang = nextLocale
  }

  function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
  }

  async function loadPlaylists(): Promise<void> {
    if (auth.status !== 'connected' || !auth.selectedChannelId) return
    try {
      playlists = await window.desktop.youtube.playlists()
    } catch (error) {
      globalError = errorMessage(error)
    }
  }

  async function connect(): Promise<void> {
    busy = true
    globalError = undefined
    try {
      auth = await window.desktop.auth.connect()
      settings.selectedChannelId = auth.selectedChannelId
      await loadPlaylists()
    } catch (error) {
      globalError = errorMessage(error)
    } finally {
      busy = false
    }
  }

  async function selectChannel(channelId: string): Promise<void> {
    try {
      auth = await window.desktop.auth.selectChannel(channelId)
      settings.selectedChannelId = channelId
      await loadPlaylists()
    } catch (error) {
      globalError = errorMessage(error)
    }
  }

  async function disconnect(): Promise<void> {
    try {
      await window.desktop.auth.disconnect()
      auth = { status: 'disconnected', channels: [] }
      playlists = []
      settings.selectedChannelId = undefined
      view = 'schedule'
    } catch (error) {
      globalError = errorMessage(error)
    }
  }

  function addTime(): void {
    const last = form.startTimes.at(-1) ?? '19:00'
    const time = Temporal.PlainTime.from(last).add({ hours: 1 }).toString({ smallestUnit: 'minute' })
    form.startTimes = [...form.startTimes, time]
  }

  function removeTime(index: number): void {
    if (form.startTimes.length === 1) return
    form.startTimes = form.startTimes.filter((_, candidate) => candidate !== index)
  }

  function toggleWeekday(day: number): void {
    form.weekdays = form.weekdays.includes(day)
      ? form.weekdays.filter((candidate) => candidate !== day)
      : [...form.weekdays, day].sort()
  }

  function weekdayName(day: number): string {
    const date = new Date(Date.UTC(2024, 0, day))
    return new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-US', { weekday: 'short', timeZone: 'UTC' }).format(date)
  }

  function firstRenderedDescription(): string {
    const generated = generateSchedulePreview(form)
    return generated.items[0]?.description || form.descriptionTemplate
  }

  function displayIssue(code: string, fallback: string): string {
    const key = {
      'past': 'issuePast',
      'nonexistent-time': 'issueNonexistent',
      'ambiguous-time': 'issueAmbiguous',
      'title-too-long': 'issueTitleLong',
      'description-too-long': 'issueDescriptionLong',
      'unknown-placeholder': 'issuePlaceholder'
    }[code]
    return key ? t(key) : fallback
  }

  function displayScheduleError(message: string): string {
    if (/duplicates/i.test(message)) return t('errorDuplicateTime')
    if (/weekday/i.test(message)) return t('errorWeekday')
    if (/playlist ID/i.test(message)) return t('errorPlaylist')
    return message
  }

  async function chooseThumbnail(): Promise<void> {
    try {
      const chosen = await window.desktop.thumbnail.choose()
      if (!chosen) return
      thumbnail = chosen
      form.thumbnailPath = chosen.path
    } catch (error) {
      globalError = errorMessage(error)
    }
  }

  async function removeThumbnail(): Promise<void> {
    if (thumbnail) await window.desktop.thumbnail.remove(thumbnail.path)
    thumbnail = undefined
    form.thumbnailPath = ''
  }

  function goToReview(): void {
    form.locale = locale
    excluded = new Set()
    preview = generateSchedulePreview(form, excluded)
    largeBatchConfirmed = false
    if (preview.errors.length) {
      globalError = preview.errors.map(displayScheduleError).join(' ')
      return
    }
    view = 'review'
  }

  function toggleIncluded(id: string): void {
    const next = new Set(excluded)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    excluded = next
    preview = generateSchedulePreview(form, excluded)
    largeBatchConfirmed = false
  }

  async function createBatch(): Promise<void> {
    if (!preview || hasIncludedErrors || !includedItems.length) return
    busy = true
    globalError = undefined
    try {
      activeBatch = await window.desktop.batches.start($state.snapshot(form), [...excluded])
      batches = [activeBatch, ...batches.filter((batch) => batch.id !== activeBatch?.id)].slice(0, 30)
      view = 'batch'
      streamKeys = {}
      visibleStreamIds = new Set()
    } catch (error) {
      globalError = errorMessage(error)
    } finally {
      busy = false
    }
  }

  async function resumeBatch(batch: BatchRecord): Promise<void> {
    try {
      activeBatch = await window.desktop.batches.resume(batch.id)
      view = 'batch'
    } catch (error) {
      globalError = errorMessage(error)
    }
  }

  async function revealStreamKey(streamId: string): Promise<void> {
    if (!activeBatch || !streamId) return
    try {
      if (!streamKeys[streamId]) {
        streamKeys = { ...streamKeys, [streamId]: await window.desktop.batches.streamKey(activeBatch.id, streamId) }
      }
      const next = new Set(visibleStreamIds)
      if (next.has(streamId)) next.delete(streamId)
      else next.add(streamId)
      visibleStreamIds = next
    } catch (error) {
      globalError = errorMessage(error)
    }
  }

  async function copyText(text: string): Promise<void> {
    await window.desktop.clipboard.write(text)
    copied = true
    setTimeout(() => { copied = false }, 1400)
  }

  async function saveSettings(): Promise<void> {
    try {
      settings.locale = locale
      settings = await window.desktop.settings.save($state.snapshot(settings))
      applyTheme(settings.theme)
      applyLocale(locale)
      form.locale = locale
    } catch (error) {
      globalError = errorMessage(error)
    }
  }

  async function clearHistory(): Promise<void> {
    await window.desktop.batches.clearHistory()
    batches = []
  }

  function dateTimeLabel(
    item: { scheduledUtc: string; timezoneOffset?: string; issues?: Array<{ code: string }> },
    timezone = form.timeZone
  ): string {
    if (!item.scheduledUtc) return '—'
    const label = new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-US', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: timezone
    }).format(new Date(item.scheduledUtc))
    const showOffset = item.timezoneOffset && item.issues?.some((issue) => issue.code === 'ambiguous-time')
    return label + (showOffset ? ` (${item.timezoneOffset})` : '')
  }

  function statusLabel(status: string): string {
    return t(status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : status === 'running' ? 'running' : status === 'paused' ? 'paused' : 'pending')
  }

  function newSchedule(): void {
    view = 'schedule'
    activeBatch = undefined
    preview = undefined
    excluded = new Set()
    streamKeys = {}
    visibleStreamIds = new Set()
  }

  onMount(() => {
    let removeProgress = () => {}
    let removeThumbnailDrop = () => {}
    const themeMedia = matchMedia('(prefers-color-scheme: dark)')
    const followSystemTheme = (): void => {
      if (settings.theme === 'system') applyTheme('system')
    }
    themeMedia.addEventListener('change', followSystemTheme)
    const fixtureName = import.meta.env.DEV ? new URLSearchParams(window.location.search).get('fixture') : undefined
    if (fixtureName) {
      const parameters = new URLSearchParams(window.location.search)
      const fixtureLocale: Locale = parameters.get('locale') === 'fr' ? 'fr' : 'en'
      const requestedTheme = parameters.get('theme')
      const fixtureTheme: AppSettings['theme'] = requestedTheme === 'dark' || requestedTheme === 'light' ? requestedTheme : 'system'
      void import('./fixtures').then(({ createUiFixture }) => {
        const fixture = createUiFixture(fixtureName, defaultForm(fixtureLocale), fixtureLocale, fixtureTheme)
        boot = fixture.boot
        view = fixture.view
        locale = fixture.locale
        settings = fixture.settings
        auth = fixture.auth
        batches = fixture.batches
        form = fixture.form
        preview = fixture.preview
        activeBatch = fixture.activeBatch
        globalError = fixture.globalError
        if (fixture.description !== undefined) showDescription(fixture.description)
        applyLocale(locale)
        applyTheme(settings.theme)
        requestAnimationFrame(() => {
          if (parameters.get('advanced') === '1') document.querySelector('details')?.setAttribute('open', '')
          const scrollTop = Number(parameters.get('scroll') ?? 0)
          if (Number.isFinite(scrollTop) && scrollTop > 0) window.scrollTo({ top: scrollTop })
        })
      })
      return () => themeMedia.removeEventListener('change', followSystemTheme)
    }
    void (async () => {
      try {
        boot = await window.desktop.bootstrap()
        settings = boot.settings
        locale = settings.locale
        applyLocale(locale)
        auth = boot.auth
        batches = boot.batches
        applyTheme(settings.theme)
        form = mergeRemembered(defaultForm(locale), settings.lastSchedule)
        if (auth.status === 'connected' && auth.selectedChannelId) await loadPlaylists()
      } catch (error) {
        globalError = errorMessage(error)
      }
    })()

    removeProgress = window.desktop.onProgress((event) => {
      const batch = event.batch
      batches = [batch, ...batches.filter((candidate) => candidate.id !== batch.id)].slice(0, 30)
      if (activeBatch?.id === batch.id) activeBatch = batch
    })
    removeThumbnailDrop = window.desktop.thumbnail.onDrop((result) => {
      if (result.error) {
        globalError = result.error
        return
      }
      if (result.thumbnail) {
        thumbnail = result.thumbnail
        form.thumbnailPath = result.thumbnail.path
      }
    })
    return () => {
      removeProgress()
      removeThumbnailDrop()
      themeMedia.removeEventListener('change', followSystemTheme)
    }
  })
</script>

<svelte:head><title>{t('appName')}</title></svelte:head>

<div class="app-shell">
  <header class="topbar">
    <div class="brand">
      <span class="brand-mark"><img src="/icon.png" alt="" /></span>
      <span>{t('appName')}</span>
    </div>
    {#if auth.status === 'connected'}
      <nav class="nav" aria-label={t('mainNavigation')}>
        <button class:active={view === 'schedule' || view === 'review' || view === 'batch'} class="nav-button" onclick={() => view = 'schedule'}><CalendarDays size={16} /> {t('schedule')}</button>
        <button class:active={view === 'history'} class="nav-button" onclick={() => view = 'history'}><History size={16} /> {t('history')}</button>
        <button class:active={view === 'settings'} class="nav-button" onclick={() => view = 'settings'}><Settings size={16} /> {t('settings')}</button>
      </nav>
      <div class="account">
        {#if selectedChannel?.thumbnailUrl}<img class="avatar" src={selectedChannel.thumbnailUrl} alt="" />{:else}<span class="avatar"></span>{/if}
        {#if auth.channels.length > 1}
          <select class="select" aria-label={t('switchChannel')} value={auth.selectedChannelId ?? ''} onchange={(event) => selectChannel(event.currentTarget.value)}>
            <option value="">{t('selectChannel')}</option>
            {#each auth.channels as channel}<option value={channel.id}>{channel.title}</option>{/each}
          </select>
        {:else}
          <span class="account-name">{selectedChannel?.title}</span>
        {/if}
      </div>
    {/if}
  </header>

  <main class="main">
    {#if globalError}
      <div class="banner error-banner" role="alert">
        <span><strong>{t('error')}:</strong> {globalError}</span>
        <button class="icon-button" aria-label={t('dismiss')} onclick={() => globalError = undefined}><X size={18} /></button>
      </div>
    {/if}

    {#if !boot}
      <div class="auth-card card"><LoaderCircle class="animate-spin" size={36} /><p>{t('loading')}</p></div>
    {:else if auth.status !== 'connected' || !auth.selectedChannelId}
      <section class="auth-card card">
        <div class="auth-icon"><UserRoundCheck size={32} /></div>
        <h1 class="page-heading">{t('connectTitle')}</h1>
        <p class="page-intro">{auth.status === 'unconfigured' ? t('authUnconfigured') : auth.message ?? t('connectBody')}</p>
        <div class="auth-actions">
          {#if auth.status === 'unconfigured'}
            <button class="button primary" onclick={() => oauthHelpOpen = true}><CircleHelp size={17} /> {t('oauthHelp')}</button>
          {:else}
            <button class="button primary" disabled={busy} onclick={connect}>
              {#if busy}<LoaderCircle class="animate-spin" size={17} />{/if}
              {auth.status === 'reauth-required' ? t('reconnect') : t('connect')}
            </button>
          {/if}
        </div>
        {#if auth.status === 'connected' && auth.channels.length > 1}
          <div class="field" style="margin-top:20px;text-align:left">
            <label for="channel-choice">{t('selectChannel')}</label>
            <select id="channel-choice" class="select" onchange={(event) => selectChannel(event.currentTarget.value)}>
              <option value="">—</option>
              {#each auth.channels as channel}<option value={channel.id}>{channel.title}</option>{/each}
            </select>
          </div>
        {/if}
      </section>
    {:else if view === 'schedule'}
      <h1 class="page-heading">{t('scheduleHeading')}</h1>
      <p class="page-intro">{t('scheduleIntro')}</p>
      <div class="card">
        <section class="card-section">
          <h2 class="section-title">{t('cadence')}</h2>
          <div class="grid">
            <div class="field span-6">
              <span class="label">{t('cadence')}</span>
              <div class="segment">
                {#each ['daily', 'weekly', 'weekdays'] as cadence}
                  <button class:selected={form.cadence === cadence} aria-pressed={form.cadence === cadence} onclick={() => form.cadence = cadence as ScheduleInput['cadence']}>{t(cadence)}</button>
                {/each}
              </div>
            </div>
            <div class="field span-3">
              <label for="periods">{form.cadence === 'daily' ? t('days') : t('weeks')}</label>
              <input id="periods" class="input" type="number" min="1" max="366" bind:value={form.periods} />
            </div>
            <div class="field span-3">
              <label for="start-date">{t('startDate')}</label>
              <input id="start-date" class="input" type="date" bind:value={form.startDate} />
            </div>
            {#if form.cadence === 'weekdays'}
              <div class="field span-12">
                <span class="label">{t('weekdays')}</span>
                <div class="weekday-grid">
                  {#each [1,2,3,4,5,6,7] as day}
                    <button class:selected={form.weekdays.includes(day)} class="weekday-button" aria-pressed={form.weekdays.includes(day)} onclick={() => toggleWeekday(day)}>{weekdayName(day)}</button>
                  {/each}
                </div>
              </div>
            {/if}
            <div class="field span-8">
              <span class="label">{t('startTimes')}</span>
              <div class="times">
                {#each form.startTimes as time, index}
                  <div class="time-chip">
                    <input class="input" aria-label={`${t('startTimes')} ${index + 1}`} type="time" bind:value={form.startTimes[index]} />
                    <button class="icon-button" disabled={form.startTimes.length === 1} aria-label={t('remove')} onclick={() => removeTime(index)}><X size={17} /></button>
                  </div>
                {/each}
                <button class="button secondary" onclick={addTime}><Plus size={16} /> {t('addTime')}</button>
              </div>
            </div>
            <div class="field span-4">
              <label for="timezone">{t('timezone')}</label>
              <input id="timezone" class="input" list="timezone-options" bind:value={form.timeZone} />
              <datalist id="timezone-options">
                {#each ['UTC','Europe/Paris','Asia/Jerusalem','America/New_York','America/Los_Angeles'] as zone}<option value={zone}></option>{/each}
              </datalist>
            </div>
          </div>
        </section>

        <section class="card-section">
          <h2 class="section-title">{t('content')}</h2>
          <div class="grid">
            <div class="field span-8">
              <label for="title-template">{t('titleTemplate')}</label>
              <input id="title-template" class="input" bind:value={form.titleTemplate} />
              <span class="muted">{t('placeholders')}</span>
            </div>
            <div class="field span-4">
              <label for="visibility">{t('visibility')}</label>
              <select id="visibility" class="select" bind:value={form.privacy}>
                <option value="unlisted">{t('unlisted')}</option><option value="private">{t('private')}</option><option value="public">{t('public')}</option><option value="public-at-start">{t('publicAtStart')}</option>
              </select>
            </div>
            <div class="field span-8">
              <label for="description">{t('description')}</label>
              <textarea id="description" class="textarea" bind:value={form.descriptionTemplate}></textarea>
              <span class="muted">{t('placeholders')}</span>
              {#if form.descriptionTemplate}<button class="button secondary" style="align-self:flex-start" onclick={() => showDescription(firstRenderedDescription())}>{t('descriptionPreview')}</button>{/if}
            </div>
            <div class="span-4 grid">
              <div class="field span-12">
                <label for="date-format">{t('dateFormat')}</label>
                <select id="date-format" class="select" bind:value={form.dateStyle}><option value="short">{t('short')}</option><option value="medium">{t('medium')}</option><option value="long">{t('long')}</option></select>
              </div>
              <div class="field span-12">
                <label for="time-format">{t('timeFormat')}</label>
                <select id="time-format" class="select" bind:value={form.timeStyle}><option value="24h">24 h</option><option value="12h">12 h</option></select>
              </div>
            </div>
            <div class="field span-12">
              <span class="label">{t('thumbnail')}</span>
              {#if thumbnail}
                <div class="thumbnail-box"><img class="thumbnail-preview" src={thumbnail.dataUrl} alt="" /><div><strong>{thumbnail.name}</strong><p class="muted">{Math.round(thumbnail.size / 1024)} KB</p><button class="button secondary" onclick={removeThumbnail}>{t('remove')}</button></div></div>
              {:else}
                <div class="thumbnail-drop" data-thumbnail-drop>
                  <Image size={25} />
                  <div><button class="button secondary" onclick={chooseThumbnail}>{t('chooseThumbnail')}</button><p class="muted" style="margin:6px 0 0">{t('dropThumbnail')}</p></div>
                </div>
              {/if}
            </div>
          </div>
        </section>

        <details>
          <summary class="advanced-summary">{t('advanced')}</summary>
          <div class="advanced-content grid">
            <div class="field span-6">
              <label for="playlist">{t('playlist')}</label>
              <select id="playlist" class="select" bind:value={form.playlistId}>
                <option value="">{t('noPlaylist')}</option>
                {#each playlists as playlist}<option value={playlist.id}>{playlist.title}</option>{/each}
                <option value="__custom__">{t('customPlaylist')}</option>
              </select>
              {#if form.playlistId === '__custom__'}<input class="input" aria-label={t('customId')} placeholder={t('customId')} bind:value={form.customPlaylistId} />{/if}
            </div>
            <div class="span-6"></div>
            <label class="checkbox-row span-6"><input type="checkbox" bind:checked={form.sharedStreamKey} /><span>{t('sharedKey')}</span></label>
            <label class="checkbox-row span-6"><input type="checkbox" disabled={!form.sharedStreamKey} bind:checked={form.rotateStreamKey} /><span>{t('rotateKey')}</span></label>
            <label class="checkbox-row span-4"><input type="checkbox" bind:checked={form.autoStart} /><span>{t('autoStart')}</span></label>
            <label class="checkbox-row span-4"><input type="checkbox" bind:checked={form.autoStop} /><span>{t('autoStop')}</span></label>
            <label class="checkbox-row span-4"><input type="checkbox" bind:checked={form.madeForKids} /><span>{t('madeForKids')}</span></label>
            <div class="field span-4"><label for="first-session">{t('startingSession')}</label><input id="first-session" class="input" type="number" min="0" bind:value={form.startingSession} /></div>
          </div>
        </details>
      </div>
      <div class="actions"><button class="button primary" onclick={goToReview}>{t('reviewSchedule')} <ChevronRight size={17} /></button></div>

    {:else if view === 'review' && preview}
      <button class="button secondary" onclick={() => view = 'schedule'}>{t('back')}</button>
      <h1 class="page-heading" style="margin-top:20px">{t('reviewHeading')}</h1>
      <p class="page-intro"><strong>{selectedChannel?.title}</strong> · {includedItems.length} {t('broadcasts')} · {preview.operationCount} {t('operations')}</p>
      {#if includedItems.length > 25}
        <div class="warning"><strong>{t('quotaWarning')}</strong><label class="checkbox-row" style="margin-top:10px"><input type="checkbox" bind:checked={largeBatchConfirmed} /> {t('confirmLarge')}</label></div>
      {/if}
      {#if hasIncludedErrors}<div class="banner error-banner" style="margin-top:14px"><CircleAlert size={18} /> {t('invalidIncluded')}</div>{/if}
      <div class="card review-list" style="margin-top:16px">
        <div class="review-head"><span>{t('include')}</span><span>{t('dateTime')}</span><span>{t('title')}</span><span></span></div>
        {#each preview.items as item}
          <div class:excluded={!item.included} class="review-row">
            <input type="checkbox" aria-label={t('include')} checked={item.included} onchange={() => toggleIncluded(item.id)} />
            <span>{dateTimeLabel(item)}<br /><small class="muted">#{item.session}</small></span>
            <span class="review-title">{item.title}{#each item.issues as issue}<span class:warning-text={issue.severity === 'warning'} class="issue">{displayIssue(issue.code, issue.message)}</span>{/each}</span>
            <button class="icon-button" disabled={!item.description} title={t('previewDescription')} onclick={() => showDescription(item.description)}><Eye size={17} /></button>
          </div>
        {/each}
      </div>
      <div class="actions"><button class="button secondary" onclick={() => view = 'schedule'}>{t('back')}</button><button class="button primary" disabled={busy || hasIncludedErrors || !includedItems.length || (includedItems.length > 25 && !largeBatchConfirmed)} onclick={createBatch}>{#if busy}<LoaderCircle class="animate-spin" size={17} />{/if}{t('createBroadcasts')}</button></div>

    {:else if view === 'batch' && activeBatch}
      {#if activeBatch.status === 'completed'}
        <section class="card card-section">
          <div class="success-icon"><Check size={31} /></div>
          <h1 class="page-heading">{t('successTitle')}</h1>
          <p class="page-intro">{t('successBody')}</p>
          {#if activeBatch.input.sharedStreamKey && activeStreamIds[0]}
            <div class="stream-key">
              <span style="flex:1">{visibleStreamIds.has(activeStreamIds[0]) && streamKeys[activeStreamIds[0]] ? streamKeys[activeStreamIds[0]] : '••••••••••••••••••••••••'}</span>
              <button class="icon-button" title={visibleStreamIds.has(activeStreamIds[0]) ? t('hideKey') : t('revealKey')} onclick={() => revealStreamKey(activeStreamIds[0])}>{#if visibleStreamIds.has(activeStreamIds[0])}<EyeOff size={18} />{:else}<Eye size={18} />{/if}</button>
              {#if visibleStreamIds.has(activeStreamIds[0]) && streamKeys[activeStreamIds[0]]}<button class="icon-button" title={t('copy')} onclick={() => copyText(streamKeys[activeStreamIds[0]])}><Clipboard size={18} /></button>{/if}
            </div>
          {/if}
          {#if copied}<p class="muted">{t('copied')}</p>{/if}
          <div class="review-list card" style="margin-top:18px">
            {#each activeBatch.items as item}
              <div class="review-row" style="grid-template-columns:190px 1fr auto"><span>{dateTimeLabel(item, activeBatch.input.timeZone)}</span><span class="review-title">{item.title}{#if !activeBatch.input.sharedStreamKey && item.streamId}<span class="stream-key" style="margin-top:8px;font-weight:400"><span style="flex:1">{visibleStreamIds.has(item.streamId) && streamKeys[item.streamId] ? streamKeys[item.streamId] : '••••••••••••••••••••••••'}</span><button class="icon-button" title={visibleStreamIds.has(item.streamId) ? t('hideKey') : t('revealKey')} onclick={() => revealStreamKey(item.streamId!)}>{#if visibleStreamIds.has(item.streamId)}<EyeOff size={16} />{:else}<Eye size={16} />{/if}</button>{#if visibleStreamIds.has(item.streamId) && streamKeys[item.streamId]}<button class="icon-button" title={t('copy')} onclick={() => copyText(streamKeys[item.streamId!])}><Clipboard size={16} /></button>{/if}</span>{/if}</span>{#if item.broadcastId}<button class="button secondary" onclick={() => window.desktop.external.open(`https://studio.youtube.com/video/${item.broadcastId}/livestreaming`)}>{t('openStudio')} <ExternalLink size={15} /></button>{/if}</div>
            {/each}
          </div>
          <div class="actions"><button class="button primary" onclick={newSchedule}>{t('newSchedule')}</button></div>
        </section>
      {:else}
        <h1 class="page-heading">{t('progress')}</h1>
        <p class="page-intro">{t('progressCount', { done: activeBatch.completedCount, total: activeBatch.items.length })}</p>
        <div class="progress-track"><div class="progress-fill" style={`width:${batchPercent}%`}></div></div>
        {#if activeBatch.lastError}<div class="banner error-banner"><CircleAlert size={18} /><span>{activeBatch.lastError}</span></div>{/if}
        <div class="card review-list">
          {#each activeBatch.items as item}
            <div class="review-row" style="grid-template-columns:190px 1fr 120px"><span>{dateTimeLabel(item, activeBatch.input.timeZone)}</span><span class="review-title">{item.title}{#if item.errorMessage}<span class="issue">{item.errorMessage}</span>{/if}</span><span class={`status-pill ${item.status}`}>{statusLabel(item.status)}</span></div>
          {/each}
        </div>
        <div class="actions">
          {#if activeBatch.status === 'failed' || activeBatch.status === 'paused'}
            {#if activeBatch.lastError?.toLowerCase().includes('authorization')}<button class="button secondary" onclick={connect}>{t('reconnect')}</button>{/if}
            <button class="button primary" onclick={() => resumeBatch(activeBatch!)}><RotateCw size={16} /> {t('resume')}</button>
          {:else}
            <button class="button secondary" onclick={() => window.desktop.batches.stop()}>{t('stopAfterCurrent')}</button>
          {/if}
        </div>
      {/if}

    {:else if view === 'history'}
      <h1 class="page-heading">{t('history')}</h1><p class="page-intro">{t('localHistory')}</p>
      <div class="card">
        {#if !batches.length}<div class="card-section muted">{t('emptyHistory')}</div>{/if}
        {#each batches as batch}
          <div class="history-item"><div><strong>{batch.channel.title}</strong><div class="history-meta"><span>{new Intl.DateTimeFormat(locale === 'fr' ? 'fr-FR' : 'en-US', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(batch.createdAt))}</span><span>{t('historyCount', { done: batch.completedCount, total: batch.items.length })}</span><span class={`status-pill ${batch.status}`}>{statusLabel(batch.status)}</span></div></div><div>{#if batch.status === 'failed' || batch.status === 'paused'}<button class="button secondary" onclick={() => resumeBatch(batch)}>{t('resume')}</button>{:else if batch.items[0]?.broadcastId}<button class="button secondary" onclick={() => window.desktop.external.open(`https://studio.youtube.com/video/${batch.items[0].broadcastId}/livestreaming`)}>{t('openStudio')} <ExternalLink size={15} /></button>{/if}</div></div>
        {/each}
      </div>
      {#if batches.length}<div class="actions"><button class="button danger" onclick={clearHistory}><Trash2 size={16} /> {t('clearHistory')}</button></div>{/if}

    {:else if view === 'settings'}
      <h1 class="page-heading">{t('settings')}</h1><p class="page-intro">{t('appName')}</p>
      <div class="card card-section">
        <h2 class="section-title">{t('appearance')}</h2>
        <div class="setting-row"><div><strong>{t('language')}</strong></div><select class="select" bind:value={locale} onchange={saveSettings}><option value="en">English</option><option value="fr">Français</option></select></div>
        <div class="setting-row"><div><strong>{t('theme')}</strong></div><select class="select" bind:value={settings.theme} onchange={saveSettings}><option value="system">{t('system')}</option><option value="light">{t('light')}</option><option value="dark">{t('dark')}</option></select></div>
        <div class="setting-row"><div><strong>{t('copyDiagnostics')}</strong><p class="muted">{t('diagnosticsPrivacy')}</p></div><button class="button secondary" onclick={async () => { await window.desktop.diagnostics.copy(); diagnosticsMessage = t('diagnosticsCopied') }}>{t('copyDiagnostics')}</button></div>
        {#if diagnosticsMessage}<p class="muted">{diagnosticsMessage}</p>{/if}
        <div class="setting-row"><div><strong>{selectedChannel?.title}</strong><p class="muted">{auth.selectedChannelId}</p></div><button class="button danger" onclick={disconnect}>{t('disconnect')}</button></div>
        <p class="muted" style="margin-top:18px">{t('version')} {boot.version} · Web</p>
      </div>
    {/if}
  </main>
</div>

<Dialog.Root bind:open={oauthHelpOpen}>
  <Dialog.Portal>
    <Dialog.Overlay class="modal-backdrop" />
    <Dialog.Content class="modal oauth-help-modal">
      <div class="modal-heading-row">
        <div>
          <Dialog.Title class="modal-title">{t('oauthHelpTitle')}</Dialog.Title>
          <Dialog.Description class="muted">{t('oauthHelpIntro')}</Dialog.Description>
        </div>
        <Dialog.Close class="icon-button" aria-label={t('dismiss')}><X /></Dialog.Close>
      </div>
      <ol class="setup-steps">
        <li>{t('oauthHelpProject')}</li>
        <li>{t('oauthHelpApi')}</li>
        <li>{t('oauthHelpConsent')}</li>
        <li>{t('oauthHelpClient', { origin: window.location.origin })}</li>
        <li>{t('oauthHelpDownload')}</li>
        <li>{t('oauthHelpReturn')}</li>
      </ol>
      <div class="setup-note"><CircleAlert size={18} /><span>{t('oauthHelpTesting')}</span></div>
      <div class="modal-actions">
        <button class="button secondary" onclick={() => window.desktop.external.open('https://console.cloud.google.com/apis/library/youtube.googleapis.com')}>{t('openYouTubeApi')} <ExternalLink size={15} /></button>
        <button class="button primary" onclick={() => window.desktop.external.open('https://console.cloud.google.com/auth/clients')}>{t('openGoogleAuth')} <ExternalLink size={15} /></button>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<Dialog.Root bind:open={descriptionDialogOpen}>
  <Dialog.Portal>
    <Dialog.Overlay class="modal-backdrop" />
    <Dialog.Content class="modal">
      <div style="display:flex;justify-content:space-between;gap:12px">
        <Dialog.Title class="modal-title">{t('previewDescription')}</Dialog.Title>
        <Dialog.Close class="icon-button" aria-label={t('dismiss')}><X /></Dialog.Close>
      </div>
      <Dialog.Description class="description-full">{descriptionModal || '—'}</Dialog.Description>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
