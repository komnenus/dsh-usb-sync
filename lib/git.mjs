import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Thin, never-throwing git runner. Every call returns a result object so the
 * engine can decide; nothing here logs or exits.
 * @param {{ gitBin?: string, timeoutMs?: number }} cfg
 */
export function makeGit(cfg = {}) {
  const bin = cfg.gitBin || 'git'
  const timeout = cfg.timeoutMs || 120000
  /**
   * @param {string[]} args
   * @param {string} cwd
   * @param {{ binary?: boolean, timeout?: number }} [opts]
   * @returns {Promise<{ ok: boolean, code: number, stdout: any, stderr: string }>}
   */
  return async function git(args, cwd, opts = {}) {
    try {
      const { stdout, stderr } = await execFileAsync(bin, args, {
        cwd,
        timeout: opts.timeout || timeout,
        maxBuffer: 64 * 1024 * 1024,
        windowsHide: true,
        encoding: opts.binary ? 'buffer' : 'utf8',
      })
      return { ok: true, code: 0, stdout, stderr: String(stderr || '') }
    } catch (error) {
      return {
        ok: false,
        code: typeof error.code === 'number' ? error.code : 1,
        stdout: error.stdout ?? '',
        stderr: String(error.stderr || error.message || error),
      }
    }
  }
}

export function lastLine(text) {
  const lines = String(text || '').trim().split(/\r?\n/u)
  return lines.length > 0 ? lines[lines.length - 1] : ''
}

