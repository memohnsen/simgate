import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  buildRecordsDirectory,
  devicesWithCurrentBuild,
  hasBuildRecords,
  installIdentity,
  isCurrentBuild,
  nativeFingerprint,
  parseCommandFingerprint,
  parseExpoFingerprint,
  parseBuildRecord,
  readBuildRecord,
  writeBuildRecord,
  type BuildRecord,
} from '../src/builds'

const UDID = 'AAAAAAAA-0000-4000-8000-000000000001'
const APP_ID = 'com.example.app'
let directory: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'simulator-builds-'))
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

const record = (overrides: Partial<BuildRecord> = {}): BuildRecord => ({
  udid: UDID,
  bundleId: APP_ID,
  fingerprint: 'native-1',
  install: 'container/Atlas.app@1',
  worktree: '/work/a',
  recordedAtMs: 1,
  ...overrides,
})

test('keeps the records beside the simulator lock', () => {
  expect(buildRecordsDirectory('/c/metro/simulator.lock')).toBe('/c/metro/simulator-builds')
})

describe('records', () => {
  test('round-trip through the directory, one per device', () => {
    expect(hasBuildRecords(directory, APP_ID)).toBe(false)
    expect(readBuildRecord(directory, UDID, APP_ID)).toBeUndefined()
    writeBuildRecord(directory, record())
    expect(hasBuildRecords(directory, APP_ID)).toBe(true)
    expect(hasBuildRecords(directory, 'com.other.app')).toBe(false)
    expect(readBuildRecord(directory, UDID, APP_ID)).toEqual(record())
    expect(readBuildRecord(directory, UDID, 'com.other.app')).toBeUndefined()
  })

  test('refuse a UDID that could escape the directory', () => {
    expect(() => writeBuildRecord(directory, record({ udid: '../escape' }))).toThrow('Not a simulator UDID')
    expect(readBuildRecord(directory, '../escape', APP_ID)).toBeUndefined()
  })

  test('read anything that is not a whole record as missing', () => {
    for (const bad of ['', 'nope', '[]', '{}', JSON.stringify({ ...record(), fingerprint: '' }), JSON.stringify({ ...record(), recordedAtMs: 'x' })]) {
      expect(parseBuildRecord(bad)).toBeUndefined()
    }
  })
})

describe('isCurrentBuild', () => {
  test('needs the recorded install still on the device and the same native fingerprint', () => {
    expect(isCurrentBuild(record(), 'native-1', 'container/Atlas.app@1')).toBe(true)
    // JavaScript-only changes keep the fingerprint, so another worktree's build still counts.
    expect(isCurrentBuild(record({ worktree: '/work/b' }), 'native-1', 'container/Atlas.app@1')).toBe(true)
    expect(isCurrentBuild(record(), 'native-2', 'container/Atlas.app@1')).toBe(false)
    expect(isCurrentBuild(record(), 'native-1', 'container/Atlas.app@2')).toBe(false)
    expect(isCurrentBuild(record(), 'native-1', undefined)).toBe(false)
    expect(isCurrentBuild(undefined, 'native-1', 'container/Atlas.app@1')).toBe(false)
  })
})

describe('installIdentity', () => {
  const install = (container: string, app: string, bundleId: string) => {
    const bundle = join(directory, UDID, 'data', 'Containers', 'Bundle', 'Application', container, app)
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(bundle, 'Info.plist'), bundleId)
    return join(bundle, 'Info.plist')
  }
  // The fake plist holds just the bundle ID; the real reader asks plutil.
  const readBundleId = (path: string) => readFileSync(path, 'utf8')
  const identity = (udid = UDID) => installIdentity(udid, APP_ID, { devicesRoot: directory, readBundleId })

  test('finds the app’s bundle among the device’s apps and changes when it is reinstalled', () => {
    expect(identity()).toBeUndefined()
    install('C1', 'Other.app', 'com.other.app')
    expect(identity()).toBeUndefined()
    const plist = install('C2', 'Atlas.app', APP_ID)
    const first = identity()
    expect(first).toBe(`C2/Atlas.app@${statSync(plist).mtimeMs}`)
    utimesSync(plist, new Date(), new Date(Date.now() + 60_000))
    expect(identity()).not.toBe(first)
  })

  test('reads nothing for a UDID that is not one', () => {
    expect(identity('../x')).toBeUndefined()
  })
})

describe('fingerprints', () => {
  test('takes Expo’s hash only when it loaded the app config', () => {
    const sources = [{ type: 'contents', id: 'expoConfig' }]
    expect(parseExpoFingerprint(JSON.stringify({ hash: 'abc', sources }))).toBe('abc')
    expect(parseExpoFingerprint(JSON.stringify({ hash: 'abc', sources: [{ type: 'file', filePath: 'x' }] }))).toBeUndefined()
    for (const bad of ['', 'nope', '{}', JSON.stringify({ hash: '', sources }), JSON.stringify({ hash: 'abc' })]) {
      expect(parseExpoFingerprint(bad)).toBeUndefined()
    }
  })

  test('takes a custom command’s output only when it is one short token', () => {
    expect(parseCommandFingerprint('  abc123\n')).toBe('abc123')
    for (const bad of ['', '  ', 'two words', 'x'.repeat(257)]) expect(parseCommandFingerprint(bad)).toBeUndefined()
  })

  test('has none for a directory that is not an Expo project, and runs a custom command there', async () => {
    expect(await nativeFingerprint(directory)).toBeUndefined()
    expect(await nativeFingerprint(directory, 'echo deadbeef')).toBe('deadbeef')
    expect(await nativeFingerprint(directory, 'exit 3')).toBeUndefined()
  })
})

describe('devicesWithCurrentBuild', () => {
  test('reads installed apps only on devices with a record of this fingerprint', () => {
    const OTHER = 'BBBBBBBB-0000-4000-8000-000000000002'
    const STALE = 'CCCCCCCC-0000-4000-8000-000000000003'
    writeBuildRecord(directory, record())
    writeBuildRecord(directory, record({ udid: STALE, fingerprint: 'native-old' }))
    const scanned: string[] = []
    const identity = (udid: string) => {
      scanned.push(udid)
      return 'container/Atlas.app@1'
    }
    expect(devicesWithCurrentBuild(directory, APP_ID, [UDID, OTHER, STALE], 'native-1', identity)).toEqual(new Set([UDID]))
    expect(scanned).toEqual([UDID])
  })
})
