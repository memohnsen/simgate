import { describe, expect, test } from 'bun:test'

import {
  deviceFamily,
  devicesBootedDuring,
  isSimulatorUdid,
  keptSimulators,
  KEPT_SIMULATOR_NAMES,
  parseAdbEmulators,
  parseSimulators,
  planSessionDevice,
  aimCommand,
  requestedDevice,
  sessionShutdowns,
  simulatorNameKey,
  type Simulator,
} from '../src/devices'

const device = (udid: string, name: string, type: string, state = 'Booted', isAvailable = true) => ({
  udid,
  name,
  state,
  isAvailable,
  deviceTypeIdentifier: `com.apple.CoreSimulator.SimDeviceType.${type}`,
  lastUsedAt: `2026-10-29T0${udid.charCodeAt(0) % 10}:00:00Z`,
})

const iphone = (udid: string, name = 'iPhone 18 Pro', lastUsedAt = ''): Simulator => ({ udid, name, family: 'iphone', lastUsedAt })
const ipad = (udid: string, name = 'iPad Pro 13-inch (M5)', lastUsedAt = ''): Simulator => ({ udid, name, family: 'ipad', lastUsedAt })
const used = (simulator: Simulator) => ({ ...simulator, lastUsedAt: device(simulator.udid, '', '').lastUsedAt })

describe('deviceFamily', () => {
  test('reads the family from the device type, not the name', () => {
    expect(deviceFamily('com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro')).toBe('iphone')
    expect(deviceFamily('com.apple.CoreSimulator.SimDeviceType.iPad-Pro-13-inch-M5-12GB')).toBe('ipad')
    expect(deviceFamily('com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-11-46mm')).toBe('other')
    expect(deviceFamily('com.apple.CoreSimulator.SimDeviceType.iPhone')).toBe('other')
    expect(deviceFamily('iPhone-18-Pro')).toBe('other')
  })
})

describe('parseSimulators', () => {
  const listing = JSON.stringify({
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [],
      'com.apple.CoreSimulator.SimRuntime.iOS-27-0': [
        device('A', 'iPhone 18 Pro', 'iPhone-18-Pro'),
        device('B', 'Work Phone', 'iPad-Pro-11-inch-M5-12GB'),
        device('C', 'iPhone 18', 'iPhone-18', 'Shutdown'),
        device('D', 'iPhone 17', 'iPhone-17', 'Booted', false),
        device('F', 'iPhone 16', 'iPhone-16', 'Booting'),
        { udid: 'E', name: 'no type' },
        'not a device',
      ],
    },
  })

  test('lists available devices and the booted or booting subset from one listing', () => {
    const booted = [used(iphone('A')), used(ipad('B', 'Work Phone')), used(iphone('F', 'iPhone 16'))]
    expect(parseSimulators(listing)).toEqual({
      available: [...booted.slice(0, 2), used(iphone('C', 'iPhone 18')), booted[2] as Simulator],
      booted,
    })
    const withoutDate = JSON.stringify({ devices: { r: [{ ...device('A', 'iPhone 18 Pro', 'iPhone-18-Pro'), lastUsedAt: undefined }] } })
    expect(parseSimulators(withoutDate)?.booted).toEqual([iphone('A')])
  })

  test('reads output that is not simctl’s as unknown, not as nothing booted', () => {
    for (const bad of ['', 'not json', '[]', '{}', '{"devices":[]}', '{"devices":{"r":{}}}']) {
      expect(parseSimulators(bad)).toBeUndefined()
    }
    expect(parseSimulators('{"devices":{}}')).toEqual({ available: [], booted: [] })
  })
})

describe('parseAdbEmulators', () => {
  test('lists running and starting emulators, not physical devices', () => {
    const output = [
      'List of devices attached',
      'emulator-5554\tdevice',
      'emulator-5556\toffline',
      'emulator-5558\tunauthorized',
      'R58M123ABC\tdevice',
      '',
    ].join('\n')
    expect(parseAdbEmulators(output)).toEqual(['emulator-5554', 'emulator-5556'])
    expect(parseAdbEmulators('List of devices attached\n\n')).toEqual([])
  })
})

describe('devicesBootedDuring', () => {
  test('returns only devices booted after the session started', () => {
    const before = { simulators: [iphone('A')], emulators: ['emulator-5554'] }
    const after = { simulators: [iphone('A'), ipad('B')], emulators: ['emulator-5554', 'emulator-5556'] }
    expect(devicesBootedDuring(before, after)).toEqual({ simulators: [ipad('B')], emulators: ['emulator-5556'] })
  })

  test('shuts down nothing for a listing that failed at either end', () => {
    const known = { simulators: [iphone('A')], emulators: [] }
    const unknown = { simulators: undefined, emulators: undefined }
    expect(devicesBootedDuring(unknown, known)).toEqual({ simulators: [], emulators: [] })
    expect(devicesBootedDuring(known, unknown)).toEqual({ simulators: [], emulators: [] })
  })
})

