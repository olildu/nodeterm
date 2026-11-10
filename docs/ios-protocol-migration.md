# iOS companion — relay protocol migration spec (Stage 4 / 4c)

**Status:** blueprint for the iOS-side rewrite. Nodeterm side is implemented on
`feat/relay-rpc-main`.
**Audience:** the Swift developer (or an iOS-side Claude session) rewriting
`~/projects/nodeterm-ios`'s wire layer. That repo is NOT in this checkout — this
document is the *only* contract; do not guess wire shapes, they are transcribed
byte-for-byte from the nodeterm source cited in each section.

> This is a design document. No Swift here, and nothing on the nodeterm side changes
> because of it except this file.

---

## Overview

Nodeterm's Stage 4 collapses **two** client↔core protocols into **one**.

- The **relay opcode dialect** the phone speaks today — `framing.ts` opcodes
  (`OP.Input`/`OP.Output`/`OP.Snapshot*`…), `snapshot.ts` three-stage screen
  reassembly, `host-service.ts`'s hand-rolled RPC vocabulary, `host-canvas-hub`'s
  `canvas:state` full-state mirror, `sanitizeClientMutation` — is **deleted**.
- It is replaced by the **Server Edition's WS-RPC** (`src/shared/rpc.ts`) tunneled
  verbatim inside the existing E2EE relay box.

The security envelope (NaCl box, per-session HKDF key, role byte, monotonic
anti-replay seq, out-of-band SAS) is **unchanged in shape** but gains two hardening
rules the iOS client must honour, and the trust model becomes **mutual** (both humans
compare the SAS; both confirm; both pin the peer key).

**Consequence:** the moment nodeterm deletes the opcode dialect, a phone that still
speaks it **cannot connect**. iOS must migrate to `rpc.ts`. In exchange the phone stops
being a bespoke terminal-only client and becomes a **first-class `CorePlatform`
client** — same surface a Server Edition browser gets: git, presence, agent status,
terminal co-attach.

**This must ship compatibly with a nodeterm-side change** (the standing phone host is
still wired to the old dialect — see "Desktop-side lockstep work"). Neither side works
alone.

---

## What changed and why

| Layer | Before (opcode dialect) | After (rpc.ts tunnel) |
|---|---|---|
| Relay entry | `wss://…/?token=<token>` | **unchanged** |
| E2EE handshake | `e2ee_hello → e2ee_ready → e2ee_auth → e2ee_authenticated` | **unchanged shape**, + "no re-key after ready" + peer-key pin |
| Traffic crypto | NaCl box under HKDF session key; sealed plaintext `[role][seq][tag]…` | **unchanged** |
| Inner payload tags | `0x01` RPC envelope, `0x02` binary terminal frame (`framing.ts`) | now `0x03` tunnel-text (rpc.ts JSON) + `0x04` tunnel-binary (`encodePtyData`). Tags `0x01`/`0x02` are legacy and no longer used by a migrated peer. |
| App protocol | `framing.ts` opcodes + `snapshot.ts` + `host-service` RPC verbs | `src/shared/rpc.ts`: `req`/`res`/`cast`/`ev` JSON frames + one binary pty frame |
| Trust | one-way pin-once (host approves phone) | **mutual SAS**: both confirm, both pin; confirm rides the encrypted tunnel |
| Feature surface | terminal I/O only | full `CorePlatform`: pty, git, fs, presence, agent status, canvas, co-attach |

Why now: the app is unpublished, so the dialect is deleted (not deprecated) — this is
the one moment that costs nothing. See `docs/remote-sessions.md`.

---

## 1. The tunnel protocol — `src/shared/rpc.ts`

Once the session is `ready`, every application message is a `rpc.ts` frame carried
inside the E2EE box (see §2 for the box). There are **four JSON frame types** and
**one binary frame type**.

### 1.1 JSON frames (carried as tunnel-text, tag `0x03`)

All JSON, UTF-8 encoded. Exact TypeScript shapes (`rpc.ts` lines 6–11):

```
RpcRequest  = { "t":"req",  "id": <number>, "method": <string>, "args": [ ... ], "undef"?: [<number>...] }
RpcCast     = { "t":"cast",                 "method": <string>, "args": [ ... ], "undef"?: [<number>...] }
RpcOk       = { "t":"res",  "id": <number>, "ok": true,  "result": <any> }
RpcErr      = { "t":"res",  "id": <number>, "ok": false, "error": { "code": <string>, "message": <string> } }
RpcEvent    = { "t":"ev",   "channel": <string>, "args": [ ... ], "undef"?: [<number>...] }
```

- **`req`** — a call expecting a reply. `id` is a client-chosen monotonic **number**
  (not a string). The core answers with a `res` bearing the same `id`.
- **`res`** — the reply. `ok:true` → `result` (any JSON; the core substitutes `null`
  for a handler that returned `undefined`). `ok:false` → `error {code, message}`.
- **`cast`** — one-way, no reply, no `id` (e.g. `pty:write`, `presence:cursor`).
- **`ev`** — a core→client event on a named `channel` (e.g. `presence:sync`,
  `pty:exit:<sid>`). The phone only ever *receives* `ev`; it never sends one.

**Error codes** the phone must recognise (`rpc.ts` 13–18):
`E_UNSUPPORTED`, `E_UNAUTHORIZED`, `E_NO_HANDLER`, and the client-synthesised
`E_DISCONNECTED` (the socket closed with a request in flight — iOS should synthesise
the same so an awaiting call fails instead of hanging forever). The host also emits
`E_HANDLER` (a handler threw).

