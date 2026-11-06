import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { makeGit, lastLine } from './git.mjs'
import { findStick, stickRepo } from './detect.mjs'
import { resolveDshHome, ensureDir, readJson, writeJson, readText, exists } from './paths.mjs'
import { keepLocalAndArchive, listConflictSets, readConflictSet, applyChoice } from './conflicts.mjs'
import { regroupSessions } from './regroup.mjs'

const REGISTRY = ['storages/workspace.json', 'storages/workspace-local-paths.json']
const IGNORE_LINES = ['storages/workspace.json', 'storages/workspace-local-paths.json', 'storages/*.bak']
const NOTHING_TO_COMMIT = /nothing to commit|nothing added to commit|no changes added/iu

export class Engine {
  /**
   * @param {object} cfg resolved configuration
   * @param {{ info: Function, warn: Function, error: Function }} logger
   */
  constructor(cfg, logger) {
    this.cfg = cfg
    this.logger = logger
    this.git = makeGit(cfg)
    this.home = resolveDshHome(cfg.dshHome)
    this.host = process.env.COMPUTERNAME || os.hostname()
    this.stateDir = path.join(this.home, '.chatsync-local', 'usb-auto')
    this.stateFile = path.join(this.stateDir, 'state.json')
  }

  stick() {
    return findStick(this.cfg)
  }

  state() {
    return readJson(this.stateFile) || {}
  }

  saveState(patch) {
    try {
      writeJson(this.stateFile, { ...this.state(), ...patch })
    } catch (error) {
      this.logger.warn(`could not save state: ${error.message}`)
    }
  }

  archiveRoot() {
    return path.join(this.stateDir, 'conflicts')
  }

  async lock() {
    const file = path.join(this.stateDir, 'lock')
    ensureDir(this.stateDir)
    if (exists(file)) {
      const age = Date.now() - fs.statSync(file).mtimeMs
      if (age < 10 * 60 * 1000) return { ok: false, error: 'another sync is still running' }
    }
    fs.writeFileSync(file, String(process.pid), 'utf8')
    return { ok: true, file }
  }

  unlock(file) {
    try {
      fs.unlinkSync(file)
    } catch {}
  }

  async ensureRemote(repoDir) {
    const list = await this.git(['remote'], this.home)
    const names = String(list.stdout || '').split(/\s+/u).filter(Boolean)
    if (!names.includes('usb')) {
      await this.git(['remote', 'add', 'usb', repoDir], this.home)
      return
    }
    const current = await this.git(['remote', 'get-url', 'usb'], this.home)
    if (String(current.stdout || '').trim() !== repoDir) {
      await this.git(['remote', 'set-url', 'usb', repoDir], this.home)
    }
  }

  snapshotRegistry() {
    const out = { files: {}, stamp: new Date().toISOString().replace(/[:.]/gu, '-') }
    for (const rel of REGISTRY) {
      const text = readText(path.join(this.home, rel))
      if (text !== null) out.files[rel] = text
    }
    try {
      const dir = path.join(this.stateDir, 'backups', out.stamp)
      ensureDir(dir)
      for (const [rel, text] of Object.entries(out.files)) {
        fs.writeFileSync(path.join(dir, path.basename(rel)), text, 'utf8')
      }
    } catch {}
    return out
  }

  async restoreRegistry(snapshot) {
    for (const [rel, text] of Object.entries(snapshot.files)) {
      const file = path.join(this.home, rel)
      ensureDir(path.dirname(file))
      fs.writeFileSync(file, text, 'utf8')
    }
  }

  async ensureIgnore() {
    const file = path.join(this.home, '.gitignore')
    const current = readText(file) || ''
    const lines = current.split(/\r?\n/u)
    let changed = false
    for (const want of IGNORE_LINES) {
      if (!lines.includes(want)) {
        lines.push(want)
        changed = true
      }
    }
    if (changed) fs.writeFileSync(file, lines.join('\n').replace(/\n+$/u, '') + '\n', 'utf8')
  }

  async commit(message) {
    const added = await this.git(['add', '-A'], this.home)
    if (!added.ok) return { ok: false, error: lastLine(added.stderr) }
    const result = await this.git(['commit', '-q', '-m', message], this.home)
    if (result.ok) return { ok: true }
    if (NOTHING_TO_COMMIT.test(String(result.stdout) + String(result.stderr))) return { ok: true, empty: true }
    return { ok: false, error: lastLine(result.stderr) }
  }

