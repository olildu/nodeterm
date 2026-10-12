import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'

/**
 * STRUCTURAL pins for the Simulator-node link (CLAUDE.md → Simulator node → Links). The behaviour
 * is proven where it is pure (canvas-link, context-link-map, sim/control.links, simDriving); these
 * pin the glue in the two big components that nothing else can reach.
 */
const canvas = readFileSync(new URL('./Canvas.tsx', import.meta.url), 'utf8')
const node = readFileSync(new URL('../nodes/SimulatorNode.tsx', import.meta.url), 'utf8')
const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\r\n/g, '\n')

describe('SimulatorNode link handles', () => {
  it('has the same link-out / link-in bridge handles as a terminal and a sticky', () => {
    expect(node).toMatch(/id="link-out"[\s\S]*?type="source"[\s\S]*?position=\{Position\.Right\}[\s\S]*?bridge-handle bridge-handle--out/)
    expect(node).toMatch(/id="link-in"[\s\S]*?type="target"[\s\S]*?position=\{Position\.Left\}[\s\S]*?bridge-handle bridge-handle--in/)
  })
  it('draws handles as siblings AFTER the root (a glass root would clip them)', () => {
    expect(node.indexOf('id="link-out"')).toBeGreaterThan(node.indexOf('sim-node__header'))
    expect(node.lastIndexOf('</div>')).toBeLessThan(node.indexOf('id="link-out"'))
  })
})

describe('Canvas sim links', () => {
  it('normalizes a sim link to device → agent regardless of drag direction', () => {
    expect(canvas).toMatch(/kind === 'sim' && te\.kind === 'simulator'/)
  })
  it('sends the discovery note only to an agent, idle-gated, and none for the auto-link', () => {
    expect(canvas).toMatch(/if \(kind === 'sim'\) \{[\s\S]*?state === 'working'\) return[\s\S]*?buildSimLinkNote/)
    // The auto-link path appends the bridge and never sends a note.
    const auto = canvas.slice(canvas.indexOf('const applySimAutoLink'), canvas.indexOf('const applySimAutoLinkRef'))
    expect(auto).not.toMatch(/sendText|buildSimLinkNote/)
    expect(auto).toMatch(/liveCanvasHolds/)
    expect(auto).toMatch(/appendCanvasLinks/)
  })
  it('gives a sim link no direction menu (a device cannot read)', () => {
    expect(canvas).toMatch(/t === 'sticky' \|\| t === 'simulator'/)
  })
  it('anchors sim edges on the link handles like every link (data.anchor horizontal)', () => {
    const block = canvas.slice(canvas.indexOf("const decorated = linkEdges"), canvas.indexOf('const ropeCoversLink'))
    expect(block).toMatch(/data: \{ anchor: 'horizontal' \}/)
  })
  it('the driving look is bounded: it keys off a store entry that lapses, never a bare animated flag', () => {
    const block = canvas.slice(canvas.indexOf("const decorated = linkEdges"), canvas.indexOf('const ropeCoversLink'))
    expect(block).toMatch(/const driven = isSim && drivenSims\.has\(/)
    // A finite CSS animation on `.sim-driven`, never React Flow's infinite `animated`.
    expect(block).toMatch(/\.\.\.\(driven \? \{ className: 'sim-driven' \} : \{\}\)/)
    expect(block).not.toMatch(/animated: true/)
    // …and a timer re-derives the edges when the last window lapses.
    expect(canvas).toMatch(/setTimeout\(bumpSimDriveTick, wait \+ 20\)/)
    expect(canvas).toMatch(/simDriveEntries, simDriveTick\]\)/)
  })
  it('reports a removed link from ONE diff of the link set, only when both nodes still exist', () => {
    expect(canvas).toMatch(/types\.has\(agent\) && types\.has\(sim\)\) window\.nodeTerminal\.sim\?\.linkRemoved/)
  })
})

describe('driving chip', () => {
  it('the node chip is styled and static (no animation of its own)', () => {
    const rule = css.slice(css.indexOf('.sim-node__driving {'), css.indexOf('.sim-node.collapsed .sim-node__header'))
    expect(rule).not.toMatch(/animation/)
  })
})