**Response id semantics:** `id` correlates *within one connection*. Counters reset on
reconnect. Match a `res` strictly by `id`; drop an unmatched one.

### 1.2 The `undef` field — undefined vs null on the wire (READ THIS)

`JSON.stringify([a, undefined])` becomes `[a, null]`. Raw JSON has no `undefined`, so
an omitted trailing optional argument would arrive as an explicit `null` — and an
explicit `null` does **not** trigger a JS/TS default parameter. Several methods take a
**meaningful** `null` in a top-level slot, so the decoder cannot just guess `null →
undefined`. Examples where `null` is real and must survive:

- `pty.resize(sid, null, null)` — the co-attach **park** signal (drop me from the size
  ledger). Collapsing this to `undefined` shrinks every co-viewer's shared pty to 1×1.
- `presence.cursor/focus/chat/project(null)` — clear that state.

So the **sender** disambiguates out-of-band: `undef` is an array of the **top-level
argument indexes** that were `undefined`. Argument *values* are never inspected, so no
payload can forge the marker.

**iOS MUST implement both sides identically** or it will hit null-vs-undefined bugs:

**Encode (`encodeArgs`, rpc.ts 57–65):** walk `args`; for each slot that is your
language's "absent/undefined", push its index into `undef` and place `null` in the
array. Emit `undef` **only if non-empty**. Spread into the frame:
`{ "t":"req", "id":…, "method":…, "args":[…], "undef":[…] }`.

**Decode (`decodeArgs`, rpc.ts 68–77):** if `undef` is a non-empty array, copy `args`
and set each listed index back to your "absent" sentinel. **Guard the index**: ignore
any entry that is not an integer in `[0, args.length)` — a junk index must mark nothing
and must never lengthen the array (a hostile/buggy peer cannot invent a slot).

**Only top-level slots are marked.** A `null`/absent nested inside an object or array
is the sender's own data (`{cwd: null}` is not `{}`) — leave it exactly as JSON gives
it. Do not recurse.

For the phone this matters most on **outbound** casts/reqs where you omit a trailing
optional (e.g. `git.history(cwd)` with no `limit`), and on **inbound** events/results
where the core omitted one.

### 1.3 The binary pty-data frame — `encodePtyData` / `decodePtyData` (rpc.ts 117–141)

High-volume pty output is **not** JSON — it is one compact binary frame, carried as
tunnel-binary (tag `0x04`). Byte layout:

```
byte 0        : 0x01                      (PTY_DATA_FRAME magic)
byte 1        : (sidLen >> 8) & 0xff      (session-id length, uint16 BIG-endian, high byte)
byte 2        :  sidLen       & 0xff      (low byte)
bytes 3 .. 3+sidLen           : sessionId, UTF-8
bytes 3+sidLen .. end         : data,      UTF-8
```

- The magic byte is `0x01`. **Do not confuse it** with the sealed-plaintext tag byte
  (§2) — different layer. By the time you decode this frame you have already stripped
  the box header and the `0x04` tunnel-binary tag; byte 0 of what remains is `0x01`.
- `sidLen` is **big-endian** (note: the box seq in §2 is little-endian — do not mix
  them up).
- Decode rejects (returns null) if `buf.length < 3`, `buf[0] !== 0x01`, or
  `3 + sidLen > buf.length`.
- The `data` is raw terminal bytes decoded as UTF-8. This is the replacement for
  `OP.Output`.

**Direction:** the phone only ever **receives** pty-data binary frames (core → phone).
Phone → core input is a JSON `cast` (`pty:write`), never a binary frame — the host
ignores inbound binary tunnel frames (`relay-host.ts`: "pty input rides JSON casts").

---

## 2. E2EE handshake + tunnel framing over the relay — `src/main/remote/relay-socket.ts` (+ `e2ee.ts`)

The relay is a dumb byte-forwarder matched by a pairing token; it never decrypts. The
handshake and all traffic run host↔client *through* it.

### 2.0 Crypto primitives (`e2ee.ts`) — must match exactly

- **Box:** NaCl `box` = Curve25519 + XSalsa20-Poly1305 (`tweetnacl`; iOS: an
  interoperable NaCl / libsodium `crypto_box`). Wire format of one box is
  `nonce(24) ‖ ciphertext ‖ mac(16)` (`encrypt`, e2ee.ts 76–84): a **24-byte** random
  message nonce prepended to `box.after(plaintext, nonce, sharedKey)`. `decrypt`
  splits the first 24 bytes as nonce, opens the rest, returns null on a bad MAC.
- **baseKey (identity / SAS key):** `deriveSharedKey` = `nacl.box.before(theirPub,
  ourSecret)` (the ECDH precompute). Stable per device-pair. **Never used to encrypt
  traffic directly.**
- **sessionKey (traffic key):** `deriveSessionKey` =
  `HKDF-SHA256(ikm = baseKey, salt = hostNonce ‖ clientNonce, info =
  "nodeterm-relay-session-v2", length = 32)` (e2ee.ts 62–73). RFC 5869 HKDF; matches
  iOS CryptoKit `HKDF<SHA256>`. **Salt order is host nonce first, then client nonce,
  in both roles.**
