/**
 * The lock mechanics every simgate lock uses: the slots and the device claims.
 *
 * A lock is a directory created by renaming a fully written temporary directory into
 * place, so a lock that exists always names its owner (`owner.json`). A lock whose owner
 * process has exited is stale and the next waiter reclaims it.
 *
 * The owner format is shared with the in-repo lock scripts simgate replaces (Atlas's
 * `scripts/check-lock.ts`, MeetCal's `scripts/check/lock.ts`): checkouts that predate
 * simgate still take `simulator.lock` with the same format, and simgate reads them.
 */
import { randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'

export type LockOwner = {
  pid: number
  worktree: string
  startedAtMs: number
  token: string
  /** When `pid` started, so a reused process ID is not mistaken for the owner. */
  pidStartedAt?: string
  /** The gate's own process, so killing only this wrapper does not free the lock early. */
  childPid?: number
  childStartedAt?: string
  /** When the holder will stop its command and free the lock (the simulator lock's lease). */
  leaseEndsAtMs?: number
  /** The session's slot, Metro port and claimed device. Pre-simgate checkouts leave it out. */
  simulatorSession?: SimulatorSession
}

export type SimulatorSession = {
  slot: number
  port: number
  /** The simulator this session claimed; absent for Android, web, and machines without simctl. */
  udid?: string
  deviceName?: string
}

const isSimulatorSession = (value: unknown): value is SimulatorSession => {
  if (typeof value !== 'object' || value === null) return false
  const session = value as Record<string, unknown>
  return (
    Number.isSafeInteger(session.slot) &&
    (session.slot as number) > 0 &&
    Number.isSafeInteger(session.port) &&
    (session.port as number) > 0 &&
    (session.udid === undefined || typeof session.udid === 'string') &&
    (session.deviceName === undefined || typeof session.deviceName === 'string')
  )
}

type AcquireAttempt = { acquired: true } | { acquired: false; owner: LockOwner | undefined }

const OWNER_FILE = 'owner.json'
const POLL_INTERVAL_MS = 2_000
const REPORT_INTERVAL_MS = 30_000
/** A reclaim takes milliseconds; a guard older than this was left by a reclaimer that died. */
const ABANDONED_GUARD_MS = 10_000
/** Polls that must find the same unreadable lock before it is treated as corrupt. */
const CORRUPT_LOCK_POLLS = 3
/** Staging, stale, and released copies older than this were left by a killed process. */
const LEFTOVER_MAX_AGE_MS = 60 * 60_000

const isErrorCode = (error: unknown, codes: string[]) =>
  error instanceof Error && 'code' in error && codes.includes(String(error.code))

const isLockOwner = (value: unknown): value is LockOwner => {
  if (typeof value !== 'object' || value === null) return false
  const owner = value as Record<string, unknown>
  return (
    Number.isSafeInteger(owner.pid) &&
    (owner.pid as number) > 0 &&
    typeof owner.worktree === 'string' &&
    Number.isFinite(owner.startedAtMs) &&
    typeof owner.token === 'string' &&
    owner.token.length > 0 &&
    (owner.childPid === undefined ||
      (Number.isSafeInteger(owner.childPid) && (owner.childPid as number) > 0)) &&
    (owner.pidStartedAt === undefined || typeof owner.pidStartedAt === 'string') &&
    (owner.childStartedAt === undefined || typeof owner.childStartedAt === 'string') &&
    (owner.leaseEndsAtMs === undefined || Number.isFinite(owner.leaseEndsAtMs)) &&
    (owner.simulatorSession === undefined || isSimulatorSession(owner.simulatorSession))
  )
}

/** The owner recorded in a lock directory, or `undefined` when it is missing or unreadable. */
export const readLockOwner = (lockPath: string): LockOwner | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(lockPath, OWNER_FILE), 'utf8'))
    return isLockOwner(parsed) ? parsed : undefined
  } catch (error) {
    if (isErrorCode(error, ['ENOENT', 'ENOTDIR']) || error instanceof SyntaxError) return undefined
    throw error
  }
}

