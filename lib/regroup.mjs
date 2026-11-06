import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { readJson, writeJson, exists, realCase } from './paths.mjs'

const key = (value) => String(value || '').replace(/[\\/]+$/u, '').toLowerCase()
const SESSION_FILE = /^session(\.[^\\/]+)?\.jsonl\.zstd$/u

function walkSessions(root) {
  const out = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
      } else if (SESSION_FILE.test(entry.name)) {
        out.push({ key: key(path.basename(dir)), leaf: path.basename(dir) })
      }
    }
  }
  return out
}

function readCwds(cacheDir) {
  const map = new Map()
  let names = []
  try {
    names = fs.readdirSync(cacheDir)
  } catch {
    return map
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const data = readJson(path.join(cacheDir, name))
    const cwd = data?.record?.identity?.cwd
    if (!cwd) continue
    const base = name.slice(0, -5).toLowerCase()
    map.set(base, cwd)
    map.set(base.replace(/^session-/u, ''), cwd)
  }
  return map
}

function readMappings(stickRoot) {
  const byId = new Map()
  const dir = path.join(stickRoot, 'machines')
  let names = []
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return byId
  }
  for (const name of names) {
    const data = readJson(path.join(dir, name))
    if (!data) continue
    for (const [id, value] of Object.entries(data)) {
      if (id.startsWith('_') || !value?.path) continue
      const list = byId.get(id) || []
      list.push({ machine: name.slice(0, -5), path: value.path })
      byId.set(id, list)
    }
  }
  return byId
}

/**
 * Attach downloaded sessions to this laptop's workspaces, using the projection
 * cache for the original folder and machines/*.json to translate project paths.
 * Only adds links; never removes sessions or workspaces.
 */
export function regroupSessions({ dshHome, stickRoot }) {
  const wsFile = path.join(dshHome, 'storages', 'workspace.json')
  const ws = readJson(wsFile)
  if (!ws?.global || !ws?.tables?.workspaces) return { ok: false, error: 'no usable workspace registry' }

  const host = process.env.COMPUTERNAME || os.hostname()
  const sessions = walkSessions(path.join(dshHome, 'sessions'))
  const cwds = readCwds(path.join(dshHome, 'storages', 'session_projcache', 'sessions'))
  const mappings = readMappings(stickRoot || '')
  const own = (() => {
    const data = readJson(path.join(stickRoot || '', 'machines', `${host}.json`))
    const out = new Map()
    if (data) for (const [id, value] of Object.entries(data)) if (!id.startsWith('_') && value?.path) out.set(id, value.path)
    return out
  })()

  const ids = Array.isArray(ws.global.workspaceIds) ? ws.global.workspaceIds : Object.keys(ws.tables.workspaces)
  const byPath = new Map()
  let caseFixed = 0
  for (const id of ids) {
    const row = ws.tables.workspaces[id]
    if (!row) continue
    if (row.path) {
      const real = realCase(row.path)
      if (real && real !== row.path) {
        row.path = real
        row.updatedAt = new Date().toISOString()
        caseFixed += 1
      }
      byPath.set(key(row.path), id)
    }
  }

  const resolve = (cwd) => {
    const direct = byPath.get(key(cwd))
    if (direct) return direct
    for (const [id, local] of own) {
      const all = mappings.get(id) || []
      for (const other of all) {
        const base = key(other.path)
        if (key(cwd) === base) {
          const hit = byPath.get(key(local))
          if (hit) return hit
        } else if (key(cwd).startsWith(base + '\\')) {
          const rest = cwd.slice(other.path.length)
          const hit = byPath.get(key(local + rest))
          if (hit) return hit
        }
      }
    }
    const user = /^[A-Za-z]:\\Users\\[^\\]+/u.exec(cwd)
    if (user && key(user[0]) !== key(os.homedir())) {
      const hit = byPath.get(key(os.homedir() + cwd.slice(user[0].length)))
      if (hit) return hit
    }
    let best = ''
    let bestLen = -1
    for (const [p, id] of byPath) {
      if (p !== '' && key(cwd).startsWith(p + '\\') && p.length > bestLen) {
        best = id
        bestLen = p.length
      }
    }
    return best
  }

  const registered = new Set()
  for (const id of ids) {
    for (const sid of ws.tables.workspaces[id]?.sessionIds || []) registered.add(key(sid))
  }

  const leafByKey = new Map()
  for (const entry of sessions) leafByKey.set(entry.key, entry.leaf)

  let added = 0
  let unreadable = 0
  for (const entry of sessions) {
    if (registered.has(entry.key)) continue
    const cwd = cwds.get(entry.key) || cwds.get('session-' + entry.key)
    if (!cwd) {
      unreadable += 1
      continue
    }
    const target = resolve(cwd)
    if (!target) continue
    const row = ws.tables.workspaces[target]
    if (!row) continue
    if (!Array.isArray(row.sessionIds)) row.sessionIds = []
    row.sessionIds.push(leafByKey.get(entry.key) || entry.leaf)
    row.updatedAt = new Date().toISOString()
    registered.add(entry.key)
    added += 1
  }

  let renamed = 0
  for (const id of ids) {
    const row = ws.tables.workspaces[id]
    if (!row || !Array.isArray(row.sessionIds)) continue
    row.sessionIds = row.sessionIds.map((sid) => {
      const leaf = leafByKey.get(key(sid))
      if (leaf && leaf !== sid) {
        renamed += 1
        return leaf
      }
      return sid
    })
  }
  for (const field of ['archivedSessionIds', 'pinnedSessionIds']) {
    if (!Array.isArray(ws.global[field])) continue
    ws.global[field] = ws.global[field].map((sid) => leafByKey.get(key(sid)) || sid)
  }

  const changed = added > 0 || renamed > 0 || caseFixed > 0
  if (changed) writeJson(wsFile, ws)
  return { ok: true, added, renamed, caseFixed, unreadable, changed }
}

