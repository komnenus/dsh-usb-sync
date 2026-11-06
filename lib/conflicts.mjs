import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, writeJson } from './paths.mjs'

function splitZ(text) {
  return String(text || '').split('\u0000').filter(Boolean)
}

function stagePath(side) {
  return side === 'ours' ? 2 : 3
}

/**
 * Archive every unmerged path (both index stages) and keep this laptop's copy
 * in the working tree. Nothing is lost: both sides land on disk.
 *
 * @param {{ git: Function, repo: string, archiveRoot: string, label: string,
 *           commitMessage: string, maxFiles?: number }} opts
 * @returns {Promise<{ count: number, dir: string, files: object[] }>}
 */
export async function keepLocalAndArchive(opts) {
  const { git, repo, archiveRoot, label, commitMessage } = opts
  const maxFiles = opts.maxFiles ?? 200
  const listed = await git(['diff', '--name-only', '--diff-filter=U', '-z'], repo)
  const paths = splitZ(listed.stdout)
  if (paths.length === 0) return { count: 0, dir: '', files: [] }

  const stamp = new Date().toISOString().replace(/[:.]/gu, '-')
  const dir = path.join(archiveRoot, stamp, label)
  ensureDir(path.join(dir, 'ours'))
  ensureDir(path.join(dir, 'theirs'))
  const files = []

  for (const rel of paths.slice(0, maxFiles)) {
    const entry = { path: rel, ours: false, theirs: false }
    for (const side of ['ours', 'theirs']) {
      const shown = await git(['show', `:${stagePath(side)}:${rel}`], repo, { binary: true })
      if (shown.ok && shown.stdout && shown.stdout.length > 0) {
        const dest = path.join(dir, side, rel)
        ensureDir(path.dirname(dest))
        fs.writeFileSync(dest, shown.stdout)
        entry[side] = true
        entry[`${side}Bytes`] = shown.stdout.length
      }
    }
    files.push(entry)
  }

  for (const rel of paths) {
    const hasOurs = await git(['cat-file', '-e', `:2:${rel}`], repo)
    if (hasOurs.ok) {
      await git(['checkout', '--ours', '--', rel], repo)
      await git(['add', '--', rel], repo)
    } else {
      await git(['add', '--', rel], repo)
    }
  }
  await git(['add', '-A'], repo)

  const left = splitZ((await git(['diff', '--name-only', '--diff-filter=U', '-z'], repo)).stdout)
  if (left.length > 0) {
    // Nothing safe to commit: undo the merge so the folder is unchanged.
    await git(['merge', '--abort'], repo)
    return { count: paths.length, dir: '', files, aborted: true }
  }
  await git(['commit', '-q', '-m', commitMessage], repo)

  const manifest = {
    time: new Date().toISOString(),
    label,
    repo,
    note: 'ours = this laptop\'s version (kept in the folder), theirs = the other laptop\'s version',
    files,
  }
  writeJson(path.join(dir, 'manifest.json'), manifest)
  writeSummary(path.join(dir, 'summary.txt'), manifest)
  return { count: paths.length, dir, files }
}

function writeSummary(file, manifest) {
  const lines = [`conflicts kept at ${manifest.time}`, '']
  manifest.files.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.path}`)
    lines.push(`   kept here: ${entry.ours ? 'yes' : 'no'}   other laptop: ${entry.theirs ? 'yes' : 'no'}`)
  })
  lines.push('')
  lines.push('Use /usbsync conflicts to list, /usbsync resolve <n> local|remote to swap a file.')
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8')
}

/** Newest conflict archive folders, newest first. */
export function listConflictSets(archiveRoot) {
  try {
    return fs
      .readdirSync(archiveRoot)
      .map((name) => path.join(archiveRoot, name))
      .filter((dir) => fs.existsSync(path.join(dir, 'manifest.json')))
      .sort()
      .reverse()
  } catch {
    return []
  }
}

export function readConflictSet(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * Copy one archived side back into the working tree and commit it.
 * @param {{ git: Function, repo: string, dir: string, index: number, side: 'local'|'remote' }} opts
 */
export async function applyChoice(opts) {
  const { git, repo, dir, index, side } = opts
  const manifest = readConflictSet(dir)
  if (!manifest) return { ok: false, error: 'no manifest in ' + dir }
  const entry = manifest.files[index - 1]
  if (!entry) return { ok: false, error: `no conflict #${index}` }
  const folder = side === 'local' ? 'ours' : 'theirs'
  const source = path.join(dir, folder, entry.path)
  if (!fs.existsSync(source)) return { ok: false, error: `that conflict has no ${folder} copy` }
  const dest = path.join(repo, entry.path)
  ensureDir(path.dirname(dest))
  fs.copyFileSync(source, dest)
  await git(['add', '--', entry.path], repo)
  await git(['commit', '-q', '-m', `usbsync: resolve ${entry.path} with ${side}`], repo)
  return { ok: true, path: entry.path, side }
}