- **Session nonces:** `randomSessionNonce` = **16** random bytes (distinct from the
  24-byte box nonce). Exchanged in the handshake, base64 in the control frames.

> Two different nonces exist. The **16-byte** session nonces feed the HKDF salt. The
> **24-byte** box nonce is fresh-random per encrypted message and lives at the front of
> every box. Do not conflate them.

### 2.1 Transport frame discrimination

On the relay WebSocket:
- a **text** frame = a plaintext handshake control JSON (`e2ee_hello` / `e2ee_ready`).
- a **binary** frame = an E2EE box.

The relay preserves text/binary-ness end to end. The client sends the token as a query
param on the wss URL: append `?token=<urlencoded token>` (`&` if the URL already has a
query). The token is **never** a data frame.

### 2.2 Handshake, step by step

Client knows the host's public key up front (from pairing); host learns the client's
from `e2ee_hello`.

**Step 1 — client → host, PLAINTEXT text frame:**
```json
{ "type": "e2ee_hello", "publicKeyB64": "<client box pubkey, base64>", "nonceB64": "<16-byte client nonce, base64>" }
```
Client has already computed `baseKey = ECDH(hostPub, clientSecret)`.

**Step 2 — host → client, PLAINTEXT text frame:**
```json
{ "type": "e2ee_ready", "nonceB64": "<16-byte host nonce, base64>" }
```
Host now computes `baseKey` from the client pubkey and
`sessionKey = HKDF(baseKey, salt = hostNonce ‖ clientNonce)`.

**Step 3 — client → host, ENCRYPTED box.** The client derives the same `sessionKey`
(salt = hostNonce ‖ clientNonce) and sends a box whose sealed plaintext is
`[role][seq][ tag 0x01 ][ {"type":"e2ee_auth"} ]` (see §2.3 for the header).
For MVP this is a bare authenticated marker — the relay already checked the token and
the offer pins the host key, so there is no extra secret to prove. Sealing it under the
session key (fresh nonces) stops a recorded auth box from an earlier session being
replayed.

**Step 4 — host → client, ENCRYPTED box:**
`[role][seq][ 0x01 ][ {"type":"e2ee_authenticated"} ]`.

Both sides set state `ready` and fire "onReady" once their side of the auth exchange
completes. **After this point every message is an E2EE box; no more plaintext control
frames are legitimate (§2.4).**

`nonceB64` decodes to exactly 16 bytes or the frame is dropped.

### 2.3 Sealed-frame format (the plaintext INSIDE every box)

Before sealing, the sender prepends a header (`relay-socket.ts` 250–265):

```
byte 0            : role     (host = 1, client = 2)   ← the SENDER's role
bytes 1 .. 9      : seq      (uint64, LITTLE-endian, split as two uint32 LE: low @1? see note)
bytes 9 .. end    : payload
```

Seq encoding detail (must match): `view.setUint32(1, floor(seq / 2^32), true)` then
`view.setUint32(5, seq >>> 0, true)` — i.e. **bytes 1..5 = high 32 bits LE, bytes 5..9
= low 32 bits LE**, each little-endian. Total header = **9 bytes** (`HEADER_BYTES = 1 +
8`).

The **payload** is itself tag-prefixed (`relay-socket.ts` 284–289): `[tag:1][body…]`.
Tags:

```
0x01  TAG_RPC          legacy peer RPC envelope (JSON)   — used only in the handshake now (e2ee_auth/authenticated) + keepalive
0x02  TAG_FRAME        legacy framing.ts binary frame     — NOT used by a migrated peer
0x03  TAG_TUNNEL_TEXT  a rpc.ts JSON frame (§1.1)          — the phone's main inbound/outbound text channel
0x04  TAG_TUNNEL_BIN   an encodePtyData frame (§1.3)       — the phone's inbound pty-output channel
```

So a full outbound application message is:
`box( [role][seq]  +  [0x03]  +  utf8(JSON rpc frame) )` for text, or
`box( [role][seq]  +  [0x04]  +  encodePtyData(...) )` for binary.

**Receiver checks, in order (`relay-socket.ts` 318–347), all mandatory on iOS:**
1. Decrypt the box under `sessionKey`; drop if it fails or is shorter than the 9-byte
   header.
2. **Role check:** the header role byte must equal the **peer's** role, not your own. A
   box tagged with your own role is a relay *reflection* — drop it. (host accepts
   role 2, client accepts role 1.)
3. **Anti-replay:** read the seq; it must be **strictly greater** than the last
   accepted inbound seq (`recvSeq`, initialised to −1). Drop any seq `<= recvSeq`. This
   defeats replay and reorder. Counters reset per (re)connection.
4. Strip the 9-byte header; dispatch by the payload tag byte.

Your **outbound** seq starts at 0 and increments by 1 per box you send (each direction
has its own counter).

### 2.4 SECURITY — no mid-session re-key, pin the peer key

This is a security fix iOS **must** honour (`relay-socket.ts` `handleControl`, 350–398,
and the SECURITY block):

- **Once the session is `ready`, a plaintext handshake control frame (`e2ee_hello` /
  `e2ee_ready`) MUST be ignored — never re-processed.** Re-processing one would let a
  relay MITM **re-key a live session** under its own keypair (re-deriving
  base/session keys, overwriting the peer pubkey) and then forge the peer's encrypted
  `trust:confirm` under the swapped key — degrading mutual approval to one-way. The
  real peer never re-sends a hello on an established session. **Drop it without
  re-keying and without closing the socket** (the relay already controls the transport;
  closing gives a MITM a trivial teardown and adds no protection). iOS must implement
  the same "frozen after ready" rule.
