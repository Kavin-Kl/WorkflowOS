import fs from 'node:fs'
import path from 'node:path'
import type { SensorStatus } from '../../shared/types'
import type { RawEvent } from '../agent'

const TEMP = /\.(crdownload|part|download|tmp|partial)$|^\.|^~\$/i

/** Watches folders (Downloads by default) for newly created files. */
export class FileSensor {
  private watchers: fs.FSWatcher[] = []
  private recent = new Map<string, number>()
  status: SensorStatus = { name: 'File watcher', state: 'stopped' }

  constructor(private emit: (e: RawEvent) => void) {}

  start(folders: string[]) {
    this.stop()
    const ok: string[] = []
    for (const folder of folders) {
      try {
        const w = fs.watch(folder, { persistent: false }, (_type, name) => name && this.onChange(folder, String(name)))
        this.watchers.push(w)
        ok.push(path.basename(folder))
      } catch {
        // folder missing or not permitted; skip
      }
    }
    this.status = ok.length
      ? { name: 'File watcher', state: 'running', detail: ok.join(', ') }
      : { name: 'File watcher', state: 'unavailable', detail: 'No watchable folders' }
  }

  stop() {
    for (const w of this.watchers) w.close()
    this.watchers = []
    this.status = { name: 'File watcher', state: 'stopped' }
  }

  private onChange(folder: string, name: string) {
    if (TEMP.test(name)) return
    const full = path.join(folder, name)
    const now = Date.now()
    if ((this.recent.get(full) ?? 0) > now - 5000) return
    this.recent.set(full, now)
    // Give the writer a moment, then confirm the file really exists.
    setTimeout(() => {
      fs.stat(full, (err, st) => {
        if (err || !st.isFile()) return
        this.emit({
          source: 'file',
          kind: 'file_created',
          app: 'Files',
          path: full,
          target: `file:${path.extname(name).slice(1).toLowerCase() || 'file'}`,
          data: { name, size: st.size, folder: path.basename(folder) },
        })
      })
    }, 600)
    if (this.recent.size > 500) this.recent.clear()
  }
}
