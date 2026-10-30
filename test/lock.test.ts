import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  LockHeldByWorktreeError,
  acquireLock,
  describeOwner,
  isOwnerAlive,
  isProcessAlive,
  parseProcessTable,
  processStartTime,
  readLockOwner,
  reclaimStaleLock,
  recordChildPid,
  releaseLock,
  sweepLeftovers,
  treeOf,
  tryAcquireLock,
  type LockOwner,
} from '../src/lock'

let directory: string
let lockPath: string

const owner = (pid: number, token: string): LockOwner => ({
  pid,
  worktree: `/work/${token}`,
  startedAtMs: 0,
  token,
})

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'check-lock-'))
  lockPath = join(directory, 'atlas-check.lock')
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

/** Only the lock itself may remain; staging and stale copies are always cleaned up. */
const leftovers = () => readdirSync(directory).filter((name) => name !== 'atlas-check.lock')

describe('tryAcquireLock', () => {
  test('creates the lock with its owner already recorded', () => {
    expect(tryAcquireLock(lockPath, owner(1, 'a'))).toEqual({ acquired: true })
    expect(readLockOwner(lockPath)).toEqual(owner(1, 'a'))
    expect(leftovers()).toEqual([])
  })

  test('reports the current owner when the lock is held', () => {
    tryAcquireLock(lockPath, owner(1, 'a'))
    expect(tryAcquireLock(lockPath, owner(2, 'b'))).toEqual({
      acquired: false,
      owner: owner(1, 'a'),
    })
    expect(readLockOwner(lockPath)?.token).toBe('a')
    expect(leftovers()).toEqual([])
  })
})

describe('readLockOwner', () => {
  test('treats a missing or malformed owner file as unknown', () => {
    expect(readLockOwner(lockPath)).toBeUndefined()
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner.json'), '{not json')
    expect(readLockOwner(lockPath)).toBeUndefined()
    writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: -1, token: 'x' }))
    expect(readLockOwner(lockPath)).toBeUndefined()
  })
})

describe('releaseLock', () => {
  test('removes only a lock this owner holds', () => {
    tryAcquireLock(lockPath, owner(1, 'a'))
    releaseLock(lockPath, owner(2, 'b'))
    expect(existsSync(lockPath)).toBe(true)
    releaseLock(lockPath, owner(1, 'a'))
    expect(existsSync(lockPath)).toBe(false)
  })
})

