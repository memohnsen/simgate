/**
 * The slots and device claims `simgate run` takes before it runs a command. A machine runs at most two simulator sessions at once, each on its own device:
 *
 * - Slot 1 is the original lock, `simulator.lock`, with Metro on 8081. Every kind of session
 *   can hold it: iOS, Android, web, and MeetCal's.
 * - Slot 2, `simulator-2.lock`, with Metro on 8082, is for a second iOS session only. A
 *   session tries it only while slot 1 is held by a session that records its slot and
 *   device (`simulatorSession` in the owner file). A holder that does not (a checkout that
 *   predates simgate and still runs its own lock script) may be driving any simulator, so
 *   nobody runs beside it.
 * - An iOS session also claims its simulator, `simulator-device-<UDID>.lock`, so two
 *   sessions never drive one device. When every device it may use is claimed, it gives its
 *   slot back and keeps waiting.
 *
 * Android stays one at a time because it only ever takes slot 1. A slot-2 iOS session never
 * competes for slot 1, so Android waits on exactly what it waited on before: the slot-1
 * holder, and whoever wins the race when that slot frees.
 *
 * Every lock uses `lock.ts`'s mechanics: atomic rename, owner liveness, stale reclaim.
 */
import { mkdirSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import {
  LockHeldByWorktreeError,
  describeOwner,
  isOwnerAlive,
  isProcessAlive,
  readLockOwner,
  reclaimStaleLock,
  releaseLock,
  sweepLeftovers,
  tryAcquireLock,
  writeLockOwner,
  type AcquireLocks,
  type LockOwner,
  type SimulatorSession,
} from './lock'
import { isSimulatorUdid, type DeviceChoice } from './devices'

export const SLOT_COUNT = 2
const POLL_INTERVAL_MS = 2_000
const REPORT_INTERVAL_MS = 30_000
/** Polls that must find the same unreadable lock before it is treated as corrupt. */
const CORRUPT_LOCK_POLLS = 3
/** Re-plans after losing a device claim race, before giving the slot back for a poll. */
const CLAIM_ATTEMPTS = 3

const stem = (basePath: string) => basePath.replace(/\.lock$/, '')

/** Slot 1 is the base path MeetCal and older checkouts use; slot 2 sits beside it. */
export const slotLockPath = (basePath: string, slot: number) => (slot === 1 ? basePath : `${stem(basePath)}-${slot}.lock`)

/** Each slot's Metro port: the base port (8081) for slot 1, the next one up for slot 2. */
export const slotPort = (basePort: number, slot: number) => basePort + slot - 1

export const deviceLockPath = (basePath: string, udid: string) => {
  if (!isSimulatorUdid(udid)) throw new Error(`Not a simulator UDID: ${udid}`)
  return `${stem(basePath)}-device-${udid}.lock`
}

type IsAlive = (pid: number, startedAt?: string) => boolean

/** The live owner of the lock at `path`, if any. */
const liveOwner = (path: string, isAlive: IsAlive) => {
  const owner = readLockOwner(path)
  return owner !== undefined && isOwnerAlive(owner, isAlive) ? owner : undefined
}

/** UDIDs claimed by live sessions other than the one with `token`. */
export const claimedDevices = (basePath: string, token: string, isAlive: IsAlive = isProcessAlive) => {
  const prefix = `${basename(stem(basePath))}-device-`
  const claimed = new Set<string>()
  let names: string[]
  try {
    names = readdirSync(dirname(basePath))
  } catch {
    return claimed
  }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.lock')) continue
    const udid = name.slice(prefix.length, -'.lock'.length)
    if (!isSimulatorUdid(udid)) continue
    const owner = liveOwner(join(dirname(basePath), name), isAlive)
    if (owner !== undefined && owner.token !== token) claimed.add(udid)
  }
  return claimed
}

/**
 * Whether a session that could not take slot 1 may try slot 2: only an iOS session, and only
 * beside a live slot-1 holder that records its slot and device. Any other holder (an older
 * checkout, MeetCal) may be driving any simulator. Slot 1 always comes first, so a lone
 * session runs where it always has, on 8081.
 */
export const maySecondSlot = (wantsDevice: boolean, slotOneHolder: LockOwner | undefined) =>
  wantsDevice && slotOneHolder?.simulatorSession !== undefined

/** The live session this worktree runs, in any slot. */
export const worktreeSession = (basePath: string, worktree: string, isAlive: IsAlive = isProcessAlive) => {
  for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
    const owner = liveOwner(slotLockPath(basePath, slot), isAlive)
    if (owner?.worktree === worktree) return owner
  }
  return undefined
}

/** Who holds each slot, for the waiting message. */
export const describeSlots = (basePath: string, slots: readonly number[], nowMs: number, isAlive: IsAlive = isProcessAlive) =>
  slots
    .map((slot) => liveOwner(slotLockPath(basePath, slot), isAlive))
    .filter((owner) => owner !== undefined)
    .map((owner) => describeOwner(owner, nowMs))
    .join(' and ')

