/** `simgate status`: who holds each slot and simulator, and which builds are recorded. */
import { readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

import { buildRecordsDirectory, parseBuildRecord } from './builds'
import { describeOwner, isOwnerAlive, readLockOwner } from './lock'
import { SLOT_COUNT, slotLockPath, slotPort } from './slots'

const readDirectory = (path: string) => {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

export const statusReport = (basePath: string, basePort: number, nowMs = Date.now()) => {
  const lines: string[] = []
  for (let slot = 1; slot <= SLOT_COUNT; slot += 1) {
    const owner = readLockOwner(slotLockPath(basePath, slot))
    const state = owner === undefined ? 'free' : isOwnerAlive(owner) ? describeOwner(owner, nowMs) : `stale (${describeOwner(owner, nowMs)})`
    lines.push(`slot ${slot} (port ${slotPort(basePort, slot)}): ${state}`)
  }
  const records = buildRecordsDirectory(basePath)
  const builds = readDirectory(records).filter((name) => name.endsWith('.json'))
  lines.push(builds.length === 0 ? 'builds: none recorded' : 'builds:')
  for (const name of builds) {
    let record
    try {
      record = parseBuildRecord(readFileSync(join(records, name), 'utf8'))
    } catch {
      record = undefined
    }
    if (record !== undefined) {
      lines.push(`  ${record.udid} ${record.bundleId} fingerprint ${record.fingerprint.slice(0, 12)} from ${record.worktree}`)
    }
  }
  lines.push(`locks: ${dirname(basePath)} (${basename(basePath)})`)
  return lines.join('\n')
}
