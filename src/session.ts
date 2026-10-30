/**
 * `simgate run`: waits for a slot (and, for iOS, a simulator), then runs the command aimed
 * at them, under a lease, and cleans up what the session booted however it ends.
 *
 * - Slot 1 (`simulator.lock`, Metro on 8081): any session. Android and web take only this
 *   slot, so Android stays one at a time.
 * - Slot 2 (`simulator-2.lock`, Metro on 8082): a second iOS session, beside a slot-1 holder
 *   that records its device (`slots.ts`).
 * - An iOS session claims one simulator, preferring one that already holds a current build
 *   of `--bundle-id` (`planSessionDevice`, `builds.ts`), and boots it. Off macOS there are
 *   no simulators, so every session is slot 1's.
 * - Other worktrees hold every slot it may use: wait, printing who, then start.
 * - This worktree already runs a session: exit at once; stop that one first.
 * - The slot's port is taken by a process outside the lock: exit, naming it (never killed).
 * - The lease ends: stop the command, so a forgotten Metro cannot hold a slot forever.
 * - The command exits, however it exits (lease, signal, crash): shut down every simulator
 *   booted while the session ran, except one another live session claimed, and, in slot 1,
 *   every emulator. Devices booted before the session started are left alone.
 */
import { connect } from 'node:net'
import { join } from 'node:path'

import { buildRecordsDirectory, devicesWithCurrentBuild, hasBuildRecords, nativeFingerprint, recordNextInstall } from './builds'
import {
  aimCommand,
  bootSimulator,
  bootedDevices,
  listSimulators,
  planSessionDevice,
  shutDownDevicesBootedSince,
  type BootedDevices,
  type SimulatorListing,
} from './devices'
import { createLockOwner, runLocked, type LockOwner } from './lock'
import { claimedDevices, describeSlots, simulatorSlots, worktreeSession, type ChooseDevice } from './slots'

export type Env = Record<string, string | undefined>

/** Slot 1's Metro port; slot 2 uses the next one. */
export const METRO_PORT = 8081
export const DEFAULT_LEASE_MINUTES = 30
/** A day: past this a lease is a typo, and timers overflow long before the next limit. */
const MAX_LEASE_MINUTES = 24 * 60
const PORT_PROBE_TIMEOUT_MS = 1_000

/**
 * Slot 1's lock: `$XDG_CACHE_HOME/metro/simulator.lock`, or `~/.cache/metro/simulator.lock`.
 * The path predates simgate (Atlas's and MeetCal's lock scripts used it), so a checkout that
 * still runs its own script queues with simgate's sessions. `SIMGATE_LOCK_PATH` moves it.
 */
export const lockPath = (env: Env, home: string) => {
  if (env.SIMGATE_LOCK_PATH) return env.SIMGATE_LOCK_PATH
  return join(env.XDG_CACHE_HOME || join(home, '.cache'), 'metro', 'simulator.lock')
}

/**
 * The lease in minutes: `--lease-min`, else `SIMGATE_LEASE_MIN`, else the older
 * `METRO_SIMULATOR_LEASE_MIN`, else 30. A value that is not a sane duration is an error.
 */
export const leaseMinutes = (flag: string | undefined, env: Env) => {
  const raw = flag ?? env.SIMGATE_LEASE_MIN ?? env.METRO_SIMULATOR_LEASE_MIN
  if (raw === undefined || raw.trim() === '') return DEFAULT_LEASE_MINUTES
  const value = Number(raw)
  if (!Number.isFinite(value) || value <= 0 || value > MAX_LEASE_MINUTES) {
    throw new Error(`The lease must be minutes between 0 and ${MAX_LEASE_MINUTES}, got "${raw}"`)
  }
  return value
}

/** Slot 1's port; `SIMGATE_BASE_PORT` moves it (tests). */
export const basePort = (env: Env) => {
  const port = Number(env.SIMGATE_BASE_PORT ?? METRO_PORT)
  if (!Number.isSafeInteger(port) || port <= 0 || port >= 65_535) {
    throw new Error(`SIMGATE_BASE_PORT must be a TCP port, got "${env.SIMGATE_BASE_PORT}"`)
  }
  return port
}

/** True when something accepts connections on `host:port`. */
export const isListening = (port: number, host: string) =>
  new Promise<boolean>((resolve) => {
    const socket = connect({ port, host })
    const finish = (listening: boolean) => {
      socket.destroy()
      resolve(listening)
    }
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => finish(false))
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })

