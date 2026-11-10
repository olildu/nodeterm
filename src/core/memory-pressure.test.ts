import { describe, it, expect, vi } from 'vitest'
import {
  createMemoryPressureMonitor,
  hostMemReader,
  kernelPressureReader,
  parseKernelPressureLevel,
  KERNEL_LEVER_GAP_MS,
  RE_FIRE_FLOOR_MS,
  type KernelLevelExec,
  type KernelPressureLevel
} from './memory-pressure'
import { readMemInfo } from './session-budget'

const mem = (availableMb: number, totalMb = 16000) => () => ({ availableMb, totalMb })

describe('memory pressure monitor', () => {
  it('classifies warning below 10% available and critical below 5%', () => {
    const on = vi.fn()
    const m = createMemoryPressureMonitor({ readMem: mem(1500), selfRssMb: () => 500, onPressure: on })
    expect(m.check()).toBe('warning')
    const c = createMemoryPressureMonitor({ readMem: mem(700), selfRssMb: () => 500, onPressure: on })
    expect(c.check()).toBe('critical')
  })
  it('a failed mem read is never pressure', () => {
    const m = createMemoryPressureMonitor({ readMem: () => null, selfRssMb: () => 500, onPressure: vi.fn() })
    expect(m.check()).toBeNull()
  })
  it('self-RSS still counts when the host read fails', () => {
    const m = createMemoryPressureMonitor({ readMem: () => null, selfRssMb: () => 9000, onPressure: vi.fn() })
    expect(m.check()).toBe('critical')
  })
  it('self-RSS thresholds fire independently of host memory', () => {
    const m = createMemoryPressureMonitor({ readMem: mem(8000), selfRssMb: () => 5000, onPressure: vi.fn() })
    expect(m.check()).toBe('warning')
    const c = createMemoryPressureMonitor({ readMem: mem(8000), selfRssMb: () => 9000, onPressure: vi.fn() })
    expect(c.check()).toBe('critical')
  })
  it('re-fires a severity at most once per 60s (floor)', () => {
    vi.useFakeTimers()
    const on = vi.fn()
    const m = createMemoryPressureMonitor({ readMem: mem(1500), selfRssMb: () => 0, intervalMs: 1000, onPressure: on })
    m.start()
    vi.advanceTimersByTime(3500)
    expect(on).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(on).toHaveBeenCalledTimes(2)
    m.stop()
    vi.useRealTimers()
  })
  it('stop() ends the sweeps for good', () => {
    vi.useFakeTimers()
    const on = vi.fn()
    const m = createMemoryPressureMonitor({ readMem: mem(700), selfRssMb: () => 0, intervalMs: 1000, onPressure: on })
    m.start()
    vi.advanceTimersByTime(1000)
    expect(on).toHaveBeenCalledTimes(1)
    m.stop()
    vi.advanceTimersByTime(600_000)
    expect(on).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })
  it('the default host reader is SILENT on darwin (os.freemem there is vm_stat free_count)', () => {
    const read = hostMemReader('darwin')
    expect(read()).toBeNull()
    // Host leg silent → a healthy Mac is never classified from "free" memory…
    const quiet = createMemoryPressureMonitor({ readMem: read, selfRssMb: () => 500, onPressure: vi.fn() })
    expect(quiet.check()).toBeNull()
    // …but the self-RSS leg still carries the monitor on its own.
    const loud = createMemoryPressureMonitor({ readMem: read, selfRssMb: () => 9000, onPressure: vi.fn() })
    expect(loud.check()).toBe('critical')
  })
  it('the default host reader is the real one everywhere else', () => {
    expect(hostMemReader('linux')).toBe(readMemInfo)
    expect(hostMemReader('win32')).toBe(readMemInfo)
  })
  it('a throwing consumer does not break the monitor', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const m = createMemoryPressureMonitor({
      readMem: mem(700),
      selfRssMb: () => 0,
      intervalMs: 1000,
      onPressure: () => {
        calls++
        throw new Error('destroyed window')
      }
    })
    m.start()
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    vi.advanceTimersByTime(61_000)
    expect(calls).toBe(2) // still firing after the throw
    m.stop()
    warn.mockRestore()
    vi.useRealTimers()
  })
})

