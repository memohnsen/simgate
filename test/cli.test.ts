import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deviceRequest, parseCli } from '../src/cli'
import { LEASE_EXPIRED_EXIT_CODE, isProcessAlive, readLockOwner, releaseLock, tryAcquireLock, type LockOwner } from '../src/lock'
import { DEFAULT_LEASE_MINUTES, applySessionEnvironment, isListening, leaseMinutes, lockPath, portProblem, sessionFor } from '../src/session'

const cli = join(import.meta.dir, '../src/cli.ts')
let directory: string
let basePath: string

beforeEach(() => {
  // A process's cwd is the resolved path (macOS's /var is /private/var), and the lock compares it.
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'simgate-cli-')))
  basePath = join(directory, 'simulator.lock')
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

/** A lock held by this test process, which stays alive for the whole test. */
const heldBy = (worktree: string, extra: Partial<LockOwner> = {}): LockOwner => ({
  pid: process.pid,
  worktree,
  startedAtMs: Date.now(),
  token: `held-${worktree}`,
  ...extra,
})

const listen = async (): Promise<[Server, number]> => {
  const server = createServer()
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  return [server, (server.address() as { port: number }).port]
}

const close = (server: Server) => new Promise<void>((done) => server.close(() => done()))

/** A port nothing listens on, with the one above it free too (slot 2's). */
const freePort = async () => {
  for (;;) {
    const [server, port] = await listen()
    await close(server)
    if (port < 65_000 && !(await isListening(port + 1, '127.0.0.1'))) return port
  }
}

/**
 * Runs the CLI. Sessions are Android's, so on a Mac these lock tests neither claim nor boot
 * a real simulator; `slots.test.ts` covers slots and devices.
 */
