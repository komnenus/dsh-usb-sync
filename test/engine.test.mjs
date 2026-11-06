import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { Engine } from '../lib/engine.mjs'
import { regroupSessions } from '../lib/regroup.mjs'

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' })
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-sync-'))
  const home = path.join(root, 'dsh')
  const stick = path.join(root, 'E', 'dsh-usb-sync')
  const bare = path.join(stick, 'repo.git')
  fs.mkdirSync(path.join(stick, 'machines'), { recursive: true })
  git(root, 'init', '-q', '--bare', '-b', 'main', bare)
  fs.mkdirSync(home, { recursive: true })
  git(home, 'init', '-q', '-b', 'main')
  git(home, 'config', 'user.email', 't@t')
  git(home, 'config', 'user.name', 't')
  write(path.join(home, 'sessions', '--tmp--', 'session-1', 'session.v4.jsonl.zstd'), 'base')
  write(path.join(home, '.gitignore'), 'cache/\n')
  git(home, 'add', '-A')
  git(home, 'commit', '-q', '-m', 'base')
  git(home, 'remote', 'add', 'usb', bare)
  git(home, 'push', '-q', '-u', 'usb', 'main')
  return { root, home, stick, bare }
}

function engineFor(env) {
  return new Engine(
    {
      stickPath: env.stick,
      stickFolder: 'dsh-usb-sync',
      dshHome: env.home,
      branch: 'main',
      gitBin: 'git',
      regroupOnPull: false,
      maxConflictFiles: 50,
      timeoutMs: 60000,
    },
    { info() {}, warn() {}, error() {} },
  )
}

test('sync pushes local sessions to the stick', async () => {
  const env = workspace()
  write(path.join(env.home, 'sessions', '--tmp--', 'session-2', 'session.v4.jsonl.zstd'), 'new')
  const result = await engineFor(env).syncSessions()
  assert.equal(result.ok, true, result.error)
  const log = execFileSync('git', ['--git-dir', env.bare, 'log', '--oneline'], { encoding: 'utf8' })
  assert.match(log, /sync /u)
  const files = execFileSync('git', ['--git-dir', env.bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' })
  assert.match(files, /session-2/u)
})

test('a conflicting file keeps this laptop and archives both sides', async () => {
  const env = workspace()
  const other = path.join(env.root, 'other')
  git(env.root, 'clone', '-q', env.bare, other)
  git(other, 'config', 'user.email', 'o@o')
  git(other, 'config', 'user.name', 'o')
  const rel = path.join('sessions', '--tmp--', 'session-1', 'session.v4.jsonl.zstd')
  write(path.join(other, rel), 'other laptop')
  git(other, 'add', '-A')
  git(other, 'commit', '-q', '-m', 'other change')
  git(other, 'push', '-q', 'origin', 'main')

  write(path.join(env.home, rel), 'this laptop')
  const result = await engineFor(env).syncSessions()
  assert.equal(result.ok, true, result.error)
  assert.ok(result.conflicts >= 1, 'expected a conflict')
  assert.equal(fs.readFileSync(path.join(env.home, rel), 'utf8'), 'this laptop')
  const dir = result.conflictDir
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')), 'manifest missing')
  assert.equal(fs.readFileSync(path.join(dir, 'ours', rel), 'utf8'), 'this laptop')
  assert.equal(fs.readFileSync(path.join(dir, 'theirs', rel), 'utf8'), 'other laptop')
})

test('the workspace registry never reaches the stick', async () => {
  const env = workspace()
  const ws = { global: { defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: { w1: { path: path.join(env.root, 'ws'), title: 'ws', sessionIds: [] } } } }
  fs.mkdirSync(path.join(env.root, 'ws'), { recursive: true })
  fs.mkdirSync(path.join(env.home, 'storages'), { recursive: true })
  write(path.join(env.home, 'storages', 'workspace.json'), JSON.stringify(ws))
  const result = await engineFor(env).syncSessions()
  assert.equal(result.ok, true, result.error)
  const files = execFileSync('git', ['--git-dir', env.bare, 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf8' })
  assert.doesNotMatch(files, /storages\/workspace\.json/u)
  assert.ok(fs.existsSync(path.join(env.home, 'storages', 'workspace.json')))
})

test('regroup attaches a downloaded session to its workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-regroup-'))
  const home = path.join(root, 'dsh')
  const ws = path.join(root, 'ws')
  const session = 'session-42'
  fs.mkdirSync(path.join(home, 'sessions', '--tmp-ws--', session), { recursive: true })
  write(path.join(home, 'sessions', '--tmp-ws--', session, 'session.v4.jsonl.zstd'), 'x')
  write(path.join(home, 'storages', 'session_projcache', 'sessions', session + '.json'), JSON.stringify({ record: { identity: { cwd: ws } } }))
  fs.mkdirSync(ws, { recursive: true })
  const registry = { global: { defaultWorkspaceId: 'w1', workspaceIds: ['w1'], archivedSessionIds: [], pinnedSessionIds: [] }, tables: { workspaces: { w1: { path: ws, title: 'ws', sessionIds: [] } } } }
  write(path.join(home, 'storages', 'workspace.json'), JSON.stringify(registry))
  const result = regroupSessions({ dshHome: home, stickRoot: '' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.added, 1)
  const after = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'))
  assert.deepEqual(after.tables.workspaces.w1.sessionIds, [session])
})