const output = (command: string[]) => {
  try {
    const result = Bun.spawnSync(command, { stderr: 'ignore' })
    return result.exitCode === 0 ? result.stdout.toString().trim() : ''
  } catch {
    return ''
  }
}

/** The processes listening on the port: `lsof` on macOS, `ss` where `lsof` is missing. */
const listenerPids = (port: number) => {
  const fromLsof = output(['lsof', '-t', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN']).split('\n')
  const fromSs = [...output(['ss', '-ltnpH', `sport = :${port}`]).matchAll(/pid=(\d+)/g)].map((match) => match[1])
  return [...new Set([...fromLsof, ...fromSs].map(Number).filter((pid) => Number.isSafeInteger(pid) && pid > 0))]
}

const workingDirectory = (pid: number) =>
  output(['readlink', `/proc/${pid}/cwd`]) ||
  (output(['lsof', '-a', '-p', String(pid), '-d', 'cwd', '-Fn']).match(/^n(.+)$/m)?.[1] ?? 'unknown')

/** Who listens on the port, with the command and directory, for the error message. */
const describeListeners = (port: number) => {
  const pids = listenerPids(port)
  if (pids.length === 0) return '  (could not name the process)'
  return pids
    .map((pid) => `  pid ${pid} in ${workingDirectory(pid)}: ${output(['ps', '-o', 'args=', '-p', String(pid)])}`)
    .join('\n')
}

/**
 * Checked once the slot is held: anything still on its port was started outside the lock
 * (a bare `expo start`, or one run by hand). It is reported, never killed.
 */
export const portProblem = async (port: number) => {
  const [ipv4, ipv6] = await Promise.all([isListening(port, '127.0.0.1'), isListening(port, '::1')])
  if (!ipv4 && !ipv6) return undefined
  return [
    `Port ${port} is in use by a process started outside simgate:`,
    describeListeners(port),
    'Stop it (or ask whoever started it), then run this again.',
  ].join('\n')
}

/**
 * Points a command's environment at its session: the slot's Metro port, which Expo and the
 * native build read as `RCT_METRO_PORT`, and the claimed simulator, or none (an inherited
 * value would name another session's device).
 */
export const applySessionEnvironment = (env: Env, session: { slot: number; port: number; udid?: string }) => {
  env.RCT_METRO_PORT = String(session.port)
  env.SIMGATE_PORT = String(session.port)
  env.SIMGATE_SLOT = String(session.slot)
  if (session.udid === undefined) delete env.SIMGATE_UDID
  else env.SIMGATE_UDID = session.udid
  return env
}

/** This worktree's live session, or why a command that drives it cannot run now. */
export const sessionFor = (basePath: string, worktree: string, nowMs = Date.now()): LockOwner | string => {
  const session = worktreeSession(basePath, worktree)
  if (session !== undefined) return session
  const holders = describeSlots(basePath, [1, 2], nowMs)
  const state = holders === '' ? 'no session is running' : `the simulators are held by ${holders}`
  return `This runs inside this worktree's simulator session, but ${state}. Start one with simgate run first.`
}

export type Platform = 'ios' | 'android' | 'web'

export type RunOptions = {
  platform: Platform
  /** The command drives a simulator without Metro: no port check. */
  metro: boolean
  /** The device asked for (name or UDID), from `--device`, `SIMGATE_DEVICE` or the command. */
  request: string | undefined
  bundleId: string | undefined
  recordBuild: boolean
  fingerprintCommand: string | undefined
  leaseMinutes: number
  basePath: string
  basePort: number
}

/**
 * Plans the simulator an iOS session claims, re-listing devices on every attempt so a device
 * another session just booted counts. The fingerprint is computed once, and only when some
 * device has a build record of the app to compare it with.
 */
const deviceChooser = (options: RunOptions, initial: SimulatorListing): ChooseDevice => {
  const records = buildRecordsDirectory(options.basePath)
  const { bundleId } = options
  let fingerprint: Promise<string | undefined> | undefined
  return async (claimedByOthers) => {
    const listing = listSimulators() ?? initial
    let current = new Set<string>()
    if (bundleId !== undefined) {
      fingerprint ??= hasBuildRecords(records, bundleId)
        ? nativeFingerprint(process.cwd(), options.fingerprintCommand)
        : Promise.resolve(undefined)
      const hash = await fingerprint
      const udids = listing.available.map((simulator) => simulator.udid)
      if (hash !== undefined) current = devicesWithCurrentBuild(records, bundleId, udids, hash)
    }
    return planSessionDevice(options.request, listing, claimedByOthers, current)
  }
}

/** Boots the claimed simulator when it is shut down, and says which session this is. */
const prepareDevice = (owner: LockOwner, listing: SimulatorListing) => {
  const session = owner.simulatorSession
  if (session === undefined) return
  if (session.udid === undefined) {
    console.error(`simgate: slot ${session.slot}, Metro on port ${session.port}, no simulator claimed.`)
    return
  }
  const device = listing.available.find((simulator) => simulator.udid === session.udid)
  const booted = (listSimulators() ?? listing).booted.some((simulator) => simulator.udid === session.udid)
  if (device !== undefined && !booted && !bootSimulator(device)) {
    console.error(`simgate: could not boot ${device.name}; the command will try.`)
  }
  console.error(`simgate: slot ${session.slot}, Metro on port ${session.port}, ${session.deviceName} (${session.udid}).`)
}

/** Starts recording the build the command installs, when asked and possible. */
const startBuildRecording = async (options: RunOptions, udid: string | undefined) => {
  if (!options.recordBuild || udid === undefined || options.bundleId === undefined) return
  const fingerprint = await nativeFingerprint(process.cwd(), options.fingerprintCommand)
  if (fingerprint === undefined) {
    console.error('simgate: could not compute the native fingerprint; this build will not be recorded as current.')
    return
  }
  recordNextInstall(buildRecordsDirectory(options.basePath), udid, options.bundleId, fingerprint, process.cwd())
}

/** Runs `command` as a session; exits the process with the command's status. */
export const runSession = async (command: string[], options: RunOptions): Promise<never> => {
  // Off macOS, or when simctl fails, there is no simulator to claim: the session takes slot 1 only.
  const listing = options.platform === 'ios' ? listSimulators() : undefined
  if (listing !== undefined && options.request !== undefined) {
    if (planSessionDevice(options.request, listing, new Set(), new Set()).kind === 'unknown') {
      console.error(`simgate: no simulator matches "${options.request}". See xcrun simctl list devices.`)
      process.exit(2)
    }
  }
  const label = options.metro ? 'Metro' : 'Simulator session'
  const owner = createLockOwner()
  // Set once the locks are held. Registered before runLocked's own exit handler, which
  // releases them, so the cleanup runs first, while this session still holds them, whether
  // the command exits, the lease stops it, or a signal or crash ends simgate.
  let bootedAtStart: BootedDevices | undefined
  process.on('exit', () => {
    if (bootedAtStart === undefined) return
    shutDownDevicesBootedSince(bootedAtStart, {
      keepSimulators: claimedDevices(options.basePath, owner.token),
      emulators: owner.simulatorSession?.slot === 1,
    })
  })
  return runLocked(
    command,
    {
      acquire: simulatorSlots({
        basePath: options.basePath,
        basePort: options.basePort,
        label,
        chooseDevice: listing === undefined ? undefined : deviceChooser(options, listing),
      }),
      label,
      leaseMs: options.leaseMinutes * 60_000,
      leaseHint: 'Pass --lease-min (or set SIMGATE_LEASE_MIN) to hold it longer.',
      beforeRun: async () => {
        // Before the claimed device boots, so that boot counts as this session's.
        bootedAtStart = bootedDevices()
        const session = owner.simulatorSession ?? { slot: 1, port: options.basePort }
        if (listing !== undefined) prepareDevice(owner, listing)
        applySessionEnvironment(process.env, session)
        const aimed = aimCommand(command, session.udid, session.port)
        if ('error' in aimed) return aimed.error
        // runLocked spawns this array once beforeRun returns; the device is known only now.
        command.splice(0, command.length, ...aimed)
        await startBuildRecording(options, session.udid)
        return options.metro ? portProblem(session.port) : undefined
      },
    },
    owner,
  ) as Promise<never>
}

/** `simgate in-session`: runs `command` beside this worktree's live session, aimed at its device and port. */
export const runInSession = async (command: string[], basePath: string, fallbackPort: number): Promise<never> => {
  const session = sessionFor(basePath, process.cwd())
  if (typeof session === 'string') {
    console.error(session)
    process.exit(1)
  }
  const target = session.simulatorSession ?? { slot: 1, port: fallbackPort }
  const aimed = aimCommand(command, target.udid, target.port)
  if ('error' in aimed) {
    console.error(`simgate: ${aimed.error}`)
    process.exit(1)
  }
  const child = Bun.spawn(aimed, {
    env: applySessionEnvironment({ ...process.env }, target),
    stdio: ['inherit', 'inherit', 'inherit'],
  })
  process.exit(await child.exited)
}
