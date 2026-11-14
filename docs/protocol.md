# catcher protocol v1

All code: `packages/protocol`. Test vectors: `packages/protocol/test/protocol.test.ts` ("frozen vectors").

## Identities

Every party owns one 32-byte **seed**. Keys derive from it with HKDF-SHA256:

- signing key (Ed25519) = HKDF(seed, info `catcher/v1/sign`)
- box key (X25519) = HKDF(seed, info `catcher/v1/box`)

The owner's seed is shown as a **recovery code** (Crockford base32 + 2-byte checksum, 11 groups of 5). Agents store
their seed in `~/.catcher/profiles/<name>/state.json` (mode 0600).

- owner id = `o_` + base32(SHA-256(`catcher/v1/owner` ‖ genesis signing key))[0..12] — fixed for life
- **fingerprint** = base32(SHA-256(`catcher/v1/fingerprint` ‖ signPub ‖ `.` ‖ boxPub))[0..10], shown as `XXXX-XXXX-XXXX-XXXX`

## Signed statements

`{payload, signer, sig}` where `sig = Ed25519(canonical({ctx: "catcher/v1/statement", payload}))`. Canonical JSON:
sorted keys, no whitespace, safe integers only.

| kind          | signed by                     | meaning                                                              |
| ------------- | ----------------------------- | -------------------------------------------------------------------- |
| `owner-key`   | itself (seq 0) / previous key | owner key chain; agents walk it forward from the key they pinned     |
| `cert`        | owner                         | agent id, name, keys, device, provider, expiry, revocation floor     |
| `grant`       | owner                         | `from` may send `scopes` to `to`; optional `requireApproval`, expiry |
| `revocations` | owner                         | monotonically versioned list of revoked agents and grants            |
| `release`     | owner                         | lets one held envelope through; bound to its id and ciphertext hash  |
| `pairing`     | owner                         | asks the relay for a pairing code                                    |
| `register`    | the agent                     | proof the registering agent holds its keys                           |

Agents reject a revocation list older than one they have seen (rollback).

## Envelopes

```
core   = {v, id, ownerId, from, to, type, seq, createdAt, ref, scope, grantId, expiresAt, nonce, ephPub, keyHash}
body   = XChaCha20-Poly1305(K, nonce, aad = canonical({ctx: "catcher/v1/body", core}))
wrap_r = XChaCha20-Poly1305(HKDF(X25519(eph, box_r), salt = ephPub ‖ box_r), wrapNonce, K, aad = "catcher/v1/wrap|id|r")
sig    = Ed25519_sender(canonical({ctx: "catcher/v1/envelope", core, wraps, ctHash}))
```

`keyHash = SHA-256("catcher/v1/key" ‖ K)` commits every recipient to the same body key, so the owner's audit copy is
exactly what the target reads. Recipients are always exactly **the target, the owner and the sender** — the owner can audit everything, the sender
can read its own log. The signature covers the recipient list and the wrapped keys, so nobody can strip the owner's
copy or re-sign someone else's ciphertext.

Types: `message`, `reply` (needs `ref`), `ask`, `confirm`, `otp`, `grant-request` (agent → owner), `answer`
(owner → agent, needs `ref`). `seq` increases per sender, so the owner app can detect gaps.

## Policy (checked by every recipient)

1. Sender and recipient have live owner-signed certs (or are the owner).
2. Agent → agent `message` needs a grant from → to that covers `scope`; with `requireApproval`, also an owner `release`
   bound to the exact ciphertext.
3. Agent → agent `reply` names the grant of the message it answers (and is held the same way when that grant needs
   approval). It must answer a `message` the recipient sent — not a reply — and only once.
4. Answers are owner-signed envelopes; agents only accept them for requests they sent, of the type they expect
   (`confirm` needs `approved: true`, `otp` a code, `ask` an answer), and once.
5. An envelope id the agent already acked is a replay and is dropped. A reused id with different content is refused.
6. Every cert carries the revocation version at issue time (`revocationFloor`); an agent never accepts an older list.

The relay runs cheap versions of these checks so junk never reaches a mailbox, but it is not trusted for any of them.

## Requests to the relay

Header `x-catcher-auth: <callerId>.<ms>.<sig>` with
`sig = Ed25519(canonical({ctx: "catcher/v1/request", method, path, ts, bodyHash}))`, valid for ±5 minutes.
The realtime stream (`GET /v1/stream`) takes the same value as `?auth=`.
