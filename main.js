const { app, BrowserWindow, ipcMain, dialog } = require('electron')
const path = require('path')
const fs = require('fs')
const pty = require('node-pty')

const terminals = {}
let nextTerminalId = 1
const MEMORY_DIR = path.join(__dirname, 'Memory')

const MEMORY_TEMPLATES = {
  'vision.md': '# Vision\n\nProject vision, goals, and long-term objectives.\n',
  'architecture.md': '# Architecture\n\nSystem architecture overview and design decisions.\n',
  'tasks.md': '# Tasks\n\nActive and completed tasks.\n',
  'progress.md': '# Progress\n\nDevelopment progress and milestones.\n',
  'decisions.md': '# Decisions\n\nKey technical decisions and rationale.\n',
  'bugs.md': '# Bugs\n\nKnown issues and bugs.\n',
}

function ensureMemoryDir() {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true })
  }
  for (const [name, content] of Object.entries(MEMORY_TEMPLATES)) {
    const fp = path.join(MEMORY_DIR, name)
    if (!fs.existsSync(fp)) {
      fs.writeFileSync(fp, content, 'utf-8')
    }
  }
}

function getShell() {
  return process.platform === 'win32'
    ? process.env.COMSPEC || 'cmd.exe'
    : process.env.SHELL || 'bash'
}

function getProviderCommand(provider, customCommand) {
  if (provider === 'custom' && customCommand) return customCommand
  const commands = {
    'opencode': 'opencode',
    'claude-code': 'claude',
    'codex-cli': 'codex',
    'gemini-cli': 'gemini',
  }
  return commands[provider] || null
}

function spawnTerminal(id, options) {
  const shell = getShell()
  const cwd = options.cwd || __dirname

  console.log("Spawning terminal with shell:", shell, "cwd:", cwd)

  const term = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cwd: cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
    cols: options.cols || 80,
    rows: options.rows || 24,
  })

  term.onData((data) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.webContents.send('terminal:output', { id, data })
  })

  term.onExit(({ exitCode }) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (win) win.webContents.send('terminal:exit', { id, exitCode })
    delete terminals[id]
  })

  terminals[id] = {
    write: (data) => term.write(data),
    resize: (cols, rows) => term.resize(cols, rows),
    kill: () => { term.kill(); delete terminals[id] },
    process: term,
  }

  const command = getProviderCommand(options.provider, options.command)
  if (command) {
    term.write(`${command}\r`)
  }

  return id
}

let mainWindow

function createWindow() {
  ensureMemoryDir()
  setupMemoryWatcher()

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1a1b1e',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.loadFile('index.html')
}

let memoryWatcher

function setupMemoryWatcher() {
  try {
    memoryWatcher = fs.watch(MEMORY_DIR, (eventType, filename) => {
      const wins = BrowserWindow.getAllWindows()
      for (const win of wins) {
        win.webContents.send('memory:changed', { event: eventType, file: filename })
      }
    })
  } catch {
    // file watching not critical
  }
}

ipcMain.handle('fs:listDir', async (_e, dirPath) => {
  try {
    const resolved = path.resolve(dirPath || __dirname)
    const entries = fs.readdirSync(resolved, { withFileTypes: true })
    return {
      path: resolved,
      parent: path.dirname(resolved),
      entries: entries.map((e) => ({
        name: e.name,
        isDirectory: e.isDirectory(),
        isFile: e.isFile(),
        isSymlink: e.isSymbolicLink(),
        size: e.isFile() ? fs.statSync(path.join(resolved, e.name)).size : 0,
      })).sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      }),
    }
  } catch {
    return null
  }
})

ipcMain.handle('fs:readFile', async (_e, filePath) => {
  try {
    const resolved = path.resolve(filePath)
    const stat = fs.statSync(resolved)
    if (!stat.isFile()) return null
    const ext = path.extname(resolved).toLowerCase()
    const textExts = ['.md', '.txt', '.js', '.jsx', '.ts', '.tsx', '.json', '.html', '.css', '.py', '.java', '.c', '.cpp', '.h', '.hpp', '.rs', '.go', '.rb', '.php', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.env', '.gitignore', '.sh', '.bat', '.ps1', '.xml', '.svg', '.sql', '.vue', '.svelte', '.astro']
    const isText = textExts.includes(ext)
    if (!isText) return { binary: true, name: path.basename(resolved), size: stat.size }
    return { binary: false, content: fs.readFileSync(resolved, 'utf-8'), name: path.basename(resolved), size: stat.size }
  } catch {
    return null
  }
})

ipcMain.handle('fs:getProjectRoot', async () => {
  return __dirname
})

ipcMain.handle('fs:selectFolder', async () => {
  const win = BrowserWindow.getAllWindows()[0]
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  if (result.canceled || result.filePaths.length === 0) return null
  return result.filePaths[0]
})

ipcMain.handle('fs:createFile', async (_e, dir, name) => {
  try {
    const fp = path.join(dir, name)
    if (fs.existsSync(fp)) return false
    fs.writeFileSync(fp, '', 'utf-8')
    return true
  } catch { return false }
})

ipcMain.handle('fs:createFolder', async (_e, dir, name) => {
  try {
    const fp = path.join(dir, name)
    if (fs.existsSync(fp)) return false
    fs.mkdirSync(fp, { recursive: true })
    return true
  } catch { return false }
})

ipcMain.handle('memory:list', async () => {
  try {
    const files = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md'))
    return files.map((f) => {
      const stat = fs.statSync(path.join(MEMORY_DIR, f))
      return {
        name: f,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
})

ipcMain.handle('memory:read', async (_e, name) => {
  try {
    const fp = path.join(MEMORY_DIR, name)
    if (!fp.startsWith(MEMORY_DIR)) return null
    return fs.readFileSync(fp, 'utf-8')
  } catch {
    return null
  }
})

ipcMain.handle('terminal:create', async (_e, options) => {
  const id = nextTerminalId++
  spawnTerminal(id, options)
  return id
})

ipcMain.on('terminal:write', (_e, id, data) => {
  const term = terminals[id]
  if (term) term.write(data)
})

ipcMain.on('terminal:resize', (_e, id, cols, rows) => {
  const term = terminals[id]
  if (term) term.resize(cols, rows)
})

ipcMain.handle('terminal:kill', async (_e, id) => {
  const term = terminals[id]
  if (term) {
    term.kill()
    delete terminals[id]
  }
})

app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (memoryWatcher) memoryWatcher.close()
  for (const term of Object.values(terminals)) term.kill()
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
