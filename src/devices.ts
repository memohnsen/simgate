/**
 * Which simulators and emulators a session booted, which simulator a session claims, and
 * how its command is pointed at it, so a machine shared by several agents keeps at most two
 * booted iPhones and two booted iPads (one per iOS slot), and nothing a session booted
 * outlives it.
 *
 * The parsers and planners are pure; the functions at the bottom shell out to `xcrun
 * simctl` and `adb`. A listing that fails reads as unknown, never as empty: a session
 * whose starting set is unknown shuts nothing down, because it cannot prove a device
 * is its own.
 */

export type DeviceFamily = 'iphone' | 'ipad' | 'other'

/** `lastUsedAt` is simctl's ISO timestamp, or '' for a device never used. */
export type Simulator = { udid: string; name: string; family: DeviceFamily; lastUsedAt: string }

/** What was booted at one moment. `undefined` means the listing failed, or the tool is absent. */
export type BootedDevices = { simulators: Simulator[] | undefined; emulators: string[] | undefined }

/** States in which a simulator holds memory: one still booting counts, so it is neither booted twice nor taken for new. */
const RUNNING_SIMULATOR_STATES = new Set(['Booted', 'Booting'])
const SIMULATOR_DEVICE_TYPE_PREFIX = 'com.apple.CoreSimulator.SimDeviceType.'
/** More devices than any Mac holds: a listing past this is not simctl's. */
const MAX_SIMULATORS = 2_000

/** simctl UDIDs are UUIDs; anything else must not reach a file path or a lock name. */
export const isSimulatorUdid = (udid: string) => /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/.test(udid)

/** The family from simctl's `deviceTypeIdentifier` (`…SimDeviceType.iPhone-18-Pro`), not the editable name. */
export const deviceFamily = (deviceTypeIdentifier: string): DeviceFamily => {
  if (!deviceTypeIdentifier.startsWith(SIMULATOR_DEVICE_TYPE_PREFIX)) return 'other'
  const type = deviceTypeIdentifier.slice(SIMULATOR_DEVICE_TYPE_PREFIX.length)
  if (type.startsWith('iPhone-')) return 'iphone'
  if (type.startsWith('iPad-')) return 'ipad'
  return 'other'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const parseSimulator = (value: unknown): { simulator: Simulator; running: boolean } | undefined => {
  if (!isRecord(value)) return undefined
  const { udid, name, state, isAvailable, deviceTypeIdentifier, lastUsedAt } = value
  if (typeof udid !== 'string' || typeof name !== 'string' || typeof deviceTypeIdentifier !== 'string') return undefined
  if (isAvailable === false) return undefined
  const simulator = {
    udid,
    name,
    family: deviceFamily(deviceTypeIdentifier),
    lastUsedAt: typeof lastUsedAt === 'string' ? lastUsedAt : '',
  }
  return { simulator, running: typeof state === 'string' && RUNNING_SIMULATOR_STATES.has(state) }
}

export type SimulatorListing = { available: Simulator[]; booted: Simulator[] }

/**
 * The available devices in `xcrun simctl list devices --json` output, in listing order, and
 * the subset booted or still booting, or undefined when the output is not that shape.
 */
export const parseSimulators = (json: string): SimulatorListing | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || !isRecord(parsed.devices)) return undefined
  const listing: SimulatorListing = { available: [], booted: [] }
  for (const runtimeDevices of Object.values(parsed.devices)) {
    if (!Array.isArray(runtimeDevices)) return undefined
    for (const device of runtimeDevices) {
      const parsedDevice = parseSimulator(device)
      if (parsedDevice === undefined) continue
      listing.available.push(parsedDevice.simulator)
      if (parsedDevice.running) listing.booted.push(parsedDevice.simulator)
    }
  }
  return listing.available.length > MAX_SIMULATORS ? undefined : listing
}

/** States of a running emulator: `offline` is one still starting, so it counts. */
const RUNNING_EMULATOR_STATES = new Set(['device', 'offline'])

/** The emulator serials (`emulator-5554`) `adb devices` lists as running or starting. */
export const parseAdbEmulators = (output: string): string[] =>
  output
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter(([serial, state]) => serial?.startsWith('emulator-') && state !== undefined && RUNNING_EMULATOR_STATES.has(state))
    .map(([serial]) => serial as string)

/**
 * What a session booted: in `after` and not in `before`. A side whose listing failed
 * gives nothing, so a device booted before the session is never mistaken for its own.
 */
export const devicesBootedDuring = (before: BootedDevices, after: BootedDevices) => {
  const added = <T>(start: T[] | undefined, end: T[] | undefined, key: (item: T) => string) => {
    if (start === undefined || end === undefined) return []
    const existing = new Set(start.map(key))
    return end.filter((item) => !existing.has(key(item)))
  }
  return {
    simulators: added(before.simulators, after.simulators, (simulator) => simulator.udid),
    // A serial names a console port, not an emulator: one restarted on the same port during
    // the session reads as pre-existing and is left running. That errs toward keeping it.
    emulators: added(before.emulators, after.emulators, (serial) => serial),
  }
}