describe('requestedDevice', () => {
  test('reads a --device that names a device, skipping the placeholder', () => {
    expect(requestedDevice([])).toBeUndefined()
    expect(requestedDevice(['expo', 'start', '-d', 'x'])).toBeUndefined()
    expect(requestedDevice(['run-ios', '--device', '{udid}'])).toBeUndefined()
    expect(requestedDevice(['run-ios', '--device', '{udid}', '--device', 'iPad Pro 13-inch (M5)'])).toBe('iPad Pro 13-inch (M5)')
    expect(requestedDevice(['--device=ABC'])).toBe('ABC')
  })

  test('reads a bare --device as a prompt, which a gated session refuses', () => {
    expect(requestedDevice(['--device'])).toBe('prompt')
    expect(requestedDevice(['--device='])).toBe('prompt')
    expect(requestedDevice(['--device', '--no-bundler'])).toBe('prompt')
  })
})

describe('aimCommand', () => {
  test('points every --device at the claimed simulator, once, and fills the placeholders', () => {
    expect(aimCommand(['run-ios', '--device', '{udid}', '--device', 'iPad'], 'U', 8082)).toEqual(['run-ios', '--device', 'U'])
    expect(aimCommand(['expo', 'run:ios', '--device=iPad', '--port', '{port}'], 'U', 8082)).toEqual([
      'expo',
      'run:ios',
      '--device',
      'U',
      '--port',
      '8082',
    ])
    expect(aimCommand(['xcodebuild', '-destination', 'id={udid}'], 'U', 8081)).toEqual(['xcodebuild', '-destination', 'id=U'])
    expect(aimCommand(['maestro', '--device', '{udid}', 'test'], 'U', 8081)).toEqual(['maestro', '--device', 'U', 'test'])
  })

  test('without a simulator, drops --device {udid}, keeps a named device, and refuses other {udid} uses', () => {
    expect(aimCommand(['maestro', '--device', '{udid}', 'test'], undefined, 8081)).toEqual(['maestro', 'test'])
    expect(aimCommand(['maestro', '--device', 'emulator-5554', 'test'], undefined, 8081)).toEqual([
      'maestro',
      '--device',
      'emulator-5554',
      'test',
    ])
    expect(aimCommand(['xcodebuild', '-destination', 'id={udid}'], undefined, 8081)).toEqual({
      error: '"id={udid}" needs a simulator, but this session has none (Android, or no simctl here).',
    })
  })
})

test('isSimulatorUdid accepts only UUIDs, so a UDID can never escape a lock or record path', () => {
  expect(isSimulatorUdid('CAB91C3C-2549-4C26-A61A-EF315DE1A7CA')).toBe(true)
  expect(isSimulatorUdid('cab91c3c-2549-4c26-a61a-ef315de1a7ca')).toBe(true)
  for (const bad of ['', 'A', '../../etc', 'CAB91C3C-2549-4C26-A61A-EF315DE1A7CA/..']) expect(isSimulatorUdid(bad)).toBe(false)
})

describe('keptSimulators', () => {
  const [proMax, duo, ipadName] = KEPT_SIMULATOR_NAMES

  test('ignores case, spacing, dashes and brackets in a name', () => {
    expect(simulatorNameKey('iPad Pro (13-inch) (M5)')).toBe(simulatorNameKey('ipad pro 13‑inch  (M5)'))
    expect(simulatorNameKey('iPhone Duo')).not.toBe(simulatorNameKey('Atlas iPhone Duo'))
  })

  test('keeps one device per kept name, the most recently used, and nothing else', () => {
    const older = iphone('E', duo, '2026-01-01T00:00:00Z')
    const newer = iphone('F', duo.toUpperCase(), '2026-10-01T00:00:00Z')
    const available = [iphone('A', 'iPhone 16'), older, ipad('P', ipadName), newer, iphone('D', 'Atlas iPhone Duo'), iphone('M', proMax)]
    expect(keptSimulators(available)).toEqual([available[5], newer, available[2]] as Simulator[])
  })
})