export type ChooseDevice = (claimedByOthers: ReadonlySet<string>) => Promise<DeviceChoice>

type SlotOptions = {
  basePath: string
  basePort: number
  /** What is waiting, for messages: `Metro`, `Simulator session`. */
  label: string
  /** Plans the simulator an iOS session claims; absent for Android, web, and machines without simctl. */
  chooseDevice?: ChooseDevice
  pollIntervalMs?: number
  reportIntervalMs?: number
  report?: (message: string) => void
  sleep?: (ms: number) => Promise<void>
  isAlive?: IsAlive
}

type Take = 'taken' | 'held'

/**
 * Waits for a slot (and, for an iOS session, a device) and returns the held lock paths.
 * `owner.simulatorSession` names the slot, port and device once it returns.
 */
export const simulatorSlots =
  ({
    basePath,
    basePort,
    label,
    chooseDevice,
    pollIntervalMs = POLL_INTERVAL_MS,
    reportIntervalMs = REPORT_INTERVAL_MS,
    report = (message) => console.error(message),
    sleep = Bun.sleep,
    isAlive = isProcessAlive,
  }: SlotOptions): AcquireLocks =>
  async (owner) => {
    mkdirSync(dirname(basePath), { recursive: true })
    for (let slot = 1; slot <= SLOT_COUNT; slot += 1) sweepLeftovers(slotLockPath(basePath, slot))
    const unreadable = new Map<string, number>()

    /** One attempt at `path`, reclaiming it first when its owner is gone or it stays unreadable. */
    const take = (path: string): Take => {
      const attempt = tryAcquireLock(path, owner)
      if (attempt.acquired) return 'taken'
      const polls = attempt.owner === undefined ? (unreadable.get(path) ?? 0) + 1 : 0
      unreadable.set(path, polls)
      if (polls >= CORRUPT_LOCK_POLLS || (attempt.owner !== undefined && !isOwnerAlive(attempt.owner, isAlive))) {
        reclaimStaleLock(path, attempt.owner)
        unreadable.delete(path)
        return tryAcquireLock(path, owner).acquired ? 'taken' : 'held'
      }
      return 'held'
    }

    /** Claims a device for the slot just taken; the waiting reason when none is free. */
    const claimDevice = async (choose: ChooseDevice, session: SimulatorSession): Promise<string | { reason: string }> => {
      for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
        const choice = await choose(claimedDevices(basePath, owner.token, isAlive))
        if (choice.kind === 'unknown') throw new Error('No simulator matches the requested device; see xcrun simctl list devices.')
        if (choice.kind === 'claimed') {
          return { reason: `${choice.devices.map((device) => device.name).join(', ')} (claimed by another session)` }
        }
        const path = deviceLockPath(basePath, choice.device.udid)
        sweepLeftovers(path)
        owner.simulatorSession = { ...session, udid: choice.device.udid, deviceName: choice.device.name }
        if (take(path) === 'taken') return path
        owner.simulatorSession = session
      }
      return { reason: 'a free simulator' }
    }

    /** Takes `slot` and, for an iOS session, a device: the held paths, a waiting reason, or undefined when the slot is busy. */
    const takeSlot = async (slot: number): Promise<string[] | { reason: string } | undefined> => {
      const slotPath = slotLockPath(basePath, slot)
      const session = { slot, port: slotPort(basePort, slot) }
      owner.simulatorSession = session
      if (take(slotPath) !== 'taken') return undefined
      if (chooseDevice === undefined) return [slotPath]
      let claim: string | { reason: string }
      try {
        claim = await claimDevice(chooseDevice, session)
      } catch (error) {
        releaseLock(slotPath, owner)
        throw error
      }
      if (typeof claim === 'string') {
        // The slot's owner file was written before the claim; record the device in it too.
        writeLockOwner(slotPath, owner)
        return [slotPath, claim]
      }
      releaseLock(slotPath, owner)
      return claim
    }

    let lastReportMs = Number.NEGATIVE_INFINITY
    for (;;) {
      const mine = worktreeSession(basePath, owner.worktree, isAlive)
      if (mine !== undefined) throw new LockHeldByWorktreeError(mine)

      const slots = [1]
      let result = await takeSlot(1)
      // Read after the attempt, so a holder that took slot 1 meanwhile is the one judged.
      if (result === undefined && maySecondSlot(chooseDevice !== undefined, liveOwner(slotLockPath(basePath, 1), isAlive))) {
        slots.push(2)
        result = await takeSlot(2)
      }
      if (Array.isArray(result)) return result
      const waitingFor = result?.reason
      owner.simulatorSession = undefined

      const nowMs = Date.now()
      if (nowMs - lastReportMs >= reportIntervalMs) {
        const holders = describeSlots(basePath, slots, nowMs, isAlive) || 'another checkout'
        report(
          waitingFor === undefined
            ? `Waiting for ${label} in ${holders}`
            : `Waiting for ${label}: every matching simulator is in use: ${waitingFor}`,
        )
        lastReportMs = nowMs
      }
      await sleep(pollIntervalMs)
    }
  }
