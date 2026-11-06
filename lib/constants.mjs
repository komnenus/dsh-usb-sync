export const PLUGIN_NAME = 'dsh-usb-auto'
export const COMMAND_DEFAULT = 'usbsync'

export const DEFAULTS = {
  enabled: true,
  stickPath: '',
  stickFolder: 'dsh-usb-sync',
  dshHome: '',
  branch: 'main',
  gitBin: 'git',
  autoPullOnStart: true,
  autoPushOnExit: true,
  autoPushIntervalMinutes: 10,
  regroupOnPull: true,
  conflictPolicy: 'keep-local',
  registerCommand: true,
  commandName: COMMAND_DEFAULT,
  timeoutMs: 120000,
  maxConflictFiles: 200,
}

export const CONFLICT_POLICIES = ['keep-local']

