/**
 * Which simulators already hold a current build of an app, so a session claims one it can
 * use without a native build (`planSessionDevice` in `devices.ts`).
 *
 * A build is current when the app installed on the device is the install simgate recorded
 * (`simgate run --record-build`), and the native fingerprint recorded with it equals the
 * checkout's. For an Expo project the fingerprint is Expo's own (`@expo/fingerprint`, iOS
 * sources: native code, config plugins, native dependencies; the hash EAS uses for the
 * runtime version), read through the project's `fingerprint` CLI. JavaScript-only
 * differences leave it alone, and Metro serves them to any such build, so a build from
 * another worktree counts when its native side matches. Other projects pass a command that
 * prints their fingerprint (`--fingerprint-command`).
 *
 * The records live beside the simulator lock (`~/.cache/metro/simulator-builds/`), one per
 * device. A record whose install was replaced (another build, an old checkout's run, an
 * erased device) no longer matches the device and reads as stale.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { isSimulatorUdid } from './devices'

export type BuildRecord = {
  udid: string
  bundleId: string
  /** The iOS native fingerprint of the code that was built. */
  fingerprint: string
  /** `installIdentity` right after the install: which install the record describes. */
  install: string
  worktree: string
  recordedAtMs: number
}

/** More app containers than a test simulator holds: the scan stops there. */
const MAX_APP_CONTAINERS = 200
const PLUTIL_TIMEOUT_MS = 5_000
const DEVICES_ROOT = join(homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices')

export const buildRecordsDirectory = (lockPath: string) => join(dirname(lockPath), 'simulator-builds')

const recordPath = (directory: string, udid: string, bundleId: string) => {
  if (!isSimulatorUdid(udid)) throw new Error(`Not a simulator UDID: ${udid}`)
  return join(directory, `${udid}.${bundleId}.json`)
}

export const parseBuildRecord = (json: string): BuildRecord | undefined => {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const strings = ['udid', 'bundleId', 'fingerprint', 'install', 'worktree'] as const
  if (!strings.every((key) => typeof record[key] === 'string' && record[key] !== '')) return undefined
  if (!Number.isFinite(record.recordedAtMs)) return undefined
  return value as BuildRecord
}

export const readBuildRecord = (directory: string, udid: string, bundleId: string): BuildRecord | undefined => {
  try {
    return parseBuildRecord(readFileSync(recordPath(directory, udid, bundleId), 'utf8'))
  } catch {
    return undefined
  }
}

/** Writes the record atomically, so a reader never sees half of it. */
export const writeBuildRecord = (directory: string, record: BuildRecord) => {
  mkdirSync(directory, { recursive: true })
  const path = recordPath(directory, record.udid, record.bundleId)
  const staging = `${path}.${process.pid}.tmp`
  writeFileSync(staging, JSON.stringify(record))
  renameSync(staging, path)
}

/** True when the device still holds the recorded install and it was built from `fingerprint`. */
export const isCurrentBuild = (record: BuildRecord | undefined, fingerprint: string, install: string | undefined) =>
  record !== undefined && install !== undefined && record.install === install && record.fingerprint === fingerprint

const plistBundleId = (infoPlist: string) => {
  try {
    const result = Bun.spawnSync(['plutil', '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPlist], {
      stderr: 'ignore',
      timeout: PLUTIL_TIMEOUT_MS,
    })
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined
  } catch {
    return undefined
  }
}

const readDirectory = (path: string) => {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * Which install of `bundleId` the simulator holds: its app container and the bundle's
 * Info.plist modification time, read from the device's files so it works whether the
 * device is booted or not. Undefined when the app is not installed. An install replaces
 * the container or the bundle, so a new install reads differently.
 */
export const installIdentity = (
  udid: string,
  bundleId: string,
  { devicesRoot = DEVICES_ROOT, readBundleId = plistBundleId } = {},
): string | undefined => {
  if (!isSimulatorUdid(udid)) return undefined
  const applications = join(devicesRoot, udid, 'data', 'Containers', 'Bundle', 'Application')
  for (const container of readDirectory(applications).slice(0, MAX_APP_CONTAINERS)) {
    for (const entry of readDirectory(join(applications, container))) {
      if (!entry.endsWith('.app')) continue
      const infoPlist = join(applications, container, entry, 'Info.plist')
      if (readBundleId(infoPlist) !== bundleId) continue
      try {
        return `${container}/${entry}@${statSync(infoPlist).mtimeMs}`
      } catch {
        return undefined
      }
    }
  }
  return undefined
}

const FINGERPRINT_TIMEOUT_MS = 120_000
/** A fingerprint is a hash: one short token. Anything else is a command printing something unexpected. */
const MAX_FINGERPRINT_LENGTH = 256

const runForOutput = async (command: string[], cwd: string) => {
  try {
    const child = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'ignore', timeout: FINGERPRINT_TIMEOUT_MS })
    const [output, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
    return exitCode === 0 ? output : undefined
  } catch {
    return undefined
  }
}

/**
 * The fingerprint in `fingerprint fingerprint:generate` output, or undefined. Expo returns a
 * hash even when it could not load the app config (a missing `node`, a directory that is not
 * the project), so one without the config's source is refused rather than recorded.
 */
export const parseExpoFingerprint = (json: string): string | undefined => {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null) return undefined
  const { hash, sources } = value as { hash?: unknown; sources?: unknown }
  if (typeof hash !== 'string' || hash === '' || !Array.isArray(sources)) return undefined
  const hasConfig = sources.some(
    (source: unknown) =>
      typeof source === 'object' && source !== null && (source as { id?: unknown }).id === 'expoConfig',
  )
  return hasConfig ? hash : undefined
}

