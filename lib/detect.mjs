import fs from 'node:fs'
import path from 'node:path'

/**
 * A folder is the sync stick when it still holds the shared repository (or, at
 * least, the manual entry script). Nothing is created or modified here.
 * @param {string} root - absolute folder, e.g. U:\\dsh-usb-sync
 * @returns {boolean}
 */
export function looksLikeStick(root) {
  if (!root) return false
  try {
    if (!fs.statSync(root).isDirectory()) return false
  } catch {
    return false
  }
  const repo = path.join(root, 'repo.git')
  if (fs.existsSync(repo)) return true
  return fs.existsSync(path.join(root, 'dsh-sync.ps1'))
}

/**
 * Resolve the stick folder: an explicit path wins, otherwise every drive
 * letter is tried from C to Z so the letter can change between plug-ins.
 * @param {{ stickPath?: string, stickFolder?: string }} cfg
 * @returns {{ root: string, drive: string } | null}
 */
export function findStick(cfg) {
  const folder = cfg.stickFolder || 'dsh-usb-sync'
  if (cfg.stickPath) {
    const root = String(cfg.stickPath).replace(/[\\/]+$/, '')
    return looksLikeStick(root) ? { root, drive: path.parse(root).root } : null
  }
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const root = `${letter}:${path.sep}${folder}`
    if (looksLikeStick(root)) return { root, drive: `${letter}:${path.sep}` }
  }
  return null
}

export function stickRepo(root) {
  return path.join(root, 'repo.git')
}

