// Where a whiteboard is written is decided by a dep each shell wires into `registerFsHandlers`
// (`whiteboardLocation`). It is optional in core — without it a board falls back to
// `localProjectCwd` — so dropping one shell's wire compiles, passes every unit test, and silently
// sends a folder project kept in app data (issue #1145) to the app's shared board folder on that
// shell, where two projects holding the same committed canvas share boards by node id. Pinned at
// source level in BOTH shells, the remedy this repo uses for that class of hole
// (relay-attach-wiring.test.ts).
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8').replace(/\r\n/g, '\n')
const WIRE = /whiteboardLocation: \(projectId: string\) => workspaceStore\.whiteboardLocationForProject\(projectId\)/

describe('the whiteboard location is wired in both shells', () => {
  it('the desktop', () => {
    expect(read('main/index.ts')).toMatch(WIRE)
  })
  it('the Server Edition, and its handler registrar forwards it', () => {
    expect(read('server/index.ts')).toMatch(WIRE)
    expect(read('server/handlers/index.ts')).toMatch(/whiteboardLocation: deps\.whiteboardLocation/)
  })
})