/** A custom fingerprint command's output, when it is one short token. */
export const parseCommandFingerprint = (output: string): string | undefined => {
  const value = output.trim()
  return value !== '' && value.length <= MAX_FINGERPRINT_LENGTH && !/\s/.test(value) ? value : undefined
}

/**
 * The checkout's iOS native fingerprint, or undefined when it cannot be computed, which then
 * matches no record. `command` is a shell command printing the fingerprint; without one, an
 * Expo project's own `fingerprint` CLI is used, and any other project has none.
 */
export const nativeFingerprint = async (projectRoot: string, command?: string): Promise<string | undefined> => {
  if (command !== undefined) {
    const output = await runForOutput(['sh', '-c', command], projectRoot)
    return output === undefined ? undefined : parseCommandFingerprint(output)
  }
  const cli = join(projectRoot, 'node_modules', '.bin', 'fingerprint')
  if (!existsSync(cli)) return undefined
  const output = await runForOutput([cli, 'fingerprint:generate', '--platform', 'ios'], projectRoot)
  return output === undefined ? undefined : parseExpoFingerprint(output)
}

/** Of `udids`, the devices holding a current build of `bundleId`. Reads only devices that have a record. */
export const devicesWithCurrentBuild = (directory: string, bundleId: string, udids: readonly string[], fingerprint: string) =>
  new Set(
    udids.filter((udid) =>
      isCurrentBuild(readBuildRecord(directory, udid, bundleId), fingerprint, installIdentity(udid, bundleId)),
    ),
  )

/** True when any device has a build record of `bundleId`, so the fingerprint is worth computing. */
export const hasBuildRecords = (directory: string, bundleId: string) =>
  readDirectory(directory).some((name) => name.endsWith(`.${bundleId}.json`))

const INSTALL_POLL_MS = 5_000

/**
 * Records the install a build command makes on `udid`: polls the device until its install
 * of `bundleId` differs from the one present now, then writes the record once. A build
 * command such as `expo run:ios` keeps running Metro after it installs, so the install, not
 * the exit, marks the build.
 */
export const recordNextInstall = (directory: string, udid: string, bundleId: string, fingerprint: string, worktree: string) => {
  const before = installIdentity(udid, bundleId)
  const timer = setInterval(() => {
    const install = installIdentity(udid, bundleId)
    if (install === undefined || install === before) return
    clearInterval(timer)
    writeBuildRecord(directory, { udid, bundleId, fingerprint, install, worktree, recordedAtMs: Date.now() })
    console.error(`simgate: recorded the build on ${udid} as current (fingerprint ${fingerprint.slice(0, 12)}).`)
  }, INSTALL_POLL_MS)
  timer.unref()
  return () => clearInterval(timer)
}