const simgate = async (args: string[], env: Record<string, string> = {}) =>
  Bun.spawn(['bun', cli, ...args], {
    cwd: directory,
    env: { ...process.env, SIMGATE_LOCK_PATH: basePath, SIMGATE_BASE_PORT: String(await freePort()), ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })

const run = (command: string[], options: string[] = []) => ['run', '--platform', 'android', ...options, '--', ...command]

describe('parseCli', () => {
  test('reads run options before -- and the command after it', () => {
    expect(parseCli(['run', '--', 'expo', 'start'])).toEqual({
      kind: 'run',
      command: ['expo', 'start'],
      platform: 'ios',
      metro: true,
      device: undefined,
      bundleId: undefined,
      recordBuild: false,
      fingerprintCommand: undefined,
      leaseMin: undefined,
    })
    const parsed = parseCli([
      'run',
      '--platform',
      'ios',
      '--no-metro',
      '--device',
      'iPad Pro',
      '--bundle-id',
      'com.example.app',
      '--record-build',
      '--fingerprint-command',
      'git rev-parse HEAD:ios',
      '--open-url',
      'app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A{port}',
      '--lease-min',
      '60',
      '--',
      'xcodebuild',
      '--no-metro',
    ])
    expect(parsed).toMatchObject({
      kind: 'run',
      command: ['xcodebuild', '--no-metro'],
      metro: false,
      device: 'iPad Pro',
      bundleId: 'com.example.app',
      recordBuild: true,
      fingerprintCommand: 'git rev-parse HEAD:ios',
      openUrl: 'app://expo-development-client/?url=http%3A%2F%2Flocalhost%3A{port}',
      leaseMin: '60',
    })
    expect(parseCli(['in-session', '--', 'maestro', 'test'])).toEqual({ kind: 'in-session', command: ['maestro', 'test'] })
  })

  test('refuses what it cannot run', () => {
    const error = (argv: string[]) => (parseCli(argv) as { message?: string }).message
    expect(error(['run', 'expo'])).toContain('needs -- before the command')
    expect(error(['run', '--'])).toContain('needs a command')
    expect(error(['run', '--platform', 'tvos', '--', 'x'])).toContain('--platform must be')
    expect(error(['run', '--device', '--', 'x'])).toContain('--device needs a value')
    expect(error(['run', '--record-build', '--', 'x'])).toContain('--record-build needs --bundle-id')
    expect(error(['run', '--wat', '--', 'x'])).toContain('unknown option')
    expect(error(['in-session', '--platform', 'ios', '--', 'x'])).toContain('takes no options')
    expect(error(['status', 'x'])).toContain('takes no arguments')
    expect(error(['nope'])).toContain('unknown command')
    expect(parseCli([])).toEqual({ kind: 'help' })
  })

  test('takes the device from the flag, then SIMGATE_DEVICE, then the command', () => {
    const command = ['run-ios', '--device', '{udid}', '--device', 'iPad']
    expect(deviceRequest('iPhone 17', { SIMGATE_DEVICE: 'iPad' }, command)).toBe('iPhone 17')
    expect(deviceRequest(undefined, { SIMGATE_DEVICE: 'iPad mini' }, command)).toBe('iPad mini')
    expect(deviceRequest(undefined, { SIMGATE_DEVICE: '' }, command)).toBe('iPad')
    expect(deviceRequest(undefined, {}, ['run-ios', '--device', '{udid}'])).toBeUndefined()
  })
})

describe('settings', () => {
  test('keeps slot 1 at the path checkouts before simgate used', () => {
    expect(lockPath({}, '/home/me')).toBe('/home/me/.cache/metro/simulator.lock')
    expect(lockPath({ XDG_CACHE_HOME: '' }, '/home/me')).toBe('/home/me/.cache/metro/simulator.lock')
    expect(lockPath({ XDG_CACHE_HOME: '/xdg' }, '/home/me')).toBe('/xdg/metro/simulator.lock')
    expect(lockPath({ SIMGATE_LOCK_PATH: '/tmp/t.lock', XDG_CACHE_HOME: '/xdg' }, '/home/me')).toBe('/tmp/t.lock')
  })

  test('leases 30 minutes by default, from the flag or either variable, and rejects nonsense', () => {
    expect(leaseMinutes(undefined, {})).toBe(DEFAULT_LEASE_MINUTES)
    expect(leaseMinutes(undefined, { METRO_SIMULATOR_LEASE_MIN: '45' })).toBe(45)
    expect(leaseMinutes(undefined, { SIMGATE_LEASE_MIN: '60', METRO_SIMULATOR_LEASE_MIN: '45' })).toBe(60)
    expect(leaseMinutes('90', { SIMGATE_LEASE_MIN: '60' })).toBe(90)
    for (const bad of ['0', '-5', 'soon', '1441', 'Infinity']) expect(() => leaseMinutes(bad, {})).toThrow('lease')
  })

  test('points the command at the slot’s port and the claimed simulator, never an inherited one', () => {
    expect(applySessionEnvironment({ PATH: '/bin' }, { slot: 2, port: 8082, udid: 'U' })).toEqual({
      PATH: '/bin',
      RCT_METRO_PORT: '8082',
      SIMGATE_PORT: '8082',
      SIMGATE_SLOT: '2',
      SIMGATE_UDID: 'U',
    })
    expect(applySessionEnvironment({ SIMGATE_UDID: 'STALE' }, { slot: 1, port: 8081 })).toEqual({
      RCT_METRO_PORT: '8081',
      SIMGATE_PORT: '8081',
      SIMGATE_SLOT: '1',
    })
  })
})

describe('portProblem', () => {
  test('names a listener started outside simgate and passes a free port', async () => {
    const [server, port] = await listen()
    try {
      expect(await portProblem(port)).toContain(`Port ${port} is in use by a process started outside simgate`)
    } finally {
      await close(server)
    }
    expect(await portProblem(await freePort())).toBeUndefined()
  })
})

describe('sessionFor', () => {
  test('finds this worktree’s live session in either slot', () => {
    expect(sessionFor(basePath, '/work/mine')).toContain('no session is running')
    tryAcquireLock(basePath, heldBy('/work/other'))
    expect(sessionFor(basePath, '/work/mine')).toContain('the simulators are held by /work/other')
    const mine = heldBy('/work/mine', { simulatorSession: { slot: 2, port: 8082, udid: 'U', deviceName: 'iPhone 17' } })
    tryAcquireLock(join(directory, 'simulator-2.lock'), mine)
    expect(sessionFor(basePath, '/work/mine')).toEqual(mine)
  })
})

describe('simgate run', () => {
  test('holds slot 1 with its lease and session while the command runs, then releases it', async () => {
    const child = await simgate(
      run(['sh', '-c', 'sleep 0.3; grep -q leaseEndsAtMs "$SIMGATE_LOCK_PATH/owner.json" && grep -q simulatorSession "$SIMGATE_LOCK_PATH/owner.json" && exit 7']),
    )
    expect(await child.exited).toBe(7)
    expect(existsSync(basePath)).toBe(false)
  })

  test('hands the command its port and no simulator, filling {port} and dropping --device {udid}', async () => {
    const child = await simgate(
      run(['sh', '-c', 'test "$1:$2:$RCT_METRO_PORT" = "x:$SIMGATE_PORT:$SIMGATE_PORT" && test -z "${SIMGATE_UDID+set}" && test "$SIMGATE_SLOT" = 1 && exit 6', 'sh', 'x', '{port}', '--device', '{udid}']),
      { SIMGATE_UDID: 'STALE' },
    )
    expect(await child.exited).toBe(6)
  })

  test('refuses to queue behind a session from its own worktree, and leaves that lock alone', async () => {
    const holder = heldBy(directory)
    tryAcquireLock(basePath, holder)
    const child = await simgate(run(['true']))
    expect(await child.exited).toBe(1)
    expect(await new Response(child.stderr).text()).toContain('Metro is already running in this worktree')
    expect(readLockOwner(basePath)?.token).toBe(holder.token)
  })

  test('waits for a checkout that predates simgate, holding slot 1 without a session, then starts', async () => {
    const legacy = heldBy('/work/old-checkout')
    tryAcquireLock(basePath, legacy)
    const marker = join(directory, 'started')
    const child = await simgate(run(['touch', marker]))
    await Bun.sleep(500)
    expect(existsSync(marker)).toBe(false)
    releaseLock(basePath, legacy)
    expect(await child.exited).toBe(0)
    expect(existsSync(marker)).toBe(true)
    expect(await new Response(child.stderr).text()).toContain('Waiting for Metro in /work/old-checkout')
  })

  test('Android waits for slot 1 even while slot 2 is free', async () => {
    const ios = heldBy('/work/ios', { simulatorSession: { slot: 1, port: 8081, udid: 'U', deviceName: 'iPhone 17' } })
    tryAcquireLock(basePath, ios)
    const marker = join(directory, 'started')
    const child = await simgate(run(['touch', marker]))
    await Bun.sleep(500)
    expect(existsSync(marker)).toBe(false)
    expect(existsSync(join(directory, 'simulator-2.lock'))).toBe(false)
    releaseLock(basePath, ios)
    expect(await child.exited).toBe(0)
  })

  test('does not start when something outside simgate holds the port, unless it runs without Metro', async () => {
    const [server, port] = await listen()
    try {
      const child = await simgate(run(['true']), { SIMGATE_BASE_PORT: String(port) })
      expect(await child.exited).toBe(1)
      expect(await new Response(child.stderr).text()).toContain(`Port ${port} is in use`)
      expect(existsSync(basePath)).toBe(false)
      const withoutMetro = await simgate(run(['sh', '-c', 'exit 5'], ['--no-metro']), { SIMGATE_BASE_PORT: String(port) })
      expect(await withoutMetro.exited).toBe(5)
    } finally {
      await close(server)
    }
  })

  test('a stop signal takes down the whole tree, so a grandchild Metro cannot keep the port', async () => {
    const pidFile = join(directory, 'grandchild.pid')
    // The grandchild ignores SIGTERM, like a Metro that will not stop: it must still go.
    const child = await simgate(run(['sh', '-c', `sh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' & wait`]))
    for (let waited = 0; !existsSync(pidFile) && waited < 5_000; waited += 50) await Bun.sleep(50)
    const grandchild = Number(await Bun.file(pidFile).text())
    expect(isProcessAlive(grandchild)).toBe(true)
    child.kill('SIGTERM')
    expect(await child.exited).toBe(143)
    expect(isProcessAlive(grandchild)).toBe(false)
    expect(existsSync(basePath)).toBe(false)
  })

  test('stops the command and its children when the lease ends', async () => {
    const started = Date.now()
    const child = await simgate(run(['sh', '-c', 'sleep 30 & wait'], ['--lease-min', '0.01']))
    expect(await child.exited).toBe(LEASE_EXPIRED_EXIT_CODE)
    expect(await new Response(child.stderr).text()).toContain('lease ended')
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(existsSync(basePath)).toBe(false)
  })
})

describe('simgate in-session', () => {
  test('runs only beside this worktree’s own session, aimed at its device and port', async () => {
    const refused = await simgate(['in-session', '--', 'sh', '-c', 'exit 3'])
    expect(await refused.exited).toBe(1)
    expect(await new Response(refused.stderr).text()).toContain('no session is running')

    const holder = heldBy(directory, { simulatorSession: { slot: 2, port: 9182, udid: 'U' } })
    tryAcquireLock(join(directory, 'simulator-2.lock'), holder)
    const ran = await simgate([
      'in-session',
      '--',
      'sh',
      '-c',
      'test "$RCT_METRO_PORT:$SIMGATE_UDID:$1:$2" = "9182:U:--device:U" && exit 3',
      'sh',
      '--device',
      '{udid}',
    ])
    expect(await ran.exited).toBe(3)
    expect(readLockOwner(join(directory, 'simulator-2.lock'))?.token).toBe(holder.token)
  })
})

describe('simgate in-session signals', () => {
  test('a stop signal takes down the whole command tree', async () => {
    tryAcquireLock(basePath, heldBy(directory, { simulatorSession: { slot: 1, port: 8081 } }))
    const pidFile = join(directory, 'grandchild.pid')
    const child = await simgate(['in-session', '--', 'sh', '-c', `sh -c 'trap "" TERM; echo $$ > ${pidFile}; while :; do sleep 1; done' & wait`])
    for (let waited = 0; !existsSync(pidFile) && waited < 5_000; waited += 50) await Bun.sleep(50)
    const grandchild = Number(await Bun.file(pidFile).text())
    child.kill('SIGTERM')
    expect(await child.exited).toBe(143)
    expect(isProcessAlive(grandchild)).toBe(false)
  })
})

describe('simgate status', () => {
  test('shows each slot', async () => {
    tryAcquireLock(basePath, heldBy('/work/other', { simulatorSession: { slot: 1, port: 8081, udid: 'U', deviceName: 'iPhone 17' } }))
    const child = await simgate(['status'])
    expect(await child.exited).toBe(0)
    const out = await new Response(child.stdout).text()
    expect(out).toContain('/work/other on iPhone 17')
    expect(out).toContain('slot 2')
    expect(out).toContain('free')
  })
})
