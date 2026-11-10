// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogApi, LogRecord } from '@shared/types'
import { LogPanel } from './LogPanel'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const record = (seq: number, msg: string, level: LogRecord['level'] = 'info', tag = 'pty'): LogRecord => ({
  seq,
  ts: Date.UTC(2026, 9, 18, 12, 0, seq),
  level,
  tag,
  msg
})

let host: HTMLDivElement
let root: Root
let push: ((batch: LogRecord[]) => void) | null
let unsubscribed: number
let logs: LogApi

beforeEach(() => {
  push = null
  unsubscribed = 0
  logs = {
    snapshot: vi.fn(async () => [record(1, 'booted'), record(2, 'socket refused', 'warn', 'relay')]),
    clear: vi.fn(),
    onBatch: (cb) => {
      push = cb
      return () => {
        unsubscribed++
      }
    }
  }
  ;(window as unknown as { nodeTerminal: { logs: LogApi } }).nodeTerminal = { logs }
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const rows = (): string[] =>
  [...document.querySelectorAll('.logpanel__msg')].map((el) => el.textContent ?? '')

async function mount(onClose = vi.fn()): Promise<typeof onClose> {
  await act(async () => {
    root.render(<LogPanel onClose={onClose} />)
  })
  return onClose
}

describe('LogPanel', () => {
  it('fills from the snapshot, then appends pushed batches without duplicating the overlap', async () => {
    await mount()
    expect(rows()).toEqual(['booted', 'socket refused'])

    await act(async () => {
      push?.([record(2, 'socket refused', 'warn', 'relay'), record(3, 'reattached')])
    })
    expect(rows()).toEqual(['booted', 'socket refused', 'reattached'])
  })

  it('filters by level and by text', async () => {
    await mount()
    const chip = [...document.querySelectorAll('.logpanel__chip')].find((el) => el.textContent === 'info')
    await act(async () => {
      ;(chip as HTMLButtonElement).click()
    })
    expect(rows()).toEqual(['socket refused'])
  })

  it('Escape and the close button both close it, and unmount unsubscribes', async () => {
    const onClose = await mount()
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(onClose).toHaveBeenCalledTimes(1)
    act(() => {
      ;(document.querySelector('.drawer__close') as HTMLButtonElement).click()
    })
    expect(onClose).toHaveBeenCalledTimes(2)

    act(() => root.unmount())
    expect(unsubscribed).toBe(1)
    root = createRoot(host) // afterEach unmounts again
  })

  it('Clear empties the ring and the view', async () => {
    await mount()
    const clear = [...document.querySelectorAll('.logpanel__act')].find((el) => el.textContent === 'Clear')
    await act(async () => {
      ;(clear as HTMLButtonElement).click()
    })
    expect(logs.clear).toHaveBeenCalledTimes(1)
    expect(rows()).toEqual([])
    expect(document.querySelector('.logpanel__empty')?.textContent).toContain('Nothing captured yet')
  })
})