- **Pin the peer's box public key for the session.** For the phone (client role) the
  host key is known up front (from pairing) and is the pinned identity; treat any
  divergence as an attack. The nodeterm host additionally re-asserts, on every tunnel
  frame, that the socket's live peer key still equals the key bound at handshake, and
  cuts the session on a mismatch (`relay-host.ts` `peerKeyIntact`). iOS's equivalent:
  the host key you derived `baseKey`/SAS from is the only key this session may use;
  never accept a re-keyed session.

### 2.5 Keepalive

The host sends a keepalive every ~25 s as an encrypted `0x01`-tagged JSON
`{"kind":"keepalive"}`; the receiver ignores it. iOS may send one too (optional) but
must silently ignore an inbound keepalive. (This is the legacy TAG_RPC envelope, still
used only for keepalive + the two handshake auth markers.)

---

## 3. Mutual approval — the trust handshake (`relay-trust.ts` + `mutual-approval-core.ts` + `docs/remote-sessions.md`)

Stage 4 makes the phone a **peer**, and a pairing **grants shell access** on the host
machine. The only thing between a relay MITM and that shell is **mutual SAS approval**:
BOTH humans compare the same 6-digit code out of band, and BOTH press Confirm.

### 3.1 The SAS (v2: 10 digits) — `sasFromSharedKey` (e2ee.ts)

Both ends derive the identical code from `baseKey` (the ECDH shared secret, i.e. NaCl
`box.before` = HSalsa20(X25519) — **not** the session key):

```
h    = SHA-512(baseKey)                                   // nacl.hash
a    = BE_u32(h[0..4]) mod 1_000_000                      // the v1 code
b    = BE_u32(h[4..8]) mod 10_000                         // four more digits
SAS  = pad6(a)[0..3] + " " + pad6(a)[3..6] + " " + pad4(b)   // e.g. "123 456 7890"
```

`BE_u32(x)` = the four bytes read **big-endian, unsigned**. The first seven characters are
exactly the v1 code (`"NNN NNN"`, ~20 bits), so a peer on an older build that still shows six
digits can be compared on the first six. v1 alone was grindable: an attacker who substitutes a
pinned key (a tampered offer, join code or QR) matched both legs in seconds; v2 is ~33 bits.

Every surface that shows the SAS shows, under it, exactly: *"Compare all ten digits. If the
other device shows only six, it runs an older version: compare the first six."*
(`src/shared/remote/sas.ts`).

Test vectors (`src/core/relay/e2ee.test.ts`; computed independently with Python `hashlib`):

| baseKey (32 bytes) | SAS |
|---|---|
| 32 × `0x00` | `809 281 4822` |
| 32 × `0x01` (SHA-512 begins `5ce86efb 75fa4e2c`) | `736 635 8284` |
| `0x00, 0x01, …, 0x1f` | `170 596 5663` |
| 32 × `0xff` | `773 237 5799` |
| `0x00, 0x17`, then 30 × `0x00` | `071 120 4361` (leading zero in the six) |
| `0x00, 0x0b`, then 30 × `0x00` | `243 975 0790` (leading zero in the four) |

End to end: secret A = 32 × `0x01`, secret B = 32 × `0x02` → pubA
`pOCSkrZRwni5dyxWn1+puxPZBrRqtoyd+dwrRAn4ogk=`, pubB
`zo060cy2M+x7cMF4FKXHbs0CloUFDTRHRboFhw5YfVk=`, raw X25519
`2ed76ab549b1e73c031eb49c9448f0798aea81b698279a0c3dc3e49fbfc4b953`, `box.before`
`18a99320f3488fa18a04239715d8ee738065e65c3d4b2898522d6c3d4ead588c`, SAS **`561 048 8895`**.

A MITM terminating two different ECDH exchanges yields two different codes → the humans refuse.

### 3.1a Key intake: low-order keys and canonical base64

- **Refuse a low-order peer key.** If the raw `X25519(ourSecret, theirPub)` is all zero, the
  key is a small-order point (0, 1, the two order-8 points, p−1, p, p+1, each also with the top
  bit set) and `box.before` would be HSalsa20(0): a **public constant**. A secret-less peer then
  completes the handshake, both humans see the same fixed SAS, and anyone on the wire derives the
  session key. The desktop refuses such a key everywhere it takes one (handshake both roles,
  pairing offer, join code, `/pair` `epk`, pin stores, `team add-owner`) and closes the socket
  without answering. A phone must refuse it too — above all the **host key it pins** (QR
  `hostKey`, relay block, `relay.json`): check the raw X25519 output, not the `box.before` output.
- **Canonical base64 only**, padded, standard alphabet: the decoded bytes must re-encode to the
  exact input. Node's decoder skips junk (`"!!!" + key` decodes to the key), and keys are compared
  as strings in every pin store, so a second spelling is both a disguise and a key that matches
  none of its own pins. Every producer pads already.

### 3.2 The confirm frame — MUST ride the ENCRYPTED tunnel

The "I confirmed" signal is a `rpc.ts` **cast** (`relay-trust.ts` `TRUST_CONFIRM`):

```json
{ "t": "cast", "method": "trust:confirm", "args": [] }
```