describe('memory pressure monitor: darwin kernel-level leg', () => {
  /** A scripted kernel reader: each tick consumes the next level; the last one is held. */
  const script = (levels: (KernelPressureLevel | null)[]) => {
    let i = 0
    return (): KernelPressureLevel | null => levels[Math.min(i++, levels.length - 1)]
  }
  // Host + self legs quiet, so every fire below is the kernel leg's.
  const quiet = { readMem: () => null, selfRssMb: () => 100, intervalMs: 1000, log: () => {} }

  it('parses the sysctl integers and nothing else', () => {
    expect(parseKernelPressureLevel('1\n')).toBe('normal')
    expect(parseKernelPressureLevel('2')).toBe('warn')
    expect(parseKernelPressureLevel(' 4 \n')).toBe('critical')
    for (const junk of ['0', '3', '', 'error', '12']) expect(parseKernelPressureLevel(junk)).toBeNull()
  })

  it('fires once per ESCALATION, never on a held or falling level', () => {
    vi.useFakeTimers()
    const onKernel = vi.fn()
    const onPressure = vi.fn()
    // The extra tick primed at start() consumes the first entry. The second normal -> warn lands
    // seconds after the critical run, inside the gap and below its severity, so it runs nothing.
    const m = createMemoryPressureMonitor({
      ...quiet,
      onPressure,
      readKernelLevel: script(['normal', 'normal', 'warn', 'warn', 'critical', 'warn', 'normal', 'warn']),
      onKernelPressure: onKernel
    })
    m.start()
    vi.advanceTimersByTime(7000)
    expect(onKernel.mock.calls).toEqual([['warning'], ['critical']])
    expect(onPressure).not.toHaveBeenCalled()
    m.stop()
    vi.useRealTimers()
  })

  it('a level flapping normal/warn every tick runs the levers once per gap (#179: no timed release)', () => {
    vi.useFakeTimers()
    const onKernel = vi.fn()
    let tick = 0
    const m = createMemoryPressureMonitor({
      ...quiet,
      intervalMs: 30_000,
      onPressure: vi.fn(),
      // start() primes with 'normal'; every tick after it alternates warn, normal, warn, …
      readKernelLevel: () => (tick++ % 2 === 1 ? 'warn' : 'normal'),
      onKernelPressure: onKernel
    })
    m.start()
    vi.advanceTimersByTime(10 * 60_000)
    expect(onKernel).toHaveBeenCalledTimes(1)
    // The gap bounds the rate; it does not switch the leg off. Past it, the next escalation runs.
    vi.advanceTimersByTime(KERNEL_LEVER_GAP_MS)
    expect(onKernel).toHaveBeenCalledTimes(2)
    m.stop()
    vi.useRealTimers()
  })

  it('an escalation ABOVE the last run fires at once, even inside the gap', () => {
    vi.useFakeTimers()
    const onKernel = vi.fn()
    const m = createMemoryPressureMonitor({
      ...quiet,
      intervalMs: 30_000,
      onPressure: vi.fn(),
      readKernelLevel: script(['normal', 'warn', 'normal', 'warn', 'normal', 'critical', 'normal', 'critical']),
      onKernelPressure: onKernel
    })
    m.start()
    vi.advanceTimersByTime(7 * 30_000)
    // warn runs; the second warn is inside the gap; critical outranks the last run (warning) and
    // fires; the second critical is inside the gap at the same severity.
    expect(onKernel.mock.calls).toEqual([['warning'], ['critical']])
    m.stop()
    vi.useRealTimers()
  })

  it('a HELD warn stays one lever run past the 60 s re-fire floor (#179: no timed release)', () => {
    vi.useFakeTimers()
    const onKernel = vi.fn()
    const m = createMemoryPressureMonitor({ ...quiet, onPressure: vi.fn(), readKernelLevel: () => 'warn', onKernelPressure: onKernel })
    m.start()
    vi.advanceTimersByTime(RE_FIRE_FLOOR_MS * 10)
    expect(onKernel).toHaveBeenCalledTimes(1)
    expect(m.kernelLevel()).toBe('warn')
    m.stop()
    vi.useRealTimers()
  })

  it('a failed read neither fires nor resets the held level', () => {
    vi.useFakeTimers()
    const onKernel = vi.fn()
    const m = createMemoryPressureMonitor({
      ...quiet,
      onPressure: vi.fn(),
      readKernelLevel: script([null, 'warn', null, null, 'warn']),
      onKernelPressure: onKernel
    })
    m.start()
    vi.advanceTimersByTime(5000)
    expect(onKernel).toHaveBeenCalledTimes(1)
    m.stop()
    vi.useRealTimers()
  })

  it('a launch into an already-pressured machine fires on the first tick; a healthy one stays silent', () => {
    vi.useFakeTimers()
    const hot = vi.fn()
    const cold = vi.fn()
    const a = createMemoryPressureMonitor({ ...quiet, onPressure: vi.fn(), readKernelLevel: () => 'critical', onKernelPressure: hot })
    const b = createMemoryPressureMonitor({ ...quiet, onPressure: vi.fn(), readKernelLevel: () => 'normal', onKernelPressure: cold })
    a.start()
    b.start()
    vi.advanceTimersByTime(1000)
    expect(hot.mock.calls).toEqual([['critical']])
    vi.advanceTimersByTime(600_000)
    expect(cold).not.toHaveBeenCalled()
    a.stop()
    b.stop()
    vi.useRealTimers()
  })

  it('never reaches onPressure, so a kernel CRITICAL cannot trigger the shells\' reaper sweep', () => {
    vi.useFakeTimers()
    const onPressure = vi.fn()
    const m = createMemoryPressureMonitor({ ...quiet, onPressure, readKernelLevel: () => 'critical', onKernelPressure: vi.fn() })
    m.start()
    vi.advanceTimersByTime(120_000)
    expect(onPressure).not.toHaveBeenCalled()
    // …and the byte/self classification is untouched by it.
    expect(m.check()).toBeNull()
    m.stop()
    vi.useRealTimers()
  })

  it('runs beside the watermark leg without either suppressing the other', () => {
    vi.useFakeTimers()
    const onPressure = vi.fn()
    const onKernel = vi.fn()
    const m = createMemoryPressureMonitor({
      ...quiet,
      selfRssMb: () => 9000,
      onPressure,
      readKernelLevel: () => 'warn',
      onKernelPressure: onKernel
    })
    m.start()
    vi.advanceTimersByTime(1000)
    expect(onPressure.mock.calls).toEqual([['critical']])
    expect(onKernel.mock.calls).toEqual([['warning']])
    m.stop()
    vi.useRealTimers()
  })

  it('logs every transition (falls included) and every lever run', () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const m = createMemoryPressureMonitor({
      ...quiet,
      log,
      onPressure: vi.fn(),
      readKernelLevel: script(['normal', 'warn', 'normal']),
      onKernelPressure: vi.fn()
    })
    m.start()
    vi.advanceTimersByTime(3000)
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      '[memory-pressure] kernel level normal -> warn',
      '[memory-pressure] kernel warn: running reclaim levers (warning)',
      '[memory-pressure] kernel level warn -> normal'
    ])
    m.stop()
    vi.useRealTimers()
  })

  it('a throwing kernel consumer does not break the monitor', () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const m = createMemoryPressureMonitor({
      ...quiet,
      onPressure: vi.fn(),
      readKernelLevel: script(['normal', 'warn', 'normal', 'critical']),
      onKernelPressure: () => {
        calls++
        throw new Error('destroyed window')
      }
    })
    m.start()
    expect(() => vi.advanceTimersByTime(3000)).not.toThrow()
    expect(calls).toBe(2)
    m.stop()
    warn.mockRestore()
    vi.useRealTimers()
  })

  it('the leg is off without an onKernelPressure consumer (the Server Edition passes none)', () => {
    vi.useFakeTimers()
    const read = vi.fn((): KernelPressureLevel => 'critical')
    const m = createMemoryPressureMonitor({ ...quiet, onPressure: vi.fn(), readKernelLevel: read })
    m.start()
    vi.advanceTimersByTime(5000)
    expect(read).not.toHaveBeenCalled()
    m.stop()
    vi.useRealTimers()
  })

  describe('kernelPressureReader', () => {
    it('is absent off darwin', () => {
      expect(kernelPressureReader('linux')).toBeNull()
      expect(kernelPressureReader('win32')).toBeNull()
    })
    it('returns the last LANDED reading and keeps one read in flight at most', () => {
      const pending: ((err: Error | null, out: string) => void)[] = []
      const exec: KernelLevelExec = (cb) => void pending.push(cb)
      const read = kernelPressureReader('darwin', exec)!
      expect(read()).toBeNull() // nothing landed yet
      expect(read()).toBeNull()
      expect(pending).toHaveLength(1) // second call did not spawn a second sysctl
      pending.shift()!(null, '2\n')
      expect(read()).toBe('warn')
      pending.shift()!(new Error('timeout'), '')
      expect(read()).toBeNull() // a failed read is no information, not a level
    })
    it('a spawn that throws synchronously is a failed read', () => {
      const read = kernelPressureReader('darwin', () => {
        throw new Error('EAGAIN')
      })!
      expect(read()).toBeNull()
      expect(read()).toBeNull()
    })
    // darwin only: kern.memorystatus_vm_pressure_level exists nowhere else.
    it.skipIf(process.platform !== 'darwin')(
      'reads the real sysctl on macOS (read-only; asserts a parsed level, not which one)',
      async () => {
        const read = kernelPressureReader('darwin')!
        let level = read()
        for (let i = 0; i < 40 && level === null; i++) {
          await new Promise((r) => setTimeout(r, 50))
          level = read()
        }
        // Every supported macOS has this sysctl; null here means the parse or the argv is wrong.
        expect(['normal', 'warn', 'critical']).toContain(level)
      }
    )
  })
})
