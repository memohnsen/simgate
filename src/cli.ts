#!/usr/bin/env bun
/**
 * simgate: one machine-wide gate for iOS simulators, Android emulators and Metro, shared
 * by every repository and agent on the machine. See README.md.
 */
import { homedir } from 'node:os'

import { requestedDevice } from './devices'
import { basePort, leaseMinutes, lockPath, runInSession, runSession, type Platform } from './session'
import { statusReport } from './status'

/** Set at build time by `install.sh`. */
declare const SIMGATE_VERSION: string | undefined
declare const SIMGATE_SOURCE: string | undefined
const version = typeof SIMGATE_VERSION === 'string' ? SIMGATE_VERSION : 'dev'
const source = typeof SIMGATE_SOURCE === 'string' ? SIMGATE_SOURCE : undefined

export const USAGE = `simgate: take turns on this machine's simulators, emulators and Metro ports.

Usage:
  simgate run [options] -- <command> [args...]   Run a command as a session.
  simgate in-session -- <command> [args...]      Run beside this worktree's live session.
  simgate status                                 Show slots, claimed simulators and builds.
  simgate update                                 Pull the source checkout and reinstall.
  simgate version

run options:
  --platform ios|android|web  What the session drives (default ios). Android and web take
                              slot 1 only; iOS may take slot 2 beside another session.
  --no-metro                  The command drives a simulator without Metro: no port check.
  --device <name or UDID>     The simulator to claim (also SIMGATE_DEVICE, or the command's
                              own --device). Default: an iPhone.
  --bundle-id <id>            The app: prefer simulators with a current build of it.
  --record-build              Record the install the command makes as current.
  --fingerprint-command <sh>  Prints the native fingerprint (default: Expo's, when present).
  --lease-min <minutes>       Stop the command after this long (default 30; also
                              SIMGATE_LEASE_MIN).

In the command, {udid} becomes the claimed simulator and {port} the session's Metro port;
any --device flag is pointed at the claimed simulator. The command also gets SIMGATE_UDID,
SIMGATE_PORT, SIMGATE_SLOT and RCT_METRO_PORT.`

type Parsed =
  | { kind: 'run'; command: string[]; platform: Platform; metro: boolean; device?: string; bundleId?: string; recordBuild: boolean; fingerprintCommand?: string; leaseMin?: string }
  | { kind: 'in-session'; command: string[] }
  | { kind: 'status' | 'update' | 'version' | 'help' }
  | { kind: 'error'; message: string }

const VALUE_FLAGS = ['--platform', '--device', '--bundle-id', '--fingerprint-command', '--lease-min'] as const
const PLATFORMS: readonly Platform[] = ['ios', 'android', 'web']

/** The subcommand, its options and the command after `--`. */
export const parseCli = (argv: readonly string[]): Parsed => {
  const [subcommand, ...rest] = argv
  if (subcommand === undefined || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') return { kind: 'help' }
  if (subcommand === 'status' || subcommand === 'update' || subcommand === 'version' || subcommand === '--version') {
    return rest.length === 0 ? { kind: subcommand === '--version' ? 'version' : subcommand } : { kind: 'error', message: `${subcommand} takes no arguments` }
  }
  if (subcommand !== 'run' && subcommand !== 'in-session') return { kind: 'error', message: `unknown command "${subcommand}"` }
  const separator = rest.indexOf('--')
  if (separator === -1) return { kind: 'error', message: `${subcommand} needs -- before the command` }
  const options = rest.slice(0, separator)
  const command = rest.slice(separator + 1)
  if (command.length === 0) return { kind: 'error', message: `${subcommand} needs a command after --` }
  if (subcommand === 'in-session') {
    return options.length === 0 ? { kind: 'in-session', command } : { kind: 'error', message: 'in-session takes no options' }
  }
  const values: Partial<Record<(typeof VALUE_FLAGS)[number], string>> = {}
  let metro = true
  let recordBuild = false
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index] as string
    if (option === '--no-metro') metro = false
    else if (option === '--record-build') recordBuild = true
    else if ((VALUE_FLAGS as readonly string[]).includes(option)) {
      const value = options[index + 1]
      if (value === undefined || value.startsWith('--')) return { kind: 'error', message: `${option} needs a value` }
      values[option as (typeof VALUE_FLAGS)[number]] = value
      index += 1
    } else return { kind: 'error', message: `unknown option "${option}"` }
  }
  const platform = (values['--platform'] ?? 'ios') as Platform
  if (!PLATFORMS.includes(platform)) return { kind: 'error', message: `--platform must be ios, android or web` }
  if (recordBuild && values['--bundle-id'] === undefined) return { kind: 'error', message: '--record-build needs --bundle-id' }
  return {
    kind: 'run',
    command,
    platform,
    metro,
    device: values['--device'],
    bundleId: values['--bundle-id'],
    recordBuild,
    fingerprintCommand: values['--fingerprint-command'],
    leaseMin: values['--lease-min'],
  }
}

/** The device asked for: the flag, then SIMGATE_DEVICE, then the command's own --device. */
export const deviceRequest = (flag: string | undefined, env: Record<string, string | undefined>, command: readonly string[]) =>
  flag ?? (env.SIMGATE_DEVICE || undefined) ?? requestedDevice(command)

const update = () => {
  if (source === undefined) {
    console.error('simgate: this build does not know its source checkout; run install.sh from it.')
    process.exit(1)
  }
  for (const step of [['git', '-C', source, 'pull', '--ff-only'], ['sh', `${source}/install.sh`]]) {
    const result = Bun.spawnSync(step, { stdio: ['inherit', 'inherit', 'inherit'] })
    if (result.exitCode !== 0) process.exit(result.exitCode ?? 1)
  }
  process.exit(0)
}

if (import.meta.main) {
  const parsed = parseCli(process.argv.slice(2))
  const base = lockPath(process.env, homedir())
  switch (parsed.kind) {
    case 'help':
      console.log(USAGE)
      process.exit(0)
    case 'version':
      console.log(`simgate ${version}`)
      process.exit(0)
    case 'error':
      console.error(`simgate: ${parsed.message}\n\n${USAGE}`)
      process.exit(2)
    case 'status':
      console.log(statusReport(base, basePort(process.env)))
      process.exit(0)
    case 'update':
      update()
      break
    case 'in-session':
      await runInSession(parsed.command, base, basePort(process.env))
      break
    case 'run': {
      const request = deviceRequest(parsed.device, process.env, parsed.command)
      if (request === 'prompt') {
        console.error('simgate: name the simulator: --device <name or UDID>. A gated session cannot let Expo prompt.')
        process.exit(2)
      }
      await runSession(parsed.command, {
        platform: parsed.platform,
        metro: parsed.metro,
        request: parsed.platform === 'ios' ? request : undefined,
        bundleId: parsed.bundleId,
        recordBuild: parsed.recordBuild,
        fingerprintCommand: parsed.fingerprintCommand,
        leaseMinutes: leaseMinutes(parsed.leaseMin, process.env),
        basePath: base,
        basePort: basePort(process.env),
      })
    }
  }
}