describe('reclaimStaleLock', () => {
  test('removes the stale lock it judged', () => {
    tryAcquireLock(lockPath, owner(1, 'stale'))
    reclaimStaleLock(lockPath, owner(1, 'stale'))
    expect(existsSync(lockPath)).toBe(false)
    expect(leftovers()).toEqual([])
  })

  test('leaves a lock that was re-acquired after the stale check', () => {
    tryAcquireLock(lockPath, owner(2, 'fresh'))
    reclaimStaleLock(lockPath, owner(1, 'stale'))
    expect(readLockOwner(lockPath)?.token).toBe('fresh')
    expect(leftovers()).toEqual([])
  })

  test('leaves the lock to a reclaim already in progress', () => {
    tryAcquireLock(lockPath, owner(1, 'stale'))
    mkdirSync(`${lockPath}.reclaim`)
    reclaimStaleLock(lockPath, owner(1, 'stale'))
    expect(readLockOwner(lockPath)?.token).toBe('stale')
  })

  test('clears a reclaim guard left by a reclaimer that died', () => {
    tryAcquireLock(lockPath, owner(1, 'stale'))
    mkdirSync(`${lockPath}.reclaim`)
    reclaimStaleLock(lockPath, owner(1, 'stale'), Date.now() + 60_000)
    expect(existsSync(`${lockPath}.reclaim`)).toBe(false)
    reclaimStaleLock(lockPath, owner(1, 'stale'))
    expect(existsSync(lockPath)).toBe(false)
    expect(leftovers()).toEqual([])
  })

  test('removes a lock whose owner file is unreadable', () => {
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner.json'), '{not json')
    reclaimStaleLock(lockPath, undefined)
    expect(existsSync(lockPath)).toBe(false)
  })

  test('does nothing when another waiter already reclaimed the lock', () => {
    reclaimStaleLock(lockPath, owner(1, 'stale'))
    expect(existsSync(lockPath)).toBe(false)
  })
})

describe('recordChildPid', () => {
  test('keeps the lock live while the gate outlives its wrapper', () => {
    tryAcquireLock(lockPath, owner(1, 'a'))
    recordChildPid(lockPath, owner(1, 'a'), 2, 'started')
    const recorded = readLockOwner(lockPath)!
    expect(recorded.childPid).toBe(2)
    expect(isOwnerAlive(recorded, (pid) => pid === 2)).toBe(true)
    expect(isOwnerAlive(recorded, () => false)).toBe(false)
    expect(leftovers()).toEqual([])
  })
})

describe('sweepLeftovers', () => {
  test('deletes only old copies left beside the lock', () => {
    const old = join(directory, 'atlas-check.lock.stale-1-x')
    const fresh = join(directory, 'atlas-check.lock.staging-y')
    const unrelated = join(directory, 'other.stale-z')
    for (const path of [old, fresh, unrelated]) mkdirSync(path)
    const hourAgo = new Date(Date.now() - 2 * 60 * 60_000)
    utimesSync(old, hourAgo, hourAgo)
    utimesSync(unrelated, hourAgo, hourAgo)
    sweepLeftovers(lockPath)
    expect(readdirSync(directory).sort()).toEqual(['atlas-check.lock.staging-y', 'other.stale-z'])
  })
})

describe('acquireLock', () => {
  test('waits out a briefly unreadable lock, then reclaims one that stays unreadable', async () => {
    mkdirSync(lockPath)
    writeFileSync(join(lockPath, 'owner.json'), '{not json')
    let sleeps = 0
    await acquireLock(lockPath, owner(2, 'next'), {
      isAlive: () => true,
      report: () => {},
      sleep: async () => {
        sleeps += 1
      },
    })
    expect(sleeps).toBe(2)
    expect(readLockOwner(lockPath)?.token).toBe('next')
  })


  test('reclaims a lock whose owner has exited', async () => {
    tryAcquireLock(lockPath, owner(1, 'dead'))
    await acquireLock(lockPath, owner(2, 'next'), {
      isAlive: () => false,
      sleep: () => Promise.reject(new Error('should not wait')),
    })
    expect(readLockOwner(lockPath)?.token).toBe('next')
  })

  test('waits for a live owner and reports who holds the lock', async () => {
    tryAcquireLock(lockPath, owner(1, 'busy'))
    const reports: string[] = []
    let sleeps = 0
    await acquireLock(lockPath, owner(2, 'next'), {
      isAlive: () => true,
      report: (message) => reports.push(message),
      reportIntervalMs: 0,
      sleep: async () => {
        sleeps += 1
        if (sleeps === 3) releaseLock(lockPath, owner(1, 'busy'))
      },
    })
    expect(sleeps).toBe(3)
    expect(reports).toHaveLength(3)
    expect(reports[0]).toStartWith('Waiting for the simulator in /work/busy (pid 1, running ')
    expect(readLockOwner(lockPath)?.token).toBe('next')
  })

  test('names what the holder runs in the waiting message', async () => {
    tryAcquireLock(lockPath, owner(1, 'busy'))
    const reports: string[] = []
    await acquireLock(lockPath, owner(2, 'next'), {
      label: 'Metro',
      isAlive: () => true,
      report: (message) => reports.push(message),
      sleep: async () => releaseLock(lockPath, owner(1, 'busy')),
    })
    expect(reports[0]).toStartWith('Waiting for Metro in /work/busy (pid 1, running ')
  })

  test("refuses to wait on a live holder in the caller's own worktree", async () => {
    tryAcquireLock(lockPath, owner(1, 'busy'))
    await expect(
      acquireLock(lockPath, owner(2, 'next'), {
        refuseWorktree: '/work/busy',
        isAlive: () => true,
        sleep: () => Promise.reject(new Error('should not wait')),
      }),
    ).rejects.toBeInstanceOf(LockHeldByWorktreeError)
    expect(readLockOwner(lockPath)?.token).toBe('busy')
  })

  test('takes over a lock from its own worktree whose holder has exited', async () => {
    tryAcquireLock(lockPath, owner(1, 'busy'))
    await acquireLock(lockPath, owner(2, 'next'), {
      refuseWorktree: '/work/busy',
      isAlive: () => false,
      sleep: () => Promise.reject(new Error('should not wait')),
    })
    expect(readLockOwner(lockPath)?.token).toBe('next')
  })

  test('serializes concurrent waiters', async () => {
    const holders: string[] = []
    const waiters = ['a', 'b', 'c'].map(async (token, index) => {
      await acquireLock(lockPath, owner(index + 10, token), {
        isAlive: () => true,
        report: () => {},
        sleep: () => Bun.sleep(1),
      })
      holders.push(token)
      expect(holders.filter((holder) => holder !== 'done')).toHaveLength(1)
      await Bun.sleep(5)
      holders.splice(holders.indexOf(token), 1, 'done')
      releaseLock(lockPath, owner(index + 10, token))
    })
    await Promise.all(waiters)
    expect(holders).toEqual(['done', 'done', 'done'])
  })
})

describe('describeOwner', () => {
  test('says when a leased holder will let go', () => {
    const leased = { ...owner(1, 'busy'), startedAtMs: 0, leaseEndsAtMs: 30 * 60_000 }
    expect(describeOwner(leased, 5 * 60_000)).toBe('/work/busy (pid 1, running 5m, lease ends in 25m)')
    expect(describeOwner(leased, 40 * 60_000)).toBe('/work/busy (pid 1, running 40m, lease ends in 0m)')
    expect(describeOwner(owner(1, 'busy'), 60_000)).toBe('/work/busy (pid 1, running 1m)')
    const onDevice = { ...owner(1, 'busy'), startedAtMs: 0, simulatorSession: { slot: 2, port: 8082, udid: 'U', deviceName: 'iPhone 17' } }
    expect(describeOwner(onDevice, 60_000)).toBe('/work/busy on iPhone 17 (pid 1, running 1m)')
  })

  test('keeps a lease in the owner file it reads back', () => {
    tryAcquireLock(lockPath, { ...owner(1, 'a'), leaseEndsAtMs: 5 })
    expect(readLockOwner(lockPath)?.leaseEndsAtMs).toBe(5)
  })
})

describe('process tree', () => {
  test('lists a process and all its descendants once, ignoring junk rows', () => {
    const table = parseProcessTable(['  10     1', '  11    10', '  12    11', '  13    10', '  20     1', 'junk', ''].join('\n'))
    expect(treeOf(10, table)).toEqual([10, 11, 13, 12])
    expect(treeOf(99, table)).toEqual([99])
  })

  test('stops at a cycle', () => {
    expect(treeOf(1, parseProcessTable('1 2\n2 1'))).toEqual([1, 2])
  })
})

describe('isProcessAlive', () => {
  test('recognizes this process and rejects an exited one', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    const exited = Bun.spawnSync(['true'])
    expect(isProcessAlive(exited.pid)).toBe(false)
  })

  test('rejects a process that reused the owner ID', () => {
    const startedAt = processStartTime(process.pid)
    expect(startedAt).toBeString()
    expect(isProcessAlive(process.pid, startedAt)).toBe(true)
    expect(isProcessAlive(process.pid, 'Thu Jan  1 00:00:00 1970')).toBe(false)
  })
})

describe('runLocked', () => {
  test('passes what beforeRun sets in process.env to the command', async () => {
    const child = Bun.spawn(
      [
        'bun',
        '-e',
        `import { runLocked, singleLock } from ${JSON.stringify(join(import.meta.dir, '../src/lock.ts'))}
         await runLocked(['sh', '-c', 'test "$RUN_LOCKED_TEST" = set-in-before-run && exit 5'], {
           acquire: singleLock(process.env.TEST_LOCK_PATH, { label: 'test' }),
           label: 'test',
           beforeRun: async () => {
             process.env.RUN_LOCKED_TEST = 'set-in-before-run'
             return undefined
           },
         })`,
      ],
      { cwd: directory, env: { ...process.env, TEST_LOCK_PATH: lockPath }, stderr: 'pipe' },
    )
    expect(await child.exited).toBe(5)
    expect(existsSync(lockPath)).toBe(false)
  })
})
