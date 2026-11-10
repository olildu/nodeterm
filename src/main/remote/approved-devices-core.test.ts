import { describe, it, expect } from 'vitest'
import {
  emptyApprovedDevices,
  isPinned,
  parseApprovedDevices,
  pinDevice,
  unpinDevice
} from './approved-devices-core'
import { lowOrderKeysB64 } from '../../core/relay/low-order-keys.test-support'

describe('approved-devices-core', () => {
  describe('parseApprovedDevices', () => {
    it('returns empty for missing / malformed input', () => {
      expect(parseApprovedDevices(undefined)).toEqual({ pubkeys: [] })
      expect(parseApprovedDevices(null)).toEqual({ pubkeys: [] })
      expect(parseApprovedDevices(42)).toEqual({ pubkeys: [] })
      expect(parseApprovedDevices({})).toEqual({ pubkeys: [] })
      expect(parseApprovedDevices({ pubkeys: 'nope' })).toEqual({ pubkeys: [] })
    })

    it('keeps non-empty string entries and drops junk, de-duping in order', () => {
      expect(
        parseApprovedDevices({ pubkeys: ['a', '', 'b', 42, 'a', null, 'c'] })
      ).toEqual({ pubkeys: ['a', 'b', 'c'] })
    })
  })

  describe('isPinned', () => {
    it('matches an exact pinned key and rejects empty / unknown', () => {
      const store = { pubkeys: ['keyA', 'keyB'] }
      expect(isPinned(store, 'keyA')).toBe(true)
      expect(isPinned(store, 'keyB')).toBe(true)
      expect(isPinned(store, 'keyC')).toBe(false)
      expect(isPinned(store, '')).toBe(false)
      expect(isPinned(emptyApprovedDevices(), 'keyA')).toBe(false)
    })
  })

  describe('pinDevice', () => {
    it('appends a new key', () => {
      expect(pinDevice({ pubkeys: ['a'] }, 'b')).toEqual({ pubkeys: ['a', 'b'] })
    })

    it('is idempotent and returns the same object when already pinned', () => {
      const store = { pubkeys: ['a'] }
      expect(pinDevice(store, 'a')).toBe(store)
    })

    it('ignores an empty key', () => {
      const store = { pubkeys: ['a'] }
      expect(pinDevice(store, '')).toBe(store)
    })
  })

  describe('unpinDevice', () => {
    it('removes a pinned key and is a no-op otherwise', () => {
      expect(unpinDevice({ pubkeys: ['a', 'b'] }, 'a')).toEqual({ pubkeys: ['b'] })
      const store = { pubkeys: ['a'] }
      expect(unpinDevice(store, 'zzz')).toBe(store)
    })
  })

  describe('low-order keys (a public-constant shared secret: no device holds one)', () => {
    it('are never pinned, and never count as pinned even when the file holds one', () => {
      for (const weak of lowOrderKeysB64()) {
        expect(pinDevice(emptyApprovedDevices(), weak), weak).toEqual({ pubkeys: [] })
        expect(isPinned({ pubkeys: [weak] }, weak), weak).toBe(false)
        // Another spelling Node decodes to the same key is refused too.
        expect(isPinned({ pubkeys: ['!' + weak] }, '!' + weak)).toBe(false)
      }
    })
  })
})