/** The process's start time as `ps` reports it, or undefined when it has exited. */
export const processStartTime = (pid: number): string | undefined => {
  const result = Bun.spawnSync(['ps', '-o', 'lstart=', '-p', String(pid)])
  const startedAt = result.stdout.toString().trim()
  return result.exitCode === 0 && startedAt !== '' ? startedAt : undefined
}

/**
 * Signal 0 checks existence; EPERM means the process exists but belongs to another user.
 * With a recorded start time, a different process that reused the ID does not count.
 */
export const isProcessAlive = (pid: number, startedAt?: string): boolean => {
  try {
    process.kill(pid, 0)
  } catch (error) {
    if (!isErrorCode(error, ['EPERM'])) return false
  }
  if (startedAt === undefined) return true
  const current = processStartTime(pid)
  return current === undefined || current === startedAt
}

/** True while the wrapper or the gate it started is still running. */
export const isOwnerAlive = (
  owner: LockOwner,
  isAlive: (pid: number, startedAt?: string) => boolean = isProcessAlive,
) =>
  isAlive(owner.pid, owner.pidStartedAt) ||
  (owner.childPid !== undefined && isAlive(owner.childPid, owner.childStartedAt))

/**
 * Atomically creates the lock with its owner already written. `rename` onto an
 * existing non-empty directory fails, so only one caller can win.
 */
export const tryAcquireLock = (lockPath: string, owner: LockOwner): AcquireAttempt => {
  const staging = mkdtempSync(`${lockPath}.staging-`)
  writeFileSync(join(staging, OWNER_FILE), JSON.stringify(owner))
  try {
    renameSync(staging, lockPath)
    return { acquired: true }
  } catch (error) {
    rmSync(staging, { recursive: true, force: true })
    if (!isErrorCode(error, ['EEXIST', 'ENOTEMPTY'])) throw error
    return { acquired: false, owner: readLockOwner(lockPath) }
  }
}

const removeAbandonedGuard = (guardPath: string, nowMs: number) => {
  try {
    if (nowMs - statSync(guardPath).mtimeMs > ABANDONED_GUARD_MS) rmSync(guardPath, { recursive: true, force: true })
  } catch (error) {
    if (!isErrorCode(error, ['ENOENT'])) throw error
  }
}

/**
 * Removes a lock whose owner has exited. Reclaimers serialize on a guard directory, and
 * under it re-read the lock: only the exact dead owner that was judged may be removed. A
 * lock can only disappear through its owner's release or a reclaim, so the lock read
 * under the guard is still the lock that gets moved.
 */
export const reclaimStaleLock = (lockPath: string, stale: LockOwner | undefined, nowMs = Date.now()): void => {
  const guardPath = `${lockPath}.reclaim`
  try {
    mkdirSync(guardPath)
  } catch (error) {
    if (!isErrorCode(error, ['EEXIST'])) throw error
    // Another waiter is reclaiming; retry after it, or after its guard is abandoned.
    removeAbandonedGuard(guardPath, nowMs)
    return
  }
  try {
    if (!existsSync(lockPath)) return
    if (readLockOwner(lockPath)?.token !== stale?.token) return
    const aside = `${lockPath}.stale-${process.pid}-${randomUUID()}`
    renameSync(lockPath, aside)
    rmSync(aside, { recursive: true, force: true })
  } finally {
    rmSync(guardPath, { recursive: true, force: true })
  }
}

/**
 * Releases the lock only if this owner still holds it. The lock is renamed away before it
 * is deleted, so a waiter never sees an empty lock directory it could acquire into.
 */
export const releaseLock = (lockPath: string, owner: LockOwner): void => {
  if (readLockOwner(lockPath)?.token !== owner.token) return
  const released = `${lockPath}.released-${randomUUID()}`
  try {
    renameSync(lockPath, released)
  } catch (error) {
    if (isErrorCode(error, ['ENOENT'])) return
    throw error
  }
  rmSync(released, { recursive: true, force: true })
}