  /** Pull, keep this laptop's copy on conflicts, push, then regroup sessions. */
  async syncSessions() {
    if (!exists(path.join(this.home, '.git'))) return { ok: false, error: `no git repository in ${this.home}` }
    const stick = this.stick()
    if (!stick) return { ok: false, error: 'no USB stick with the sync folder was found' }
    const repoDir = stickRepo(stick.root)
    const lock = await this.lock()
    if (!lock.ok) return lock
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
      await this.ensureRemote(repoDir)
      const snapshot = this.snapshotRegistry()
      const committed = await this.commit(`sync ${this.host} ${stamp}`)
      if (!committed.ok) return { ok: false, error: `commit failed: ${committed.error}` }

      const pull = await this.git(['pull', '--no-rebase', '--no-edit', 'usb', this.cfg.branch], this.home)
      let conflict = null
      if (!pull.ok) {
        const unmerged = await this.git(['diff', '--name-only', '--diff-filter=U'], this.home)
        if (!String(unmerged.stdout || '').trim()) {
          return { ok: false, error: `pull failed: ${lastLine(pull.stderr)}` }
        }
        conflict = await keepLocalAndArchive({
          git: this.git,
          repo: this.home,
          archiveRoot: this.archiveRoot(),
          label: 'dsh-data',
          commitMessage: `merge dsh data on ${this.host}`,
          maxFiles: this.cfg.maxConflictFiles,
        })
        if (conflict.aborted) return { ok: false, error: 'conflicts ended the merge; the folder is unchanged' }
      }

      await this.restoreRegistry(snapshot)
      await this.ensureIgnore()
      await this.git(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...REGISTRY], this.home)
      await this.commit(`keep machine-local workspace list on ${this.host}`)

      const push = await this.git(['push', 'usb', this.cfg.branch], this.home)
      if (!push.ok) return { ok: false, error: `push failed: ${lastLine(push.stderr)}` }

