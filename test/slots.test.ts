import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { LockHeldByWorktreeError, readLockOwner, releaseLock, tryAcquireLock, type LockOwner } from '../src/lock'
import {
  claimedDevices,
  deviceLockPath,
  maySecondSlot,
  simulatorSlots,
  slotLockPath,
  slotPort,
  worktreeSession,
  type ChooseDevice,
} from '../src/slots'
import type { Simulator } from '../src/devices'

const UDID_A = 'AAAAAAAA-0000-4000-8000-000000000001'
const UDID_B = 'BBBBBBBB-0000-4000-8000-000000000002'
const iphone = (udid: string, name: string): Simulator => ({ udid, name, family: 'iphone', lastUsedAt: '' })
const phoneA = iphone(UDID_A, 'iPhone A')
const phoneB = iphone(UDID_B, 'iPhone B')

let directory: string
let basePath: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'simulator-slots-'))
  basePath = join(directory, 'simulator.lock')
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

const DEAD_PID = 999_999_999
const alive = (pid: number) => pid !== DEAD_PID

let tokens = 0
const owner = (worktree: string, extra: Partial<LockOwner> = {}): LockOwner => ({
  pid: process.pid,
  worktree,
  startedAtMs: Date.now(),
  token: `token-${(tokens += 1)}`,
  ...extra,
})

/** A device-aware session in `slot`, holding `udid`'s claim too. */
const holdSession = (worktree: string, slot: number, udid?: string) => {
  const holder = owner(worktree, { simulatorSession: { slot, port: slotPort(8081, slot), udid, deviceName: udid && `device ${udid}` } })
  expect(tryAcquireLock(slotLockPath(basePath, slot), holder).acquired).toBe(true)
  if (udid !== undefined) expect(tryAcquireLock(deviceLockPath(basePath, udid), holder).acquired).toBe(true)
  return holder
}

/** Picks the first of `devices` no other session claimed, as `planSessionDevice` would. */
const firstFree =
  (devices: Simulator[]): ChooseDevice =>
  async (claimed) => {
    const free = devices.filter((device) => !claimed.has(device.udid))
    const device = free[0]
    return device === undefined ? { kind: 'claimed', devices } : { kind: 'device', device, boot: false, currentBuild: false }
  }

/** Runs `simulatorSlots` with a sleep that calls `onWait` on each poll and gives up after `maxPolls`. */
const acquire = async (
  worktree: string,
  { chooseDevice, onWait = () => {}, maxPolls = 5 }: { chooseDevice?: ChooseDevice; onWait?: (poll: number) => void; maxPolls?: number },
) => {
  const reports: string[] = []
  let polls = 0
  const session = owner(worktree)
  const paths = await simulatorSlots({
    basePath,
    basePort: 8081,
    label: 'Metro',
    chooseDevice,
    reportIntervalMs: 0,
    report: (message) => reports.push(message),
    isAlive: alive,
    sleep: async () => {
      polls += 1
      if (polls > maxPolls) throw new Error(`still waiting after ${maxPolls} polls: ${reports.at(-1)}`)
      onWait(polls)
    },
  })(session)
  return { paths, session, reports, polls }
}

describe('paths and ports', () => {
  test('keeps slot 1 at the shared path MeetCal uses and puts slot 2 and claims beside it', () => {
    expect(slotLockPath('/c/metro/simulator.lock', 1)).toBe('/c/metro/simulator.lock')
    expect(slotLockPath('/c/metro/simulator.lock', 2)).toBe('/c/metro/simulator-2.lock')
    expect(deviceLockPath('/c/metro/simulator.lock', UDID_A)).toBe(`/c/metro/simulator-device-${UDID_A}.lock`)
    expect(() => deviceLockPath('/c/metro/simulator.lock', '../x')).toThrow('Not a simulator UDID')
    expect([slotPort(8081, 1), slotPort(8081, 2)]).toEqual([8081, 8082])
  })

  test('opens slot 2 only to an iOS session beside a slot-1 holder that records its device', () => {
    expect(maySecondSlot(true, owner('/w', { simulatorSession: { slot: 1, port: 8081 } }))).toBe(true)
    expect(maySecondSlot(true, owner('/w'))).toBe(false)
    expect(maySecondSlot(true, undefined)).toBe(false)
    expect(maySecondSlot(false, owner('/w', { simulatorSession: { slot: 1, port: 8081 } }))).toBe(false)
  })
})

describe('claimedDevices', () => {
  test('lists live claims by other sessions, not its own, dead ones, or unrelated files', () => {
    const other = holdSession('/work/other', 1, UDID_A)
    const mine = owner('/work/mine')
    tryAcquireLock(deviceLockPath(basePath, UDID_B), mine)
    tryAcquireLock(join(directory, 'simulator-device-not-a-udid.lock'), other)
    expect(claimedDevices(basePath, mine.token, alive)).toEqual(new Set([UDID_A]))
    releaseLock(deviceLockPath(basePath, UDID_A), other)
    tryAcquireLock(deviceLockPath(basePath, UDID_A), owner('/work/gone', { pid: DEAD_PID }))
    expect(claimedDevices(basePath, mine.token, alive)).toEqual(new Set())
  })
})

