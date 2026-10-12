// @vitest-environment jsdom
//
// Under Liquid Glass these node roots carry a backdrop-filter (styles.css glass rules), and a
// backdrop-filter makes the element the containing block for its absolute descendants. A
// <NodeResizer> rendered INSIDE such a root therefore positioned its edges against the root
// instead of the React Flow node wrapper: the outer halves were clipped by the root's
// overflow:hidden and the right/bottom/left lines sat under the terminal's hover guard, so only
// the top edge (over the header) could be dragged. The resizer must be a sibling of the root —
// and AFTER it: focus mode reparents a terminal's root out of the node wrapper, and React
// inserting a sibling "before the root" while it is away throws NotFoundError (renderer crash).
// A real node render needs a React Flow store, a session and a pty, so the order is pinned in the
// source and the reparent hazard is reproduced with React and the same reparent primitive.
import { act, createElement as h, Fragment, useLayoutEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const read = (f: string): string =>
  fs.readFileSync(path.join(__dirname, f), 'utf8').replace(/\r\n/g, '\n')

// file -> the class its glass-filtered root opens with
const FILTERED_ROOTS: Record<string, string> = {
  'TerminalNode.tsx': 'term-node${',
  'EditorNode.tsx': 'term-node editor-node',
  'DiffNode.tsx': 'term-node editor-node',
  'BrowserNode.tsx': 'term-node browser-node',
  'VideoNode.tsx': 'term-node video-node',
  'WebNode.tsx': 'term-node web-node',
  'FilesNode.tsx': 'files-node${',
  'SimulatorNode.tsx': 'sim-node${',
  'LoopNode.tsx': 'loop-node',
  'SubagentNode.tsx': 'subagent-node',
  'TriggerNode.tsx': 'trigger-node',
  'DinoNode.tsx': 'dino-node'
}

/** Index of the root's closing tag: the last 4-space-indented `</div>` of the component's return. */
const rootClose = (src: string): number => src.lastIndexOf('\n    </div>\n')

/** Every `<NodeResizer …/>` tag in the file, with its offset. */
const resizers = (src: string): { at: number; tag: string }[] =>
  [...src.matchAll(/<NodeResizer\b[\s\S]*?\/>/g)].map((m) => ({ at: m.index!, tag: m[0] }))
/** The paint-only copy: a second NodeResizer whose controls carry `nt-resize-ghost`. */
const isPaintCopy = (tag: string): boolean =>
  /lineClassName="nt-resize-ghost"/.test(tag) && /handleClassName="nt-resize-ghost"/.test(tag)
const colorOf = (tag: string) => tag.match(/color=(\{[^}]*\}|"[^"]*")/)?.[1]

describe('NodeResizer sits outside, after, a backdrop-filtered node root', () => {
  it.each(Object.entries(FILTERED_ROOTS))('%s', (file, rootClass) => {
    const src = read(file)
    expect(src.indexOf(`className={\`${rootClass}`)).toBeGreaterThan(-1)
    const live = resizers(src).filter((r) => !isPaintCopy(r.tag))
    expect(live).toHaveLength(1)
    expect(live[0].at).toBeGreaterThan(rootClose(src))
  })

  it.each(Object.entries(FILTERED_ROOTS))('%s paints the old resize box from inside the root', (file, rootClass) => {
    const src = read(file)
    const root = src.indexOf(`className={\`${rootClass}`)
    const copies = resizers(src).filter((r) => isPaintCopy(r.tag))
    expect(copies).toHaveLength(1)
    expect(copies[0].at).toBeGreaterThan(root)
    expect(copies[0].at).toBeLessThan(rootClose(src))
    // the same colour expression as the live resizer, so it paints what the old one painted
    const live = resizers(src).find((r) => !isPaintCopy(r.tag))!
    expect(colorOf(copies[0].tag)).toBe(colorOf(live.tag))
  })

  it('the terminal link dots sit outside, after, the root too', () => {
    const src = read('TerminalNode.tsx')
    for (const id of ['id="link-out"', 'id="link-in"']) expect(src.indexOf(id)).toBeGreaterThan(rootClose(src))
  })
})

describe('the moved resizer paints above the root it now follows', () => {
  const css = read('../styles.css')
  const z = (sel: string): number => {
    const i = css.indexOf(`${sel} {`)
    return Number(css.slice(i, css.indexOf('}', i)).match(/z-index:\s*(\d+)/)?.[1])
  }
  it('is above the root and the terminal hover guard (z 2), below the kanban half-pill', () => {
    expect(z('.react-flow__node > .react-flow__resize-control')).toBeGreaterThan(2)
    expect(z('.kanban-node-pill')).toBeGreaterThan(z('.react-flow__node > .react-flow__resize-control'))
  })
})

describe('focus mode reparenting', () => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const Control = ({ visible }: { visible: boolean }) => (visible ? h('div', { className: 'ctl' }) : null)
  // The TerminalNode shape: a root moved into the focus surface by a layout effect (whose cleanup
  // appends it back), and a resize control whose visibility flips with focus and selection.
  const Node = ({ focused, after }: { focused: boolean; after: boolean }) => {
    const ref = useRef<HTMLDivElement>(null)
    useLayoutEffect(() => {
      if (!focused) return
      const root = ref.current!
      const home = root.parentElement!
      document.getElementById('surface')!.appendChild(root)
      return () => void home.appendChild(root)
    }, [focused])
    const ctl = h(Control, { key: 'c', visible: !focused })
    const root = h('div', { key: 'r', ref, className: 'root' })
    return h(Fragment, null, after ? [root, ctl] : [ctl, root])
  }
  const run = (after: boolean): unknown => {
    document.body.innerHTML = '<div id="wrap"></div><div id="surface"></div>'
    const r = createRoot(document.getElementById('wrap')!)
    act(() => r.render(h(Node, { focused: false, after })))
    act(() => r.render(h(Node, { focused: true, after })))
    try {
      act(() => r.render(h(Node, { focused: false, after })))
      return null
    } catch (e) {
      return e
    } finally {
      try {
        act(() => r.unmount())
      } catch {
        /* the broken tree may not unmount cleanly; the throw above is the finding */
      }
    }
  }

  it('a control rendered AFTER the root survives exiting focus mode while selected', () => {
    expect(run(true)).toBeNull()
    expect(document.querySelectorAll('.ctl').length).toBe(0) // unmounted cleanly
  })

  it('negative control: rendered BEFORE the root, the same exit throws', () => {
    expect((run(false) as Error | null)?.name).toBe('NotFoundError')
  })
})
