// The copy every SAS the desktop shows carries under it. One definition, so no surface can drift.
//
// The SAS is v2 (src/core/relay/e2ee.ts sasFromSharedKey): ten digits, "NNN NNN NNNN". The first six
// ARE the v1 code, so a peer still running an older desktop or phone build (which shows only six)
// is compared on those six. That comparison is weaker (~20 bits instead of ~33): the copy says
// why the other device shows fewer digits, so the human can tell "older version" from "mismatch".
export const SAS_COMPARE_HINT =
  'Compare all ten digits. If the other device shows only six, it runs an older version: compare the first six.'