describe('planSessionDevice', () => {
  const [proMax, duo, ipadName] = KEPT_SIMULATOR_NAMES
  const available = [
    iphone('A', proMax, '2026-10-29T01:00:00Z'),
    iphone('B', duo, '2026-10-29T02:00:00Z'),
    // Not kept: never claimed, even when booted, recently used, or holding a current build.
    iphone('X', 'iPhone 16', '2026-10-30T00:00:00Z'),
    iphone('Y', duo, '2026-10-01T00:00:00Z'),
    ipad('P', ipadName),
    ipad('Q', 'iPad Pro 11-inch (M5)', '2026-10-30T00:00:00Z'),
  ]
  const [a, b, x, y, p, q] = available as [Simulator, Simulator, Simulator, Simulator, Simulator, Simulator]
  const none = new Set<string>()
  const plan = (request: string | undefined, booted: Simulator[], claimed = none, current = none) =>
    planSessionDevice(request, { available, booted }, claimed, current)
  const picked = (device: Simulator, boot: boolean, currentBuild: boolean) => ({ kind: 'device' as const, device, boot, currentBuild })

  test('prefers a booted device with a current build over a more recently used one without', () => {
    expect(plan(undefined, [a, b], none, new Set(['A']))).toEqual(picked(a, false, true))
  })

  test('boots a device with a current build rather than build onto a booted one, under the cap', () => {
    expect(plan(undefined, [b], none, new Set(['A']))).toEqual(picked(a, true, true))
  })

  test('builds onto a booted device rather than boot a third iPhone for its build', () => {
    expect(plan(undefined, [x, b], none, new Set(['A']))).toEqual(picked(b, false, false))
  })

  test('without current builds, reuses the most recently used booted iPhone, else boots one', () => {
    expect(plan(undefined, [a, b, p])).toEqual(picked(b, false, false))
    // An iPad booted alone: Expo would take it, so the plan names an iPhone.
    expect(plan(undefined, [p])).toEqual(picked(b, true, false))
  })

  test('picks only among the kept iPhones by default, never another booted or current simulator', () => {
    expect(plan(undefined, [x, y], none, new Set(['X', 'Y']))).toEqual(picked(b, true, false))
    expect(plan(undefined, [x, a], none, new Set(['X']))).toEqual(picked(a, false, false))
  })

  test('skips devices other sessions claimed, and waits when both kept iPhones are held', () => {
    expect(plan(undefined, [a, b], new Set(['B']))).toEqual(picked(a, false, false))
    expect(plan(undefined, [b], new Set(['B']))).toEqual(picked(a, true, false))
    expect(plan(undefined, [a, b], new Set(['A', 'B']))).toEqual({ kind: 'claimed', devices: [a, b] })
  })

  test('boots a kept iPhone past the cap only when every booted one is held, or when named', () => {
    // Two iPhones booted, the only kept one among them held: it boots past the cap rather than stall.
    expect(plan(undefined, [x, a], new Set(['A']))).toEqual(picked(b, true, false))
    expect(plan(duo, [x, a])).toEqual(picked(b, true, false))
  })

  test('matches a kept device by a variant of its name or by its UDID in any case, and keeps the iPhone for an iPad run', () => {
    expect(plan(proMax.toLowerCase(), [a])).toEqual(picked(a, false, false))
    expect(plan(` ${ipadName.toUpperCase()} `, [a])).toEqual(picked(p, true, false))
    expect(plan('p', [a, p])).toEqual(picked(p, false, false))
  })

  test('refuses a simulator outside the kept ones, by name or UDID, naming them all', () => {
    for (const request of ['iPhone 16', 'iPhone 17', 'Q', 'x', 'Nope']) {
      const choice = plan(request, [x, q])
      expect(choice.kind).toBe('unknown')
      const message = (choice as { message: string }).message
      expect(message).toContain('is not a kept simulator')
      for (const name of KEPT_SIMULATOR_NAMES) expect(message).toContain(`"${name}"`)
    }
  })

  test('refuses the UDID of a second simulator with a kept name, naming the one simgate uses', () => {
    expect(plan('y', [y])).toEqual({ kind: 'unknown', message: `y is a second "${duo}"; simgate uses only B. Pass "${duo}" or that UDID.` })
  })

  test('reports a kept device missing here, a kept device another session holds, and no kept iPhone', () => {
    const missing = planSessionDevice(duo, { available: [a, x], booted: [] }, none, none)
    expect(missing).toEqual({ kind: 'unknown', message: expect.stringContaining(`No simulator named "${duo}" exists here`) })
    expect(plan(ipadName, [p], new Set(['P']))).toEqual({ kind: 'claimed', devices: [p] })
    const iPadsOnly = planSessionDevice(undefined, { available: [p, q, x], booted: [p] }, none, none)
    expect(iPadsOnly).toEqual({ kind: 'unknown', message: expect.stringContaining('No kept iPhone simulator exists here') })
  })
})

describe('sessionShutdowns', () => {
  const before = { simulators: [iphone('A')], emulators: ['emulator-5554'] }
  const after = { simulators: [iphone('A'), iphone('B'), ipad('P')], emulators: ['emulator-5554', 'emulator-5556'] }

  test('shuts down what the session booted, except another live session’s device', () => {
    expect(sessionShutdowns(before, after, { keepSimulators: new Set(['B']), emulators: true })).toEqual({
      simulators: [ipad('P')],
      emulators: ['emulator-5556'],
    })
  })

  test('leaves emulators to slot 1, the only slot that runs Android', () => {
    expect(sessionShutdowns(before, after, { keepSimulators: new Set(), emulators: false })).toEqual({
      simulators: [iphone('B'), ipad('P')],
      emulators: [],
    })
  })
})
