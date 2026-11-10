// Type surface of patch-smart-whisper.mjs for the vitest suite (smart-whisper-patch.test.ts); the
// script itself stays plain .mjs because postinstall runs it before anything is built.
export declare const PATCH_MARKER: string
export declare const VARIANT_TARGET: string
export declare const SIMD_FLAGS: readonly string[]
export declare const CTX_PARAMS_MARKER: string
export declare function patchSmartWhisper(dir: string): 'patched' | 'already-patched'
export declare const METAL_MARKER: string
