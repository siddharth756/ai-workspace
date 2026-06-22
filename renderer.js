const terminals = new Map()
const realToLocal = new Map()
let nextTerminalId = 1

const terminalGrid = document.getElementById('terminal-grid')
const addBtn = document.getElementById('add-terminal-btn')
const terminalCount = document.getElementById('terminal-count')

let terminalOutputCleanup = null
let terminalExitCleanup = null

function setupTerminalListeners() {
  terminalOutputCleanup = window.api.terminal.onOutput(({ id, data }) => {
    const localId = realToLocal.get(id)
    const t = terminals.get(localId)
    if (t && t.control) {
      t.control.write(data)
    }
  })

  terminalExitCleanup = window.api.terminal.onExit(({ id }) => {
    const localId = realToLocal.get(id)
    const t = terminals.get(localId)
    if (t) t.status = 'stopped'
  })
}

async function createTerminal(options) {
  const termId = nextTerminalId++

  const card = document.createElement('div')
  card.className = 'terminal-card'
  card.dataset.terminalId = termId
  card.innerHTML = `
    <div class="terminal-header">
      <span class="terminal-name">${escapeHtml(options.name) || 'CMD'}</span>
      <div class="terminal-actions">
        <button class="icon-btn" data-action="split" title="Split Terminal">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="2" y="3" width="20" height="18" rx="2"/>
            <line x1="12" y1="3" x2="12" y2="21"/>
          </svg>
        </button>
        <button class="icon-btn danger" data-action="close" title="Close">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6 6 18M6 6l12 12"/>
          </svg>
        </button>
      </div>
    </div>
    <div class="terminal-body"></div>
  `

  card.querySelector('[data-action="close"]').addEventListener('click', () => closeTerminal(termId))
  card.querySelector('[data-action="split"]').addEventListener('click', () => createTerminal({ name: 'CMD', cwd: options.cwd }))
  terminalGrid.appendChild(card)

  const termBody = card.querySelector('.terminal-body')

  const control = window.TerminalFactory.create(termBody, {
    cursorBlink: true,
    cursorStyle: 'bar',
    fontSize: 13,
    fontFamily: "'Consolas', 'Courier New', monospace",
    theme: {
      background: '#1a1b1e',
      foreground: '#e4e4e7',
      cursor: '#e4e4e7',
      selectionBackground: '#6366f140',
      black: '#1a1b1e',
      red: '#ef4444',
      green: '#22c55e',
      yellow: '#f59e0b',
      blue: '#6366f1',
      magenta: '#a855f7',
      cyan: '#22d3ee',
      white: '#e4e4e7',
      brightBlack: '#6b6b76',
      brightRed: '#f87171',
      brightGreen: '#4ade80',
      brightYellow: '#fbbf24',
      brightBlue: '#818cf8',
      brightMagenta: '#c084fc',
      brightCyan: '#67e8f9',
      brightWhite: '#f4f4f5',
    },
    scrollback: 5000,
  })

  if (!control) {
    termBody.textContent = 'Failed to create terminal'
    return
  }

  const t = {
    control,
    card,
    options,
    status: 'running',
    id: termId,
    realId: null,
  }
  terminals.set(termId, t)

  control.writeln('Loading terminal...')

  // Initial fit to get actual container dimensions
  control.fit()

  // Pass actual dimensions when spawning
  const createOpts = { ...options, cols: control.cols, rows: control.rows }
  const realId = await window.api.terminal.create(createOpts)
  t.realId = realId
  realToLocal.set(realId, termId)

  control.onData((data) => window.api.terminal.write(realId, data))

  // onResize is the single source of truth for resize
  control.onResize(({ cols, rows }) => {
    window.api.terminal.resize(realId, cols, rows)
  })

  let resizeTimer
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      control.fit()
      // onResize above will propagate the new size
    }, 50)
  })
  ro.observe(termBody)
  t.resizeObserver = ro

  updateGrid()
}

async function closeTerminal(localId) {
  const t = terminals.get(localId)
  if (!t) return

  if (t.realId) {
    realToLocal.delete(t.realId)
    await window.api.terminal.kill(t.realId)
  }
  t.control.dispose()
  t.resizeObserver.disconnect()
  t.card.remove()
  terminals.delete(localId)
  updateGrid()
}

async function restartTerminal(localId) {
  const t = terminals.get(localId)
  if (!t) return
  const cwd = t.options.cwd
  await closeTerminal(localId)
  await createTerminal({ name: 'CMD', cwd })
}