/** Stands for the claimed simulator's UDID in a command's arguments. */
export const UDID_PLACEHOLDER = '{udid}'
/** Stands for the session's Metro port in a command's arguments. */
export const PORT_PLACEHOLDER = '{port}'
const DEVICE_FLAG = '--device'

/** Each `--device` flag in `args`: its index, value (undefined when bare) and how many arguments it spans. */
const deviceFlags = (args: readonly string[]) => {
  const flags: { index: number; value: string | undefined; span: number }[] = []
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] as string
    if (arg.startsWith(`${DEVICE_FLAG}=`)) {
      flags.push({ index, value: arg.slice(DEVICE_FLAG.length + 1) || undefined, span: 1 })
    } else if (arg === DEVICE_FLAG) {
      const next = args[index + 1]
      const value = next === undefined || next.startsWith('-') ? undefined : next
      flags.push({ index, value, span: value === undefined ? 1 : 2 })
    }
  }
  return flags
}

/**
 * The device a command asks for with `--device <name or UDID>`, other than the placeholder;
 * `prompt` for a bare `--device` (Expo would ask, which a gated session cannot allow).
 */
export const requestedDevice = (args: readonly string[]): string | 'prompt' | undefined => {
  for (const flag of deviceFlags(args)) {
    if (flag.value === undefined) return 'prompt'
    if (flag.value !== UDID_PLACEHOLDER) return flag.value
  }
  return undefined
}

/**
 * `args` aimed at the session: every `--device` flag becomes one `--device <udid>`, and the
 * placeholders become the UDID and port. Without a claimed simulator (Android, or no simctl)
 * a `--device {udid}` pair is dropped and a named device is left for the command to resolve.
 * Returns an error when another argument still needs a UDID the session does not have.
 */
export const aimCommand = (args: readonly string[], udid: string | undefined, port: number): string[] | { error: string } => {
  const flags = deviceFlags(args)
  const out: string[] = []
  let deviceWritten = false
  for (let index = 0; index < args.length; index += 1) {
    const flag = flags.find((candidate) => candidate.index === index)
    if (flag !== undefined) {
      index += flag.span - 1
      if (udid === undefined) {
        if (flag.value !== UDID_PLACEHOLDER) out.push(...args.slice(flag.index, flag.index + flag.span))
      } else if (!deviceWritten) {
        out.push(DEVICE_FLAG, udid)
        deviceWritten = true
      }
      continue
    }
    const arg = (args[index] as string).replaceAll(PORT_PLACEHOLDER, String(port))
    if (arg.includes(UDID_PLACEHOLDER)) {
      if (udid === undefined) return { error: `"${args[index]}" needs a simulator, but this session has none (Android, or no simctl here).` }
      out.push(arg.replaceAll(UDID_PLACEHOLDER, udid))
    } else {
      out.push(arg)
    }
  }
  return out
}

/** The most recently used of `simulators`: the device agents have been testing on. */
const mostRecentlyUsed = (simulators: readonly Simulator[]) =>
  simulators.reduce<Simulator | undefined>(
    (latest, simulator) => (latest === undefined || simulator.lastUsedAt > latest.lastUsedAt ? simulator : latest),
    undefined,
  )

/** Booted devices of one family a session may leave running: one per iOS session slot. */
export const MAX_BOOTED_PER_FAMILY = 2

export type DeviceChoice =
  | {
      kind: 'device'
      device: Simulator
      /** It is shut down: claiming it boots it. */
      boot: boolean
      /** It has an install of the app built from the current native code. */
      currentBuild: boolean
    }
  /** Every matching device is claimed by another live session. */
  | { kind: 'claimed'; devices: Simulator[] }
  /** Nothing simctl lists matches the request. */
  | { kind: 'unknown' }

/**
 * Which simulator a session claims. With no request it is an iPhone; a request (name or
 * UDID, any case, as Expo matches) decides the family. Devices another live session
 * claimed are skipped. Among the rest, in order:
 *
 * 1. a booted device with a current build (nothing to boot or build);
 * 2. a shut-down device with a current build, while fewer than two of its family are booted;
 * 3. any other booted device (no boot, but a build);
 * 4. any other shut-down device, under the same cap;
 *
 * each tier taking its most recently used device. The cap keeps a third iPhone from booting
 * beside two; a named request may pass it, since the caller asked for that device.
 */
