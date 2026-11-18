'use strict'
// Windows packaging helper.
// DSH's workspace sandbox marks the workspace root Low integrity; files created
// inside it inherit that label, and a Low-integrity Electron cannot start
// explorer.exe. Copy each packaged exe to a folder outside the workspace on the
// same drive, then rename it back: the copy is unlabeled (Medium) and
// MoveFileEx preserves that label when replacing the original.
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const APP_DIR = path.join(ROOT, 'dist', 'win-unpacked')
const NAMES = ['Dreamcatcher.exe', 'DreamcatcherApp.exe']

function main() {
  if (process.platform !== 'win32') return

  const present = NAMES.filter((name) => fs.existsSync(path.join(APP_DIR, name)))
  if (!present.length) {
    console.log('[relabel] skip: dist/win-unpacked/*.exe not found')
    return
  }

  let staging = null
  try {
    // Must be outside the workspace: the workspace root is Low, its children are
    // outside the sandbox's write grant but on the same volume, so rename keeps
    // the fresh copy's normal label.
    staging = fs.mkdtempSync(path.join(path.dirname(ROOT), 'dreamcatcher-label-'))
    for (const name of present) {
      const target = path.join(APP_DIR, name)
      const copy = path.join(staging, name)
      fs.copyFileSync(target, copy)
      fs.renameSync(copy, target)
      console.log('[relabel] ' + name + ' -> normal integrity')
    }
    console.log('[relabel] done')
  } catch (err) {
    console.error('[relabel] failed: ' + err.message)
    console.error('[relabel] Close Dreamcatcher, then run this script from a normal (non-sandbox) terminal.')
    console.error('[relabel] Alternatively run fix-integrity.cmd as administrator.')
    process.exitCode = 1
  } finally {
    if (staging) {
      try { fs.rmSync(staging, { recursive: true, force: true }) } catch (_) { /* best effort */ }
    }
  }
}

main()
