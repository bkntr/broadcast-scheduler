import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import { AuthService } from './auth'
import { registerIpc } from './ipc'
import { SchedulerService } from './scheduler'
import { AppStore } from './storage'
import { YouTubeService } from './youtube'

let mainWindow: BrowserWindow | undefined
let forceClose = false
const EXTERNAL_HOSTS = new Set(['github.com', 'studio.youtube.com', 'www.youtube.com'])

const singleInstance = app.requestSingleInstanceLock()
if (!singleInstance) app.quit()

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1120,
    height: 800,
    minWidth: 880,
    minHeight: 640,
    show: false,
    title: 'YouTube Scheduler',
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })
  window.once('ready-to-show', () => window.show())
  window.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' && EXTERNAL_HOSTS.has(parsed.hostname)) void shell.openExternal(parsed.toString())
    } catch {
      // Ignore malformed links.
    }
    return { action: 'deny' }
  })
  return window
}

void app.whenReady().then(async () => {
  log.initialize()
  log.transports.file.maxSize = 1_000_000
  log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}'
  app.setAppUserModelId('com.bkntr.youtube-scheduler')

  const store = new AppStore()
  await store.load()
  const auth = new AuthService(store)
  const youtube = new YouTubeService(auth, store)
  const scheduler = new SchedulerService(store, youtube, () => mainWindow)

  mainWindow = createWindow()
  mainWindow.on('close', (event) => {
    if (scheduler.isRunning() && !forceClose) {
      event.preventDefault()
      mainWindow?.webContents.send('app:closeRequested')
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = undefined
  })

  registerIpc({
    store,
    auth,
    youtube,
    scheduler,
    window: () => mainWindow,
    requestClose: (mode) => {
      if (mode === 'keep') return
      if (mode === 'stop') {
        scheduler.requestStop()
        return
      }
      forceClose = true
      mainWindow?.close()
    }
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
})

app.on('window-all-closed', () => app.quit())