/** Replaces the owner file of a lock this owner holds, atomically. */
export const writeLockOwner = (lockPath: string, owner: LockOwner): void => {
  const staging = join(lockPath, `${OWNER_FILE}.${randomUUID()}`)
  writeFileSync(staging, JSON.stringify(owner))
  renameSync(staging, join(lockPath, OWNER_FILE))
}

/** Records the gate's process in the held lock, replacing the owner file atomically. */
export const recordChildPid = (
  lockPath: string,
  owner: LockOwner,
  childPid: number,
  childStartedAt = processStartTime(childPid),
): LockOwner => {
  const updated = { ...owner, childPid, childStartedAt }
  writeLockOwner(lockPath, updated)
  return updated
}

/** Deletes staging, stale, and released copies that a killed process left beside the lock. */
export const sweepLeftovers = (lockPath: string, nowMs = Date.now()): void => {
  const prefix = `${basename(lockPath)}.`
  const directory = dirname(lockPath)
  for (const name of readdirSync(directory)) {
    const isLeftover = name.startsWith(prefix) && /^(staging|stale|released)-/.test(name.slice(prefix.length))
    if (!isLeftover) continue
    const path = join(directory, name)
    try {
      if (nowMs - statSync(path).mtimeMs > LEFTOVER_MAX_AGE_MS) rmSync(path, { recursive: true, force: true })
    } catch (error) {
      if (!isErrorCode(error, ['ENOENT'])) throw error
    }
  }
}

export const describeOwner = (owner: LockOwner | undefined, nowMs: number) => {
  if (!owner) return 'another checkout'
  const minutes = Math.floor((nowMs - owner.startedAtMs) / 60_000)
  const lease =
    owner.leaseEndsAtMs === undefined
      ? ''
      : `, lease ends in ${Math.max(0, Math.ceil((owner.leaseEndsAtMs - nowMs) / 60_000))}m`
  const device = owner.simulatorSession?.deviceName === undefined ? '' : ` on ${owner.simulatorSession.deviceName}`
  return `${owner.worktree}${device} (pid ${owner.pid}, running ${minutes}m${lease})`
}

/** A live holder runs in the caller's own worktree, which would otherwise wait on itself. */
export class LockHeldByWorktreeError extends Error {
  constructor(readonly owner: LockOwner) {
    super(`already held by this worktree (pid ${owner.pid})`)
    this.name = 'LockHeldByWorktreeError'
  }
}

type WaitOptions = {
  /** What the holder is running, for the waiting message. */
  label?: string
  /** Throw `LockHeldByWorktreeError` instead of waiting when a live holder runs in this worktree. */
  refuseWorktree?: string
  pollIntervalMs?: number
  reportIntervalMs?: number
  report?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
  isAlive?: (pid: number, startedAt?: string) => boolean
}

/** Waits until this owner holds the lock, reclaiming locks left by exited processes. */
export const acquireLock = async (
  lockPath: string,
  owner: LockOwner,
  {
    label = 'the simulator',
    refuseWorktree,
    pollIntervalMs = POLL_INTERVAL_MS,
    reportIntervalMs = REPORT_INTERVAL_MS,
    report = (message) => console.error(message),
    sleep = Bun.sleep,
    isAlive = isProcessAlive,
  }: WaitOptions = {},
): Promise<void> => {
  let lastReportMs = Number.NEGATIVE_INFINITY
  let unreadablePolls = 0
  for (;;) {
    const attempt = tryAcquireLock(lockPath, owner)
    if (attempt.acquired) return
    // An unreadable owner is usually a lock that vanished between the attempt and the read;
    // only one that stays unreadable is corrupt.
    unreadablePolls = attempt.owner === undefined ? unreadablePolls + 1 : 0
    const corrupt = unreadablePolls >= CORRUPT_LOCK_POLLS
    if (corrupt || (attempt.owner !== undefined && !isOwnerAlive(attempt.owner, isAlive))) {
      reclaimStaleLock(lockPath, attempt.owner)
      unreadablePolls = 0
      continue
    }
    if (refuseWorktree !== undefined && attempt.owner?.worktree === refuseWorktree) {
      throw new LockHeldByWorktreeError(attempt.owner)
    }
    const nowMs = Date.now()
    if (nowMs - lastReportMs >= reportIntervalMs) {
      report(`Waiting for ${label} in ${describeOwner(attempt.owner, nowMs)}`)
      lastReportMs = nowMs
    }
    await sleep(pollIntervalMs)
  }
}