sent via `sendTunnelText` — i.e. as tunnel-text (tag `0x03`) **inside the E2EE box**
(`relay-trust.ts` `confirmHere`, line 117). It is deliberately **not** a routable RPC
method: the host consumes it in the trust gate and never forwards it to any handler
(`onTunnelText` returns `true` = consumed). iOS must do the same on receipt: recognise
`{t:'cast', method:'trust:confirm'}` arriving over the tunnel and route it to the trust
state, **not** the RPC dispatcher.

**SECURITY — a plaintext confirm is a security hole and the desktop will reject it.**
The confirm is accepted **only** when it arrives over the encrypted, session-keyed,
role-tagged, replay-checked channel (`onTunnel`). A plaintext relay frame reaches only
`handleControl`, understands only `e2ee_hello`/`e2ee_ready`, and dies there — it can
never advance approval. iOS must:
- **send** its confirm only over the tunnel (never a plaintext frame), and
- **accept** the peer's confirm only from a frame that decrypted under this session's
  key (passed the role + seq checks). Never advance approval from any plaintext or
  unauthenticated source.

If a confirm can arrive any other way, mutual approval silently degrades to one-way and
the attacker supplies the confirmation the second human never gave.

### 3.3 Order of operations (both ends symmetric)

Per pairing attempt there is exactly **one** approval state, bound at creation to
**this session's** peer key and a session id (`emptyMutualApproval(peerKeyB64,
sessionId)`), so a confirm from one session physically cannot cross into another.

1. Handshake completes → `ready` (§2). SAS becomes available.
2. Each side **shows the SAS** to its human.
3. Human A presses Confirm → local state latches `localConfirmed` **and** the side
   sends `trust:confirm` over the tunnel.
4. The peer receives `trust:confirm` over the tunnel → latches `remoteConfirmed`.
5. When a side has **both** `localConfirmed && remoteConfirmed`, it **pins the peer's
   box public key** to its persistent approved-devices store **first**, then opens the
   session (`recordApproval` refuses unless both confirmed, and pins only the key
   carried by the state). Each end pins the **other's** key.
6. Only now does the host register the phone as a `CorePlatform` client and start
   serving RPC. Before that, any `req` from the phone is answered
   `{t:'res', ok:false, error:{code:"E_UNAUTHORIZED", message:"Awaiting mutual
   approval."}}` (`relay-host.ts` 191–200) — iOS must expect and surface this.

### 3.4 Persistent device key + pinning

- The phone's box keypair must be **persistent** (stable identity across reconnects),
  not ephemeral. Its public key is what the desktop pins. (On the desktop side the peer
  key is loaded/created once and reused; iOS must do the equivalent and keep the
  private key in the keychain.)
- On a later reconnect from an **already-pinned** peer, the desktop's *standing phone
  host* can auto-approve silently (pin-once) — but see the open question in §7 about
  whether the phone path uses full mutual SAS every time or pin-once after the first
  mutual approval. **Both ends pin.** iOS should persist the host's pinned key and warn
  if it ever changes (key substitution).

---

## 4. What iOS GAINS by migrating

Over the new tunnel the phone is a first-class `CorePlatform` client — the same surface
`src/server/ws.ts` gives a browser. The RPC method names are the `IPC.*` channel
strings; the phone calls them as `req`/`cast` and subscribes to `ev` channels.

### 4.1 Terminal / pty (`PtyApi`, `src/shared/types.ts`)

Requests (`req`, awaitable) and casts:

| Method (`method` string) | Kind | Args | Returns |
|---|---|---|---|
| `pty:create` | req | `(options: PtyCreateOptions)` | `PtyCreateResult` (§5) |
| `pty:write` | cast | `(sessionId, data)` | — |
| `pty:resize` | cast | `(sessionId, cols\|null, rows\|null)` | — (`null,null` = park; needs §1.2 `undef`) |
| `pty:flow` | cast | `(sessionId, resume:boolean)` | — |
| `pty:kill` | cast | `(sessionId)` | — (detach; tmux survives) |
| `pty:destroy` | cast | `(persistKey)` | — (permanent delete) |
| `pty:recycle` | cast | `(persistKey)` | — (move-into-worktree) |
| `pty:capture` | req | `(persistKey, full?)` | `string` |
| `pty:read-scrollback` | req | `(persistKey)` | `string` |
| `pty:send-text` | req | `(persistKey, text)` | `boolean` |
| `pty:read-session-name` | req | `(sessionId, accountId?)` | `string \| null` |

Inbound pty events (`ev` channels; `<sid>` = the sessionId):

| Channel | Payload | Notes |
|---|---|---|
| `pty:data:<sid>` | **binary** `encodePtyData` frame (§1.3) | terminal output; the ONLY binary channel |
| `pty:exit:<sid>` | `(exitCode:number)` | process exit |
| `pty:size:<sid>` | `({cols, rows})` | authoritative co-attach size (smallest subscriber wins) |
| `pty:closed:<sid>` | `({by: ClientId\|null})` | another client permanently destroyed the node |
| `pty:recycled:<sid>` | `(RecycledInfo {ready})` | node recycled into a worktree |
| `pty:resync:<sid>` | `(screen:string)` | we fell behind; reset the emulator and repaint from this |

### 4.2 Presence (`PresenceApi`) — the phone is a **cursorless peer**

| Method / channel | Kind | Args |
|---|---|---|
| `presence:hello` | req | `(identity: PeerIdentity {name, color})` |
| `presence:cursor` | cast | `(cursor \| null)` — a phone has no mouse: keep this `null` |
| `presence:focus` | cast | `(nodeId \| null)` |
| `presence:chat` | cast | `(text \| null)` |
| `presence:project` | cast | `(projectId \| null)` |
| `presence:sync` | ev | `(PeerState[])` — the full roster on join |
| `presence:peer` | ev | `(PeerDiff)` — `{op:'join',peer}` / `{op:'update',clientId,patch}` / `{op:'leave',clientId}` |

The phone joins presence with `kind:'phone'` (assigned host-side), stays **cursorless**
(cursor `null`), and appears in the facepile only. It CAN send `presence:hello` (named
presence — new; the old dialect had no name), `presence:focus`, `presence:chat`,
`presence:project`, and receive the full cursor/facepile diff stream. `PeerState` /
`PeerDiff` shapes: `src/shared/presence.ts` (a peer carries `clientId, name, color,
cursor, focus, chat, typing, projectId, kind`).

### 4.3 Git (`GitApi`) — entirely new to the phone

All `req`. Method strings (`IPC.*`, `src/shared/ipc.ts` 149–178): `git:status`,
`git:diff`, `git:show-file`, `git:history`, `git:stage`, `git:unstage`,
`git:stage-all`, `git:unstage-all`, `git:discard`, `git:commit`, `git:commit-files`,
`git:push`, `git:pull`, `git:sync`, `git:publish`, `git:fetch`, `git:force-push`,
`git:switch-branch`, `git:create-branch`, `git:delete-branch`, `git:rename-branch`,
`git:merge`, `git:rebase`, `git:init`, `git:clone` (+ `git:clone-progress` ev),
`git:remote-commit-url`. (The phone need only wire the ones its UI surfaces.)

### 4.4 Agent status (`AgentApi`) — new to the phone

Subscriptions only: `agent:status` (ev) and `agent:subagent-activity` (ev). Drives the
RUNNING / NEEDS-YOU badges and subagent cards the old dialect never carried.

### 4.5 Canvas co-attach / sync (`CanvasApi`) — new to the phone

`canvas:mut` is **both** a cast out (`mutate(projectId, mutation)`) **and** an ev in
(`onMutation`) on the same channel: the host stamps each mutation with a total-order
`seq` and reflects it to every client including the sender (the reflected frame is your
ACK; recognised by `src`, see `src/shared/canvas-order.ts`). Terminal **co-attach**
(two clients on one tmux session) now works for the phone because it is a real
`CorePlatform` client: `pty:create` co-attaches, `pty:size:<sid>` gives the shared
size, `PtyCreateResult.screen` paints the current screen on join (§5).

---

## 5. What iOS LOSES / must re-implement — old opcode → new rpc mapping

The `framing.ts` opcode flow (`OP.Input`/`OP.Output`/`OP.Subscribe`/`OP.Snapshot*`…)
and `snapshot.ts` three-stage screen reassembly are **deleted**. Map each old concept
to its new equivalent:

| Old opcode / concept (`framing.ts` OP #) | New rpc.ts equivalent |
|---|---|
| `OP.Input` (7) — keystrokes to host | `cast` **`pty:write`** `(sessionId, data)` (JSON, tag 0x03) |
| `OP.Output` (1) — host → client bytes | **binary** `pty:data:<sid>` frame = `encodePtyData(sessionId, chunk)` (tag 0x04, §1.3) |
| `OP.Resize` (8) — client reports size | `cast` **`pty:resize`** `(sessionId, cols, rows)` (park = `null,null`, §1.2) |
| `OP.Resized` (5) — host's effective size | `ev` **`pty:size:<sid>`** `({cols, rows})` |
| `OP.Subscribe` (9) — attach to a session | `req` **`pty:create`** `(PtyCreateOptions)` → `PtyCreateResult` (co-attaches to a live tmux session) |
| `OP.Unsubscribe` (10) — detach | `cast` **`pty:kill`** `(sessionId)` (tmux session survives) |
| `OP.SnapshotStart/Chunk/End` (2/3/4) — first-screen paint | **`PtyCreateResult.screen`** on the create response (§5) — no separate stream |
| `OP.SnapshotRequest` (11) — ask for a repaint | Gone. Join-paint is `screen`; a mid-session forced repaint arrives unsolicited as `ev` **`pty:resync:<sid>`** `(screen)` |
| `OP.Error` (6) | `res` **`{t:'res', ok:false, error:{code, message}}`** |
| `host-canvas-hub` `canvas:state` full mirror | seq-stamped `canvas:mut` reflector (§4.5) |
| `sanitizeClientMutation` | gone — superseded by the trust decision (an approved peer is fully trusted) |

### 5.1 First-screen paint — `PtyCreateResult` (`src/shared/types.ts` 41–75)

The `pty:create` reply is:

```
PtyCreateResult = {
  sessionId: string,
  fresh: boolean,               // true = cold start (new tmux session, e.g. post-reboot); false = warm reattach
  accountFallback?: boolean,    // account dir missing → fell back to system account (Claude accounts; usually irrelevant on phone)
  screen?: string,              // ← the join-paint: CURRENT tmux screen text, present only for a co-attach that did NOT resize the pty
  closed?: { by: number | null } // REFUSED: node was permanently destroyed by another client; sessionId is empty — show "closed by <name>"
}
```

- On a **co-attach** (`fresh:false`) where the join left the pty grid unchanged,
  `screen` carries the current screen — **write it into the fresh terminal before the
  live `pty:data` stream starts**. This *is* the old `OP.Snapshot*` payload, delivered
  in one field. When the join resizes the pty, `screen` is deliberately absent (tmux
  redraws instead; painting twice would splice two moments). `screen` is guaranteed
  non-empty when present.
- On a **cold** open (`fresh:true`), there is no `screen`; use
  `pty:read-scrollback` for the persisted snapshot if you want restore-on-reboot
  behaviour.
- If `closed` is set, the node was deleted by another client — show the closed state,
  do **not** respawn.

---

## 6. Desktop-side lockstep work (nodeterm side — must land WITH or BEFORE the iOS migration)

**The interactive desktop-peer host already speaks the new tunnel** (`relay-host.ts`:
mint client id → register sink → join presence → route `onTunnel` text through
`platform.dispatch`/`platform.cast`). **The standing (always-on) PHONE host does not.**

`standing-host.ts` still routes the phone through **`connectHostSession`
(`host-service.ts`)** — the old opcode dialect, `snapshot.ts`, the fs jail,
`host-canvas-hub`'s `canvas:state` mirror. `relay-host.ts` explicitly scopes itself to
the desktop-peer vocabulary and states the phone host is *deliberately not* routed
through it yet:

> "the standing PHONE host keeps its existing legacy vocabulary in `host-service.ts` —
> with its deny-by-default fs jail — and is deliberately NOT routed through this
> dispatch path." (`relay-host.ts` SCOPE comment)

**Therefore:** once nodeterm deletes the opcode dialect (`framing.ts` OP codes,
`snapshot.ts`, `host-service.ts`'s RPC verbs, `host-canvas-hub`), **the standing host
loses the protocol the phone talks — and the phone stays broken even after iOS
updates**, unless `standing-host.ts` is rewired to the new tunnel the same way
`relay-host.ts` wires the interactive host.

Concretely, the nodeterm-side task that must ship compatibly:

1. **Rewire `standing-host.ts` onto the `relay-host.ts` tunnel** (mint a
   `allocateRelayClientId()`, `registerPeerSink` with an **honest**
   `bufferedAmount()` = `socket.bufferedAmount()`, `presenceHub.join(id,'phone')`,
   route `onTunnel` text → `platform.dispatch`/`platform.cast`). Keep the
   phone-specific bits the desktop-peer host doesn't need: the warm-standby listener
   **pool**, token **auto-refresh** (~120 s TTL), and reconnect backoff.
2. **Join presence as `kind:'phone'`** (cursorless), not `'desktop'` — the phone has no
   mouse.
3. **Decide the trust model for the phone** and wire it: either the full mutual-SAS
   gate (`relay-trust.ts` `createTrustGate`), or pin-once-after-first-mutual-approval.
   The old standing host used one-way pin-once; §3 / `docs/remote-sessions.md` make the
   peer participate in **mutual** SAS. This must be settled jointly with iOS (see §7).
4. **Delete the old dialect** (`framing.ts`, `snapshot.ts`, `host-service.ts` RPC verbs,
   `host-canvas-hub`, `sanitizeClientMutation`, `RemoteTransport`) only *after* both
   the phone and desktop-peer hosts are on the tunnel.
5. **fs-jail decision:** `relay-host.ts` serves the **full** `CorePlatform` (no jail —
   an invited peer is fully trusted). The phone previously had a deny-by-default fs
   jail. Moving the phone to the same tunnel drops that jail unless deliberately
   re-added. Flag as a security decision (§7).

**Ship-compatibility contract:** the iOS rewrite (new tunnel) and the
`standing-host.ts` rewire (new tunnel) are two halves of one change. Merging either
alone leaves the phone unable to connect. File and land them together.

---

## 7. Security requirements iOS MUST honour (checklist)

1. **Compare the SAS out of band.** Compute `sasFromSharedKey(baseKey)` exactly (§3.1, v2),
   display "NNN NNN NNNN" with the compare-all-ten copy, and require the human to confirm it
   matches the desktop before proceeding. This is the only defence against a relay MITM.
1a. **Refuse a low-order peer key and non-canonical base64** (§3.1a), at every place a key is
   taken — above all the host key you pin.
2. **Send the confirm ONLY over the encrypted tunnel** as `{t:'cast',
   method:'trust:confirm', args:[]}` via a TAG_TUNNEL_TEXT box. Never send a plaintext
   confirm — the desktop rejects it and it is a security hole.
3. **Accept a peer confirm ONLY from a frame that decrypted under this session's key**
   and passed the role + seq checks. Never advance approval from plaintext or
   unauthenticated data.
4. **No mid-session re-key.** After `ready`, ignore any `e2ee_hello`/`e2ee_ready`
   plaintext control frame (do not re-derive keys, do not close the socket). The
   session's peer key and SAS are frozen.
5. **Pin the peer's box public key** (persistent identity on both ends). Warn on any
   change to a previously pinned key (key substitution).
6. **Enforce the anti-replay seq** (strictly increasing inbound) and the **role byte**
   (reject boxes carrying your own role = a relay reflection). Reset counters per
   connection.
7. **Persist your own box keypair** (keychain). A fresh ephemeral key each launch would
   force re-approval every time and break pinning.
8. **Endianness discipline:** box seq is little-endian (2×uint32 LE, high then low);
   `encodePtyData` sidLen is big-endian uint16; SAS folds `h[0..4]` and `h[4..8]` big-endian.
   Do not cross them.
10. **Pin the SSH host key from the pairing QR** (§7.1) instead of trusting the first connect.

### 7.1 The pairing QR's `sshHostKeys` (desktop `pairing-core.ts` `buildPairingPayload`)

The QR now carries this host's SSH host-key fingerprints, so the phone's first SSH connect after
pairing is no longer trust-on-first-use (an on-path attacker could otherwise serve a forged
`agent.json` / `relay.json` over that first connection):

- key `sshHostKeys`: JSON array of OpenSSH SHA-256 fingerprints,
  `"SHA256:<standard base64 of sha256(keyBlob), trailing '=' removed>"` — the `ssh-keygen -lf`
  spelling; `keyBlob` = base64-decode of the `.pub` line's second field (the SSH wire blob, the same
  bytes the server presents). At most 4, ordered ed25519, ecdsa, rsa.
- position: after `relay` (or after `hostKey` / `name` when those are absent), before `ssh`.
- **complete or absent, never partial.** The phone refuses a key not in the set, and sshd presents
  whichever of its keys the client's algorithm preference picks, so a partial list would lock the
  phone out. The desktop lists exactly what sshd would serve: the `HostKey` paths of
  `/etc/ssh/sshd_config` and the files it `Include`s (else sshd's defaults
  `/etc/ssh/ssh_host_{rsa,ecdsa,ed25519}_key`), each counted only when its private file exists, and
  each `.pub` must read and parse (a blob naming a different algorithm than its first field is
  refused). Any doubt omits the field: an unreadable `.pub`, `HostKeyAgent`, a relative or
  tokenized path, an `Include` glob form it does not model, more than 4 keys. With the config
  unreadable, the defaults are used only when all three are present and consistent.
- omitted when there is no complete list, and **always** omitted with `ssh:false` (Windows) — that
  payload is byte-identical to before.

Phone side (iOS / Android follow-up): when present, accept the first SSH connect only if the
server's key fingerprint is in the list, and pin it at commit instead of `forget`ting the pin;
absent = the old TOFU behaviour.
9. **`undef` correctness** (§1.2) on both encode and decode, so a meaningful `null`
   (park, presence-clear) is never mistaken for an omitted argument.

---

## 8. Open questions for the iOS developer

1. **Phone trust model:** full mutual SAS on every connect, or mutual SAS on first
   pairing then silent pin-once auto-approve on reconnect (the standing host's current
   pin-once behaviour)? The nodeterm rewire (§6.3) and iOS must agree. Recommendation:
   mutual SAS on first pair, pin-once thereafter — but confirm against the final
   `standing-host.ts` wiring.
2. **fs access scope:** the desktop-peer tunnel serves the full `CorePlatform` (no fs
   jail). Does the phone get full fs (git, editor, file browse) too, or is a jail
   re-introduced for the phone specifically? (§6.5) This changes what `git:*`/`fs:*`
   the phone may call.
3. **License / entitlement:** the standing host is gated on Pro + `phoneAccessEnabled`.
   No iOS-visible change expected, but confirm the phone surfaces a clean
   "host unavailable / not Pro" state (the phone will simply fail to find a host).
4. **Which namespaces to wire first:** pty + presence are the MVP (parity with today,
   plus named presence). git / agent-status / canvas-mut are the new gains — stage them.
5. **Reconnect + token lifecycle:** relay tokens are single-use and short-lived
   (~120 s). On the phone side, how are fresh join tokens obtained on reconnect
   (`POST /v1/relay/join` against the host id from pairing)? Mirror the desktop's
   fresh-token-per-reconnect rule — the socket does **not** self-reconnect on the same
   token (`relay-socket.ts` `handleClose`).
6. **`PtyCreateOptions` fields the phone must send:** `persistKey` (node id, stable),
   `cols`/`rows`, `shell`/`cwd`/`agentId`/`accountId` — confirm which the phone
   controls vs. inherits from the host's persisted node. (`src/shared/types.ts`
   `PtyCreateOptions`.)
7. **Binary vs. text framing on the iOS WebSocket/relay client:** ensure the phone's
   socket layer preserves text-vs-binary (handshake control = text; boxes = binary),
   exactly as `wrapWebSocket` does on the desktop.

---

## Source-of-truth files (nodeterm side, this checkout)

- Tunnel protocol: `src/shared/rpc.ts`
- E2EE + framing state machine: `src/main/remote/relay-socket.ts`, `src/main/remote/e2ee.ts`
- Trust: `src/main/remote/relay-trust.ts`, `src/main/remote/mutual-approval-core.ts`
- New host join point: `src/main/remote/relay-host.ts`
- Standing phone host (to be rewired): `src/main/remote/standing-host.ts`, `src/main/remote/host-service.ts`
- Deleted dialect (for the mapping): `src/main/remote/framing.ts`, `src/main/remote/snapshot.ts`, `src/main/remote/host-canvas-hub.ts`
- Method/channel strings: `src/shared/ipc.ts`; API shapes: `src/shared/types.ts`, `src/shared/presence.ts`
- Design context: `docs/remote-sessions.md`