      let regroup = null
      if (this.cfg.regroupOnPull) {
        try {
          regroup = regroupSessions({ dshHome: this.home, stickRoot: stick.root })
        } catch (error) {
          this.logger.warn(`regroup failed: ${error.message}`)
        }
      }
      this.saveState({
        lastSyncAt: new Date().toISOString(),
        stick: stick.root,
        lastConflicts: conflict ? conflict.count : 0,
        lastConflictDir: conflict ? conflict.dir : '',
        lastError: '',
      })
      return {
        ok: true,
        pulled: true,
        pushed: true,
        conflicts: conflict ? conflict.count : 0,
        conflictDir: conflict ? conflict.dir : '',
        regroup,
      }
    } catch (error) {
      this.saveState({ lastError: error.message })
      return { ok: false, error: error.message }
    } finally {
      this.unlock(lock.file)
    }
  }

  /** Files only: commit, pull (keep local on conflicts), push. No regrouping. */
  async pushOnly() {
    const stick = this.stick()
    if (!stick) return { ok: false, error: 'no USB stick found' }
    if (!exists(path.join(this.home, '.git'))) return { ok: false, error: 'no git repository' }
    const lock = await this.lock()
    if (!lock.ok) return lock
    try {
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
      await this.ensureRemote(stickRepo(stick.root))
      const snapshot = this.snapshotRegistry()
      const committed = await this.commit(`sync ${this.host} ${stamp}`)
      if (!committed.ok) return { ok: false, error: committed.error }
      const pull = await this.git(['pull', '--no-rebase', '--no-edit', 'usb', this.cfg.branch], this.home)
      let conflicts = 0
      if (!pull.ok) {
        const unmerged = await this.git(['diff', '--name-only', '--diff-filter=U'], this.home)
        if (!String(unmerged.stdout || '').trim()) return { ok: false, error: lastLine(pull.stderr) }
        const kept = await keepLocalAndArchive({
          git: this.git,
          repo: this.home,
          archiveRoot: this.archiveRoot(),
          label: 'dsh-data',
          commitMessage: `merge dsh data on ${this.host}`,
          maxFiles: this.cfg.maxConflictFiles,
        })
        if (kept.aborted) return { ok: false, error: 'conflicts ended the merge' }
        conflicts = kept.count
      }
      await this.restoreRegistry(snapshot)
      await this.ensureIgnore()
      await this.git(['rm', '--cached', '--quiet', '--ignore-unmatch', '--', ...REGISTRY], this.home)
      await this.commit(`keep machine-local workspace list on ${this.host}`)
      const push = await this.git(['push', 'usb', this.cfg.branch], this.home)
      if (!push.ok) return { ok: false, error: lastLine(push.stderr) }
      this.saveState({ lastPushAt: new Date().toISOString(), stick: stick.root, lastError: '' })
      return { ok: true, pushed: true, conflicts }
    } catch (error) {
      return { ok: false, error: error.message }
    } finally {
      this.unlock(lock.file)
    }
  }

  async syncProjects() {
    const stick = this.stick()
    if (!stick) return { ok: false, error: 'no USB stick found' }
    const map = readJson(path.join(stick.root, 'machines', `${this.host}.json`))
    if (!map) return { ok: true, projects: 0, results: [] }
    const results = []
    for (const [id, entry] of Object.entries(map)) {
      if (id.startsWith('_') || !entry?.path) continue
      const worktree = entry.path
      const repo = path.join(stick.root, 'projects', `${id}.git`)
      if (!exists(repo) || !exists(path.join(worktree, '.git'))) {
        results.push({ id, skipped: true })
        continue
      }
      const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ')
      await this.git(['add', '-A'], worktree)
      await this.git(['commit', '-q', '-m', `sync ${this.host} ${stamp}`], worktree)
      const pull = await this.git(['pull', '--no-rebase', '--no-edit', 'usb', this.cfg.branch], worktree)
      let conflicts = 0
      if (!pull.ok) {
        const unmerged = await this.git(['diff', '--name-only', '--diff-filter=U'], worktree)
        if (String(unmerged.stdout || '').trim()) {
          const kept = await keepLocalAndArchive({
            git: this.git,
            repo: worktree,
            archiveRoot: this.archiveRoot(),
            label: id,
            commitMessage: `merge project on ${this.host}`,
            maxFiles: this.cfg.maxConflictFiles,
          })
          conflicts = kept.count
        }
      }
      await this.git(['push', 'usb', this.cfg.branch], worktree)
      results.push({ id, conflicts })
    }
    return { ok: true, projects: results.length, results }
  }

  async full() {
    const sessions = await this.syncSessions()
    const projects = await this.syncProjects()
    return { ok: sessions.ok, sessions, projects }
  }

  async status() {
    const stick = this.stick()
    if (!stick) return { ok: false, error: 'no USB stick found', home: this.home }
    if (!exists(path.join(this.home, '.git'))) return { ok: false, error: 'no git repository', home: this.home }
    const head = await this.git(['rev-parse', 'HEAD'], this.home)
    const remote = await this.git(['rev-parse', 'usb/' + this.cfg.branch], this.home)
    const status = await this.git(['status', '--porcelain'], this.home)
    const ahead = await this.git(['rev-list', '--count', 'usb/' + this.cfg.branch + '..HEAD'], this.home)
    const behind = await this.git(['rev-list', '--count', 'HEAD..usb/' + this.cfg.branch], this.home)
    const sets = listConflictSets(this.archiveRoot())
    return {
      ok: true,
      home: this.home,
      stick: stick.root,
      head: String(head.stdout || '').trim(),
      remoteHead: String(remote.stdout || '').trim(),
      dirty: String(status.stdout || '').trim().split(/\r?\n/u).filter(Boolean).length,
      ahead: Number(String(ahead.stdout || '0').trim()) || 0,
      behind: Number(String(behind.stdout || '0').trim()) || 0,
      conflicts: sets.length,
      lastSyncAt: this.state().lastSyncAt || '',
    }
  }

  conflicts() {
    return listConflictSets(this.archiveRoot()).map((dir) => ({ dir, ...readConflictSet(dir) }))
  }

  async resolve(index, side) {
    const sets = listConflictSets(this.archiveRoot())
    if (sets.length === 0) return { ok: false, error: 'no archived conflicts' }
    return applyChoice({ git: this.git, repo: this.home, dir: sets[0], index, side })
  }
}