/** Each parent's children, from `ps -A -o pid=,ppid=` output. */
export const parseProcessTable = (output: string): Map<number, number[]> => {
  const children = new Map<number, number[]>()
  for (const line of output.split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (pid === undefined || ppid === undefined) continue
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || pid <= 0) continue
    children.set(ppid, [...(children.get(ppid) ?? []), pid])
  }
  return children
}

/** `root` and its descendants, parents first. Each process is visited once, so a malformed table cannot loop. */
export const treeOf = (root: number, children: Map<number, number[]>): number[] => {
  const tree = [root]
  const seen = new Set(tree)
  for (let index = 0; index < tree.length; index += 1) {
    for (const child of children.get(tree[index] as number) ?? []) {
      if (seen.has(child)) continue
      seen.add(child)
      tree.push(child)
    }
  }
  return tree
}

/** The running tree under `root` (`bun run` starting Expo starting Metro); just `root` when `ps` fails. */
export const processTree = (root: number): number[] => {
  const result = Bun.spawnSync(['ps', '-A', '-o', 'pid=,ppid='])
  return result.exitCode === 0 ? treeOf(root, parseProcessTable(result.stdout.toString())) : [root]
}

export const signalProcesses = (pids: readonly number[], signal: NodeJS.Signals) => {
  for (const pid of pids) {
    try {
      process.kill(pid, signal)
    } catch {
      // Already gone.
    }
  }
}

const SURVIVOR_GRACE_MS = 3_000
const SURVIVOR_POLL_MS = 100

/** Waits briefly for `pids` to exit after a stop signal, then kills the rest. */
export const killSurvivors = async (pids: readonly number[]) => {
  const alive = () => pids.filter((pid) => isProcessAlive(pid))
  for (let waited = 0; waited < SURVIVOR_GRACE_MS && alive().length > 0; waited += SURVIVOR_POLL_MS) {
    await Bun.sleep(SURVIVOR_POLL_MS)
  }
  signalProcesses(alive(), 'SIGKILL')
}

export const SIGNAL_EXIT_CODES: Record<string, number> = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }
/** `timeout(1)`'s status for a command it stopped. */
export const LEASE_EXPIRED_EXIT_CODE = 124
const LEASE_WARNING_MS = 2 * 60_000
/** How long a command stopped at the end of its lease gets before it is killed. */
const LEASE_KILL_GRACE_MS = 10_000

/**
 * Waits until `owner` holds every lock the run needs and returns their paths. A lock it
 * gives up on (the simulator lock trying another slot) it releases itself.
 */
export type AcquireLocks = (owner: LockOwner) => Promise<string[]>

/** Acquires the one lock at `lockPath`. */
export const singleLock =
  (lockPath: string, { label, refuseSameWorktree = false }: { label: string; refuseSameWorktree?: boolean }): AcquireLocks =>
  async (owner) => {
    mkdirSync(dirname(lockPath), { recursive: true })
    sweepLeftovers(lockPath)
    await acquireLock(lockPath, owner, { label, refuseWorktree: refuseSameWorktree ? owner.worktree : undefined })
    return [lockPath]
  }

type RunOptions = {
  acquire: AcquireLocks
  /** What the command is, for messages: `Metro`, `Simulator session`. */
  label: string
  /** Stop the command and free the lock after this long. */
  leaseMs?: number
  /** How to hold the lock longer, appended to the lease messages. */
  leaseHint?: string
  /**
   * Runs once the lock is held; a returned message aborts the run with it. Variables it
   * sets in `process.env` reach the command.
   */
  beforeRun?: () => Promise<string | undefined>
}

