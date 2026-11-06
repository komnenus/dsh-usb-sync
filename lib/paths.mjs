import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function resolveDshHome(configured) {
  if (configured) return path.resolve(configured)
  if (process.env.DSH_HOME) return path.resolve(process.env.DSH_HOME)
  return path.join(os.homedir(), '.dsh')
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, ''))
  } catch {
    return null
  }
}

export function writeJson(file, value) {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
}

export function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

export function exists(p) {
  try {
    fs.statSync(p)
    return true
  } catch {
    return false
  }
}

/** The on-disk spelling of a path (Windows keeps the case it was created with). */
export function realCase(p) {
  try {
    return fs.realpathSync.native(p)
  } catch {
    return p
  }
}

