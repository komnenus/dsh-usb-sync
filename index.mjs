import Schema from '@deepseek-ai/schemastery'
import { DEFAULTS, PLUGIN_NAME } from './lib/constants.mjs'
import { Engine } from './lib/engine.mjs'

export const name = PLUGIN_NAME

export const inject = ['commands']

export const Config = Schema.object({
  enabled: Schema.boolean().default(DEFAULTS.enabled),
  stickPath: Schema.string().default(DEFAULTS.STICK_PATH),
  stickFolder: Schema.string().default(DEFAULTS.STICK_FOLDER),
  dshHome: Schema.string().default(DEFAULTS.DSH_HOME),
  branch: Schema.string().default(DEFAULTS.branch),
  gitBin: Schema.string().default(DEFAULTS.GIT_BIN),
  autoPullOnStart: Schema.boolean().default(DEFAULTS.AUTO_PULL_ON_START),
  autoPushOnExit: Schema.boolean().default(DEFAULTS.AUTO_PUSH_ON_EXIT),
  autoPushIntervalMinutes: Schema.number().default(DEFAULTS.AUTO_PUSH_INTERVAL_MINUTES),
  regroupOnPull: Schema.boolean().default(DEFAULTS.REGROUP_ON_PULL),
  conflictPolicy: Schema.string().default(DEFAULTS.CONFLICT_POLICY),
  registerCommand: Schema.boolean().default(DEFAULTS.REGISTER_COMMAND),
  commandName: Schema.string().default(DEFAULTS.COMMAND_NAME),
  timeoutMs: Schema.number().default(DEFAULTS.TIMEOUT_MS),
  maxConflictFiles: Schema.number().default(DEFAULTS.MAX_CONFLICT_FILES),
})

function makeLogger(ctx) {
  try {
    if (typeof ctx.logger === 'function') return ctx.logger(PLUGIN_NAME)
  } catch {}
  return {
    info: (m) => console.log(`[${PLUGIN_NAME}] ${m}`),
    warn: (m) => console.warn(`[${PLUGIN_NAME}] ${m}`),
    error: (m) => console.error(`[${PLUGIN_NAME}] ${m}`),
  }
}

function renderStatus(value) {
  if (!value.ok) return `usbsync: ${value.error}`
  const lines = [
    `usbsync: ${value.home}`,
    `  stick        ${value.stick}`,
    `  head         ${value.head || '(none)'}`,
    `  stick head   ${value.remoteHead || '(none)'}`,
    `  ahead/behind ${value.ahead} / ${value.behind}`,
    `  local edits  ${value.dirty}`,
    `  conflict sets ${value.conflicts}`,
    `  last sync    ${value.lastSyncAt || 'never'}`,
  ]
  return lines.join('\n')
}

function renderConflicts(sets) {
  if (sets.length === 0) return 'usbsync: no archived conflicts'
  const lines = ['usbsync: conflicts (newest first)']
  const latest = sets[0]
  lines.push(`  ${latest.dir}`)
  ;(latest.files || []).forEach((file, index) => {
    lines.push(`    ${index + 1}. ${file.path}`)
    lines.push(`       kept here: ${file.ours ? 'yes' : 'no'}   other copy: ${file.theirs ? 'yes' : 'no'}`)
  })
  lines.push('  /usbsync resolve <n> local|remote')
  return lines.join('\n')
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (cfg.enabled === false) return
  const logger = makeLogger(ctx)
  const engine = new Engine(cfg, logger)

  if (cfg.registerCommand && ctx.commands && typeof ctx.commands.register === 'function') {
    try {
      ctx.commands.register({
        name: cfg.commandName,
        description: 'USB auto-sync: pull on start, push on exit, conflicts kept on both sides.',
        input: { hint: '[status | conflicts | resolve <n> local|remote | sync]' },
        async handler(invocation) {
          const input = String(invocation?.rawInput || '').trim()
          const [action = 'status', ...rest] = input.split(/\s+/u)
          try {
            if (action === 'help') {
              return {
                kind: 'success',
                text: [
                  'usbsync: usage — /usbsync [status | conflicts | resolve <n> local|remote | sync]',
                  '  status     stick, branch position, local edits, conflict count',
                  '  conflicts  list the newest archived conflict set',
                  '  resolve    put the local or the other laptop copy back and commit it',
                  '  sync       pull + push now',
                ].join('\n'),
              }
            }
            if (action === 'conflicts') return { kind: 'success', text: renderConflicts(engine.conflicts()) }
            if (action === 'resolve') {
              const index = Number(rest[0])
              const side = rest[1] === 'remote' ? 'remote' : 'local'
              if (!Number.isInteger(index) || index < 1) return { kind: 'error', text: 'usbsync: resolve needs a conflict number' }
              const result = await engine.resolve(index, side)
              return result.ok
                ? { kind: 'success', text: `usbsync: ${result.path} now uses the ${side} copy` }
                : { kind: 'error', text: `usbsync: ${result.error}` }
            }
            if (action === 'sync') {
              const result = await engine.full()
              if (!result.ok) return { kind: 'error', text: `usbsync: ${result.sessions?.error || 'sync failed'}` }
              const conflicts = (result.sessions.conflicts || 0) + (result.projects?.results || []).reduce((n, r) => n + (r.conflicts || 0), 0)
              return {
                kind: 'success',
                text: `usbsync: pushed${conflicts > 0 ? `, ${conflicts} conflict file(s) kept on both sides` : ''}`,
              }
            }
            return { kind: 'success', text: renderStatus(await engine.status()) }
          } catch (error) {
            return { kind: 'error', text: `usbsync: ${error.message}` }
          }
        },
      })
    } catch (error) {
      logger.warn(`could not register ${cfg.commandName}: ${error.message}`)
    }
  }

  const later = (fn) => {
    try {
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => {
          const timer = setTimeout(fn, 2500)
          timer.unref?.()
          return () => clearTimeout(timer)
        })
      } else {
        setTimeout(fn, 2500).unref?.()
      }
    } catch (error) {
      logger.warn(`could not schedule the start sync: ${error.message}`)
    }
  }

  if (cfg.autoPullOnStart) {
    later(() => {
      engine
        .full()
        .then((result) => {
          if (result.ok) logger.info('startup sync finished')
          else logger.warn(`startup sync skipped: ${result.sessions?.error || 'unknown error'}`)
        })
        .catch((error) => logger.warn(`startup sync failed: ${error.message}`))
    })
  }

  if (cfg.autoPushIntervalMinutes > 0) {
    try {
      ctx.effect(() => {
        const timer = setInterval(() => {
          engine.pushOnly().catch(() => {})
        }, cfg.autoPushIntervalMinutes * 60 * 1000)
        timer.unref?.()
        return () => clearInterval(timer)
      })
    } catch (error) {
      logger.warn(`could not start the periodic push: ${error.message}`)
    }
  }

  let exiting = false
  const onExit = () => {
    if (exiting || !cfg.autoPushOnExit) return
    exiting = true
    engine.pushOnly().catch(() => {})
  }
  try {
    if (typeof ctx.on === 'function') ctx.on('dispose', onExit)
  } catch {}
  process.once('beforeExit', onExit)
}