describe('simulatorSlots', () => {
  test('a lone iOS session takes slot 1 and claims its device', async () => {
    const { paths, session, polls } = await acquire('/work/mine', { chooseDevice: firstFree([phoneA, phoneB]) })
    expect(polls).toBe(0)
    expect(paths).toEqual([basePath, deviceLockPath(basePath, UDID_A)])
    expect(session.simulatorSession).toEqual({ slot: 1, port: 8081, udid: UDID_A, deviceName: 'iPhone A' })
    // The slot's owner file names the device, for waiters and --in-session.
    expect(readLockOwner(basePath)?.simulatorSession?.udid).toBe(UDID_A)
  })

  test('a second iOS session runs at once in slot 2 on another device', async () => {
    holdSession('/work/first', 1, UDID_A)
    const { paths, session, polls } = await acquire('/work/second', { chooseDevice: firstFree([phoneA, phoneB]) })
    expect(polls).toBe(0)
    expect(paths).toEqual([slotLockPath(basePath, 2), deviceLockPath(basePath, UDID_B)])
    expect(session.simulatorSession).toEqual({ slot: 2, port: 8082, udid: UDID_B, deviceName: 'iPhone B' })
  })

  test('a third session waits, naming both holders, and starts when a slot frees', async () => {
    const first = holdSession('/work/first', 1, UDID_A)
    holdSession('/work/second', 2, UDID_B)
    const phoneC = iphone('CCCCCCCC-0000-4000-8000-000000000003', 'iPhone C')
    const { paths, reports, polls } = await acquire('/work/third', {
      chooseDevice: firstFree([phoneA, phoneB, phoneC]),
      onWait: (poll) => {
        if (poll !== 2) return
        releaseLock(basePath, first)
        releaseLock(deviceLockPath(basePath, UDID_A), first)
      },
    })
    expect(polls).toBe(2)
    expect(reports[0]).toContain('Waiting for Metro in /work/first on device')
    expect(reports[0]).toContain('and /work/second on device')
    expect(paths).toEqual([basePath, deviceLockPath(basePath, UDID_A)])
  })

  test('Android (no device) never takes slot 2, so it stays one at a time', async () => {
    const ios = holdSession('/work/ios', 1, UDID_A)
    const { paths, polls, reports } = await acquire('/work/android', {
      onWait: (poll) => {
        if (poll === 2) releaseLock(basePath, ios)
      },
    })
    expect(existsSync(slotLockPath(basePath, 2))).toBe(false)
    expect(reports[0]).toStartWith('Waiting for Metro in /work/ios on device')
    expect(polls).toBe(2)
    expect(paths).toEqual([basePath])
  })

  test('an iOS session does not run beside a slot-1 holder that does not record its device', async () => {
    const legacy = owner('/work/meetcal')
    tryAcquireLock(basePath, legacy)
    const { paths, polls } = await acquire('/work/mine', {
      chooseDevice: firstFree([phoneA]),
      onWait: (poll) => {
        if (poll === 2) releaseLock(basePath, legacy)
      },
    })
    expect(polls).toBe(2)
    expect(paths).toEqual([basePath, deviceLockPath(basePath, UDID_A)])
  })

  test('gives its slot back while every device it may use is claimed', async () => {
    const holder = holdSession('/work/first', 1, UDID_A)
    let slotTwoHeldWhileWaiting = true
    const { reports, paths } = await acquire('/work/second', {
      chooseDevice: firstFree([phoneA]),
      onWait: (poll) => {
        slotTwoHeldWhileWaiting &&= !existsSync(slotLockPath(basePath, 2))
        if (poll === 2) releaseLock(deviceLockPath(basePath, UDID_A), holder)
      },
    })
    expect(slotTwoHeldWhileWaiting).toBe(true)
    expect(reports[0]).toContain('every matching simulator is in use: iPhone A (claimed by another session)')
    expect(paths).toEqual([slotLockPath(basePath, 2), deviceLockPath(basePath, UDID_A)])
  })

  test('re-plans after losing a claim race, and reclaims a claim whose session died', async () => {
    tryAcquireLock(deviceLockPath(basePath, UDID_A), owner('/work/gone', { pid: DEAD_PID }))
    const { paths } = await acquire('/work/mine', { chooseDevice: firstFree([phoneA]) })
    expect(paths).toEqual([basePath, deviceLockPath(basePath, UDID_A)])

    // A claim that appears between planning and claiming: the planner never sees it.
    rmSync(directory, { recursive: true, force: true })
    const racer = owner('/work/racer')
    const blind: ChooseDevice = async () => ({ kind: 'device', device: phoneA, boot: false, currentBuild: false })
    const raced = acquire('/work/mine', { chooseDevice: blind, maxPolls: 1 })
    tryAcquireLock(deviceLockPath(basePath, UDID_A), racer)
    await expect(raced).rejects.toThrow('every matching simulator is in use: a free simulator')
    expect(existsSync(basePath)).toBe(false)
  })

  test('refuses to queue behind its own worktree’s session in either slot', async () => {
    holdSession('/work/first', 1, UDID_A)
    holdSession('/work/mine', 2, UDID_B)
    await expect(acquire('/work/mine', { chooseDevice: firstFree([phoneA]) })).rejects.toBeInstanceOf(LockHeldByWorktreeError)
    expect(worktreeSession(basePath, '/work/mine', alive)?.simulatorSession?.slot).toBe(2)
  })

  test('gives the slot back when the device plan fails', async () => {
    const failing: ChooseDevice = async () => ({ kind: 'unknown' })
    await expect(acquire('/work/mine', { chooseDevice: failing })).rejects.toThrow('No simulator matches')
    expect(existsSync(basePath)).toBe(false)
  })
})
