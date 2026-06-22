const { contextBridge, ipcRenderer } = require('electron')
const { Terminal } = require('xterm')
const { FitAddon } = require('xterm-addon-fit')

contextBridge.exposeInMainWorld('api', {
  fs: {
    listDir: (dirPath) => ipcRenderer.invoke('fs:listDir', dirPath),
    readFile: (filePath) => ipcRenderer.invoke('fs:readFile', filePath),
    getProjectRoot: () => ipcRenderer.invoke('fs:getProjectRoot'),
  },
  memory: {
    list: () => ipcRenderer.invoke('memory:list'),
    read: (name) => ipcRenderer.invoke('memory:read', name),
    onChanged: (cb) => {
      ipcRenderer.on('memory:changed', (_e, data) => cb(data))
      return () => ipcRenderer.removeAllListeners('memory:changed')
    },
  },
  terminal: {
    create: (opts) => ipcRenderer.invoke('terminal:create', opts),
    write: (id, data) => ipcRenderer.send('terminal:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', id, cols, rows),
    kill: (id) => ipcRenderer.invoke('terminal:kill', id),
    onOutput: (cb) => {
      ipcRenderer.on('terminal:output', (_e, data) => cb(data))
      return () => ipcRenderer.removeAllListeners('terminal:output')
    },
    onExit: (cb) => {
      ipcRenderer.on('terminal:exit', (_e, data) => cb(data))
      return () => ipcRenderer.removeAllListeners('terminal:exit')
    },
  },
})

contextBridge.exposeInMainWorld('TerminalFactory', {
  create: (container, options) => {
    try {
      const term = new Terminal(options)
      const fitAddon = new FitAddon()
      term.loadAddon(fitAddon)
      term.open(container)
      fitAddon.fit()
      return {
        onData: (cb) => term.onData(cb),
        onResize: (cb) => term.onResize(({ cols, rows }) => cb({ cols, rows })),
        write: (data) => term.write(data),
        writeln: (data) => term.writeln(data),
        clear: () => term.clear(),
        dispose: () => { term.dispose(); fitAddon.dispose() },
        fit: () => fitAddon.fit(),
        get cols() { return term.cols },
        get rows() { return term.rows },
      }
    } catch (err) {
      console.error('TerminalFactory.create failed:', err)
      return null
    }
  },
})