export const planSessionDevice = (
  request: string | undefined,
  listing: SimulatorListing,
  claimedByOthers: ReadonlySet<string>,
  currentBuilds: ReadonlySet<string>,
): DeviceChoice => {
  const wanted = request?.toLowerCase()
  const matches = (simulator: Simulator) =>
    wanted === undefined
      ? simulator.family === 'iphone'
      : simulator.udid.toLowerCase() === wanted || simulator.name.toLowerCase() === wanted
  const candidates = listing.available.filter(matches)
  if (candidates.length === 0) return { kind: 'unknown' }
  const free = candidates.filter((simulator) => !claimedByOthers.has(simulator.udid))
  if (free.length === 0) return { kind: 'claimed', devices: candidates }

  const bootedIds = new Set(listing.booted.map((simulator) => simulator.udid))
  const isBooted = (simulator: Simulator) => bootedIds.has(simulator.udid)
  const isCurrent = (simulator: Simulator) => currentBuilds.has(simulator.udid)
  const mayBoot = (simulator: Simulator) =>
    wanted !== undefined ||
    listing.booted.filter((booted) => booted.family === simulator.family).length < MAX_BOOTED_PER_FAMILY
  const tiers: ((simulator: Simulator) => boolean)[] = [
    (simulator) => isBooted(simulator) && isCurrent(simulator),
    (simulator) => !isBooted(simulator) && isCurrent(simulator) && mayBoot(simulator),
    isBooted,
    (simulator) => !isBooted(simulator) && mayBoot(simulator),
    // Only when every booted device of the family is someone else's: boot past the cap.
    () => true,
  ]
  for (const tier of tiers) {
    const device = mostRecentlyUsed(free.filter(tier))
    if (device !== undefined) return { kind: 'device', device, boot: !isBooted(device), currentBuild: isCurrent(device) }
  }
  return { kind: 'unknown' }
}

/**
 * How long a listing or a shutdown may take. These run in the session's exit handler before
 * the lock is released, so a wedged CoreSimulator or adb server must not hold it forever.
 */
const LIST_TIMEOUT_MS = 10_000
const SHUTDOWN_TIMEOUT_MS = 20_000
/** A cold boot of a simulator; one past this is wedged, and the run goes on without waiting. */
const BOOT_TIMEOUT_MS = 180_000

/** A command's stdout, or undefined when it is missing, fails, or outlives `timeoutMs` (it is then killed). */
const commandOutput = (command: string[], timeoutMs: number) => {
  try {
    const result = Bun.spawnSync(command, { stdout: 'pipe', stderr: 'ignore', timeout: timeoutMs })
    return result.exitCode === 0 ? result.stdout.toString() : undefined
  } catch {
    return undefined
  }
}

/** Simulators simctl lists; undefined off macOS or when simctl fails. */
export const listSimulators = () => {
  if (process.platform !== 'darwin') return undefined
  // The full listing, filtered here: `list devices booted` leaves out devices still booting.
  const output = commandOutput(['xcrun', 'simctl', 'list', 'devices', '--json'], LIST_TIMEOUT_MS)
  return output === undefined ? undefined : parseSimulators(output)
}

/** Running emulators; undefined without adb on PATH, so a Mac with no Android work starts no adb server. */
const listEmulators = () => {
  if (Bun.which('adb') === null) return undefined
  const output = commandOutput(['adb', 'devices'], LIST_TIMEOUT_MS)
  return output === undefined ? undefined : parseAdbEmulators(output)
}

export const bootedDevices = (): BootedDevices => ({
  simulators: listSimulators()?.booted,
  emulators: listEmulators(),
})

export const shutDownSimulator = (simulator: Simulator) => {
  console.error(`Shutting down simulator ${simulator.name} (${simulator.udid}).`)
  if (commandOutput(['xcrun', 'simctl', 'shutdown', simulator.udid], SHUTDOWN_TIMEOUT_MS) === undefined) {
    console.error(`Could not shut down ${simulator.udid}; run xcrun simctl shutdown ${simulator.udid}.`)
  }
}

const shutDownEmulator = (serial: string) => {
  console.error(`Shutting down emulator ${serial}.`)
  if (commandOutput(['adb', '-s', serial, 'emu', 'kill'], SHUTDOWN_TIMEOUT_MS) === undefined) {
    console.error(`Could not shut down ${serial}; run adb -s ${serial} emu kill.`)
  }
}

/** Boots a simulator and waits until it has finished booting. False when it did not. */
export const bootSimulator = (simulator: Simulator) => {
  console.error(`Booting simulator ${simulator.name} (${simulator.udid}).`)
  return commandOutput(['xcrun', 'simctl', 'bootstatus', simulator.udid, '-b'], BOOT_TIMEOUT_MS) !== undefined
}

export type SessionCleanup = {
  /** Simulators another live session claimed: booted during this one, but not its own. */
  keepSimulators: ReadonlySet<string>
  /** Whether emulators are this session's: only the shared slot runs Android. */
  emulators: boolean
}

/** What a session shuts down at its end: booted during it, not another session's, and emulators only in slot 1. */
export const sessionShutdowns = (before: BootedDevices, after: BootedDevices, { keepSimulators, emulators }: SessionCleanup) => {
  const booted = devicesBootedDuring(before, after)
  return {
    simulators: booted.simulators.filter((simulator) => !keepSimulators.has(simulator.udid)),
    emulators: emulators ? booted.emulators : [],
  }
}

/** Shuts down what the session booted since `before`. Synchronous, so it can run in an exit handler. */
export const shutDownDevicesBootedSince = (before: BootedDevices, cleanup: SessionCleanup) => {
  const shutdowns = sessionShutdowns(before, bootedDevices(), cleanup)
  for (const simulator of shutdowns.simulators) shutDownSimulator(simulator)
  for (const serial of shutdowns.emulators) shutDownEmulator(serial)
}