const minutes = (ms: number) => `${Math.round((ms / 60_000) * 10) / 10}m`

/** A fresh owner for this process, in this worktree. */
export const createLockOwner = (): LockOwner => ({
  pid: process.pid,
  pidStartedAt: processStartTime(process.pid),
  worktree: process.cwd(),
  startedAtMs: Date.now(),
  token: randomUUID(),
})

/**
 * Runs `command` while holding the locks `acquire` takes, waiting for any other holder
 * first. Every held lock is released when this process exits, however it exits.
 */
export const runLocked = async (
  command: string[],
  { acquire, label, leaseMs, leaseHint = '', beforeRun }: RunOptions,
  owner: LockOwner = createLockOwner(),
) => {
  let child: ReturnType<typeof Bun.spawn> | undefined
  /** The command's process tree when it was told to stop: what must be gone before the locks are released. */
  let stopping: number[] = []
  /**
   * Stops the whole tree, not just the child: `expo run:ios` leaves Metro as a grandchild,
   * which a signal to the child alone orphans, still holding the slot's port.
   */
  const stopTree = (signal: NodeJS.Signals) => {
    if (child === undefined) return
    stopping = processTree(child.pid)
    signalProcesses(stopping, signal)
  }
  for (const signal of Object.keys(SIGNAL_EXIT_CODES) as NodeJS.Signals[]) {
    process.on(signal, () => {
      if (child) stopTree(signal)
      else process.exit(SIGNAL_EXIT_CODES[signal])
    })
  }

  let lockPaths: string[]
  try {
    lockPaths = await acquire(owner)
  } catch (error) {
    if (!(error instanceof LockHeldByWorktreeError)) throw error
    console.error(`${label} is already running in this worktree (pid ${error.owner.pid}); stop it first.`)
    process.exit(1)
  }
  process.on('exit', () => {
    // Last taken, first released: a device claim goes before its slot, so a waiter that
    // takes the slot never finds the device still claimed.
    for (const lockPath of [...lockPaths].reverse()) releaseLock(lockPath, owner)
  })

  const problem = await beforeRun?.()
  if (problem !== undefined) {
    console.error(problem)
    process.exit(1)
  }

  if (leaseMs !== undefined) owner.leaseEndsAtMs = Date.now() + leaseMs
  // `env: process.env` passes the environment as it is now, with what `beforeRun` set;
  // Bun's default is the environment the process started with.
  child = Bun.spawn(command, { env: process.env, stdio: ['inherit', 'inherit', 'inherit'] })
  const childStartedAt = processStartTime(child.pid)
  for (const lockPath of lockPaths) recordChildPid(lockPath, owner, child.pid, childStartedAt)

  let leaseExpired = false
  if (leaseMs !== undefined) {
    const hint = leaseHint ? ` ${leaseHint}` : ''
    if (leaseMs > LEASE_WARNING_MS) {
      setTimeout(
        () => console.error(`${label}: the lock's ${minutes(leaseMs)} lease ends in 2 minutes.${hint}`),
        leaseMs - LEASE_WARNING_MS,
      ).unref()
    }
    setTimeout(() => {
      leaseExpired = true
      console.error(`${label}: the lock's ${minutes(leaseMs)} lease ended; stopping it for the next waiter.${hint}`)
      stopTree('SIGTERM')
      const tree = stopping
      setTimeout(() => signalProcesses(tree, 'SIGKILL'), LEASE_KILL_GRACE_MS).unref()
    }, leaseMs).unref()
  }

  const exitCode = await child.exited
  // Whatever of the stopped tree outlived the child (a Metro that ignored the signal) goes
  // now, so the port is free when the next session takes the slot.
  await killSurvivors(stopping)
  if (leaseExpired) process.exit(LEASE_EXPIRED_EXIT_CODE)
  const signalExit = child.signalCode ? SIGNAL_EXIT_CODES[child.signalCode] : undefined
  process.exit(signalExit ?? exitCode)
}
