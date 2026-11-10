// Test support (not a test file): every encoding of an X25519 point of order dividing 8 — libsodium's
// blocklist — each also with the top bit set (X25519 ignores that bit, so it is the same point). Used
// by e2ee.test.ts and the relay regression tests to prove each intake refuses ALL of them, not just 0.
export const LOW_ORDER_POINTS_HEX = [
  '0000000000000000000000000000000000000000000000000000000000000000', // 0
  '0100000000000000000000000000000000000000000000000000000000000000', // 1
  'e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800', // order 8
  '5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157', // order 8
  'ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // p - 1
  'edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f', // p (non-canonical 0)
  'eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f' // p + 1 (non-canonical 1)
]

export function lowOrderKeys(): Uint8Array[] {
  return LOW_ORDER_POINTS_HEX.flatMap((h) => {
    const plain = Uint8Array.from(Buffer.from(h, 'hex'))
    const high = Uint8Array.from(plain)
    high[31] |= 0x80
    return [plain, high]
  })
}

/** The same keys as canonical standard base64 (what a peer would put on the wire). */
export function lowOrderKeysB64(): string[] {
  return lowOrderKeys().map((k) => Buffer.from(k).toString('base64'))
}