function updateGrid() {
  const count = terminals.size

  let cols = 1
  if (count >= 5) cols = 3
  else if (count >= 2) cols = 2

  terminalGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`

  if (count === 3) {
    const cards = terminalGrid.querySelectorAll('.terminal-card')
    if (cards[2]) cards[2].style.gridColumn = '1 / -1'
  } else {
    terminalGrid.querySelectorAll('.terminal-card').forEach((c) => {
      c.style.gridColumn = ''
    })
  }

  updateTerminalCount()
}

addBtn.addEventListener('click', async () => {
  const root = await window.api.fs.getProjectRoot()
  createTerminal({ name: 'CMD', cwd: root })
})

function escapeHtml(str) {
  const div = document.createElement('div')
  div.textContent = str
  return div.innerHTML
}

const currentDirEl = document.getElementById('current-dir')

async function updateCurrentDir() {
  const root = await window.api.fs.getProjectRoot()
  currentDirEl.textContent = root
}

function updateTerminalCount() {
  terminalCount.textContent = `${terminals.size} terminal${terminals.size !== 1 ? 's' : ''}`
}

/* ======== Left Panel — Memory ======== */
const leftPanel = document.getElementById('left-panel')
const memoryList = document.getElementById('memory-list')
const memoryViewer = document.getElementById('memory-viewer')
const viewerFilename = document.getElementById('viewer-filename')
const viewerContent = document.getElementById('viewer-content')
const closeViewerBtn = document.getElementById('close-viewer')
const togglePanelBtn = document.getElementById('toggle-panel-btn')
const resizeHandle = document.getElementById('panel-resize-handle')

let selectedFile = null

async function loadMemoryList() {
  const files = await window.api.memory.list()
  memoryList.innerHTML = ''
  for (const f of files) {
    const item = document.createElement('div')
    item.className = `memory-item${selectedFile === f.name ? ' active' : ''}`
    item.innerHTML = `
      <span class="memory-item-icon">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
          <polyline points="14 2 14 8 20 8"/>
          <line x1="12" y1="18" x2="12" y2="12"/>
          <line x1="9" y1="15" x2="15" y2="15"/>
        </svg>
      </span>
      <span class="memory-item-name">${escapeHtml(f.name)}</span>
      <span class="memory-item-size">${f.size}B</span>
    `
    item.addEventListener('click', () => showMemoryFile(f.name))
    memoryList.appendChild(item)
  }
}

async function showMemoryFile(name) {
  selectedFile = name
  const content = await window.api.memory.read(name)

  document.querySelectorAll('.memory-item').forEach((el) => {
    const nameEl = el.querySelector('.memory-item-name')
    el.classList.toggle('active', nameEl && nameEl.textContent === name)
  })

  if (content == null) {
    viewerFilename.textContent = name
    viewerContent.textContent = 'Error: could not read file'
  } else {
    viewerFilename.textContent = name
    viewerContent.textContent = content
  }
  memoryViewer.classList.remove('hidden')
}

closeViewerBtn.addEventListener('click', () => {
  memoryViewer.classList.add('hidden')
  selectedFile = null
  document.querySelectorAll('.memory-item').forEach((el) => el.classList.remove('active'))
})

togglePanelBtn.addEventListener('click', () => {
  leftPanel.classList.toggle('collapsed')
})

// Panel resize
let isResizing = false
resizeHandle.addEventListener('mousedown', (e) => {
  isResizing = true
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
})

document.addEventListener('mousemove', (e) => {
  if (!isResizing) return
  const newWidth = Math.max(200, Math.min(400, e.clientX))
  leftPanel.style.width = newWidth + 'px'
  leftPanel.style.flex = 'none'
})

document.addEventListener('mouseup', () => {
  if (isResizing) {
    isResizing = false
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
  }
})

/* ======== Left Panel — Folder ======== */
const folderList = document.getElementById('folder-list')
const folderPath = document.getElementById('folder-path')
const openFolderBtn = document.getElementById('open-folder-btn')
const newFileBtn = document.getElementById('new-file-btn')
const newFolderBtn = document.getElementById('new-folder-btn')

let currentFolder = null
let folderHistory = []

async function loadFolder(dirPath) {
  currentFolder = dirPath
  const result = await window.api.fs.listDir(dirPath)
  if (!result) return
  folderPath.textContent = result.path
  folderList.innerHTML = ''
  for (const entry of result.entries) {
    const item = document.createElement('div')
    item.className = 'folder-entry'
    if (entry.isDirectory) {
      item.innerHTML = `
        <span class="folder-entry-icon">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
          </svg>
        </span>
        <span class="folder-entry-name">${escapeHtml(entry.name)}</span>
      `
      const fullPath = pathJoin(result.path, entry.name)
      item.addEventListener('click', () => {
        folderHistory.push(result.path)
        loadFolder(fullPath)
      })
      item.addEventListener('contextmenu', (e) => showContextMenu(e, fullPath))
    } else {
      const sizeStr = entry.size < 1024 ? `${entry.size}B` : `${(entry.size / 1024).toFixed(1)}KB`
      item.innerHTML = `
        <span class="folder-entry-icon">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
          </svg>
        </span>
        <span class="folder-entry-name">${escapeHtml(entry.name)}</span>
        <span class="folder-entry-size">${sizeStr}</span>
      `
      item.addEventListener('click', () => showFileInViewer(entry.name, result.path))
    }
    folderList.appendChild(item)
  }
  // Add back button if we have history
  if (folderHistory.length > 0) {
    const back = document.createElement('div')
    back.className = 'folder-entry'
    back.innerHTML = `
      <span class="folder-entry-icon" style="opacity:0.4">↑</span>
      <span class="folder-entry-name" style="color:var(--text-muted)">..</span>
    `
    back.addEventListener('click', () => {
      const prev = folderHistory.pop()
      if (prev) loadFolder(prev)
    })
    folderList.prepend(back)
  }
}

async function showFileInViewer(name, dir) {
  const filePath = pathJoin(dir, name)
  const result = await window.api.fs.readFile(filePath)
  if (!result || result.binary) {
    viewerFilename.textContent = name
    viewerContent.textContent = result ? '(binary file)' : 'Error: could not read file'
  } else {
    viewerFilename.textContent = name
    viewerContent.textContent = result.content
  }
  memoryViewer.classList.remove('hidden')
  document.querySelectorAll('.memory-item').forEach((el) => el.classList.remove('active'))
}

folderPath.addEventListener('contextmenu', (e) => {
  if (currentFolder) showContextMenu(e, currentFolder)
})

openFolderBtn.addEventListener('click', async () => {
  const dir = await window.api.fs.selectFolder()
  if (dir) {
    folderHistory = []
    loadFolder(dir)
  }
})

newFileBtn.addEventListener('click', async () => {
  const name = prompt('File name:')
  if (!name || !currentFolder) return
  const ok = await window.api.fs.createFile(currentFolder, name)
  if (ok) loadFolder(currentFolder)
})

newFolderBtn.addEventListener('click', async () => {
  const name = prompt('Folder name:')
  if (!name || !currentFolder) return
  const ok = await window.api.fs.createFolder(currentFolder, name)
  if (ok) loadFolder(currentFolder)
})

// Simple path join (no dep needed)
function pathJoin(...parts) {
  return parts.join('/').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '') || '/'
}

/* ======== Context Menu ======== */
const ctxMenu = document.getElementById('context-menu')
const ctxOpenTerminal = ctxMenu.querySelector('[data-action="open-terminal"]')
let ctxTargetPath = null

function showContextMenu(e, targetPath) {
  e.preventDefault()
  ctxTargetPath = targetPath
  ctxMenu.style.left = e.clientX + 'px'
  ctxMenu.style.top = e.clientY + 'px'
  ctxMenu.classList.remove('hidden')
}

function hideContextMenu() {
  ctxMenu.classList.add('hidden')
  ctxTargetPath = null
}

document.addEventListener('click', (e) => {
  if (!ctxMenu.contains(e.target)) hideContextMenu()
})

ctxOpenTerminal.addEventListener('click', () => {
  if (ctxTargetPath) {
    createTerminal({ name: 'CMD', cwd: ctxTargetPath })
  }
  hideContextMenu()
})

// Watch for changes
let memCleanup = null

async function init() {
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 't') {
      e.preventDefault()
      addBtn.click()
    }
  })

  setupTerminalListeners()

  await loadMemoryList()
  memCleanup = window.api.memory.onChanged(() => loadMemoryList())

  const root = await window.api.fs.getProjectRoot()
  updateCurrentDir()

  await loadFolder(root)

  await createTerminal({ name: 'CMD', cwd: root })
}

init()
