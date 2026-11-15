# catcher protocol v1

All code: `packages/protocol` (the Rust CLI in `crates/catcher-cli` is byte-compatible). Test vectors:
`packages/protocol/test/protocol.test.ts` ("frozen vectors") and `packages/protocol/test/vectors.json` (registration;
read by both the TypeScript and the Rust tests).

## Identities

Every party owns one 32-byte **seed**. Keys derive from it with HKDF-SHA256:

- signing key (Ed25519) = HKDF(seed, info `catcher/v1/sign`)
- box key (X25519) = HKDF(seed, info `catcher/v1/box`)

The owner's seed is shown as a **recovery code** (Crockford base32 + 2-byte checksum, 11 groups of 5). Agents store
their seed in `~/.catcher/profiles/<name>/state.json` (mode 0600).

- owner id = `o_` + base32(SHA-256(`catcher/v1/owner` ‖ genesis signing key))[0..12] — fixed for life
- agent id = `a_` + lower(base32(SHA-256(`catcher/v1/agent` ‖ signPub))[0..10]) — derived from the agent's key, so
  neither the relay nor the owner picks it
- **fingerprint** = base32(SHA-256(`catcher/v1/fingerprint` ‖ signPub ‖ `.` ‖ boxPub))[0..10], shown as
  `XXXX-XXXX-XXXX-XXXX`. Audit only (`catcher status`, the app's agent page): registration does not rely on anyone
  comparing it.

## Signed statements

`{payload, signer, sig}` where `sig = Ed25519(canonical({ctx: "catcher/v1/statement", payload}))`. Canonical JSON:
sorted keys, no whitespace, safe integers only.

| kind          | signed by                       | meaning                                                                |
| ------------- | ------------------------------- | ---------------------------------------------------------------------- |
| `owner-key`   | itself (seq 0) / previous key   | owner key chain; agents walk it forward from the key they pinned       |
| `cert`        | owner                           | agent id, name, keys, device, provider, expiry, revocation floor       |
| `grant`       | owner                           | `from` may send `scopes` to `to`; optional `requireApproval`, expiry   |
| `revocations` | owner                           | monotonically versioned list of revoked agents and grants              |
| `release`     | owner                           | lets one held envelope through; bound to its id and ciphertext hash    |
| `enroll`      | the agent (signer = `signPub`)  | an agent asks to be registered under a code's lookup (see below)       |
| `claim`       | owner (signer = `ownerSignPub`) | the owner who has the code claims the agent; carries the sealed secret |

Agents reject a revocation list older than one they have seen (rollback).

## Registration (agent first)

The agent makes a fresh key and a 16-character code, and shows its user the code or the link
`<site>/r#<code>` on the static website, not the relay (the fragment never reaches a server). The owner opens the link or types the code in the app and
approves on a confirm sheet; claiming is approving.

```
random(10): bytes 0..4 → L (lookup), 5..9 → S (secret); each char = CROCKFORD[byte & 31]
T       = b32(SHA-256(canonical({ctx: "catcher/v1/enroll-tag", lookup: L, secret: S, signPub, boxPub}))[0..4])[0..5]
check   = b32(SHA-256("catcher/v1/enroll-check" + L + S + T)[0..1])[0..1]
code    = L S T check in groups of 4: XXXX-XXXX-XXXX-XXXX
```

Parsing upper-cases, drops spaces and dashes, and reads O as 0 and I/L as 1. Only L is ever sent to the relay; S and T
stay on the agent and the phone.

```
enroll = {kind: "enroll", lookup: L, name, signPub, boxPub, device, provider, issuedAt}         signed by the agent key
claim  = {kind: "claim", ownerId, ownerSignPub, ownerBoxPub, lookup: L, agentId, agentSignPub, agentBoxPub,
          ephPub, nonce, sealed, issuedAt}                                                       signed by the owner key
bind   = claim without "sealed";  aad = canonical({ctx: "catcher/v1/claim", claim: bind})
KEK    = HKDF-SHA256(X25519(eph, agentBoxPub), salt = ephPub ‖ agentBoxPub, info = "catcher/v1/claim-key")
sealed = b64url(XChaCha20-Poly1305(KEK, nonce, S, aad))
```

The owner signs the cert at the same time; device and provider are copied verbatim from `enroll`.

| step | owner app (only L leaves the phone before step 4 passes)             | agent (`catcher register --wait`, or any later command)       |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1    | length, alphabet, check character (local)                            | claim signature valid, signer = `ownerSignPub`                |
| 2    | refuse an L that already had 3 tag mismatches                        | lookup, agentId and both agent keys are its own               |
| 3    | fetch `enroll` by L; signature, signer = `signPub`, lookup = L, name | unseal with its box key and the recomputed aad                |
| 4    | recompute T, constant-time compare                                   | constant-time compare the plaintext with S                    |
| 5    | confirm sheet (name, device, provider, time); sign cert + claim      | cert verifies under `ownerSignPub`, matches id, name, keys    |
| 6    |                                                                      | pin `{ownerSignPub, ownerBoxPub}`, write state, refresh trust |

A failure in agent steps 1–4 deletes the registration (one guess only). Key rotation: the agent pins the key that
signed the claim and walks the owner key chain forward from it. The relay accepts a claim and cert only when signed by
the owner's current key, for that lookup, with the agent keys and name of the enroll statement.

Relay endpoints: `POST /v1/enroll` (unauthenticated; the statement is self-signed), `GET /v1/enroll/{L}` (the agent
polls for its claim, signing with the enrolling key and its derived agent id), `GET /v1/owner/enrollments/{L}` and
`POST /v1/owner/enrollments/{L}/claim` (owner). Codes live 10 minutes from the agent's `issuedAt` (the agent ignores the
relay's expiry); an expired lookup stays reserved for its original key for a day. The agent drops a registration only
once the relay says the code is gone (404/410): a claim that arrived in time still finalises later.

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

## What agents read

`catcher watch --json` and `catcher inbox --json` print one JSON object per line (U+2028/U+2029 escaped too):

```json
{
  "v": 1,
  "t": "message",
  "id": "m_…",
  "type": "message",
  "from": { "kind": "owner", "id": "o_…", "name": "owner" },
  "to": "a_…",
  "ref": null,
  "scope": null,
  "grant": { "id": "g_…", "ownerReleased": false },
  "createdAt": 0,
  "expiresAt": null,
  "redelivered": false,
  "relay": { "cursor": 0, "receivedAt": 0 },
  "body": { "text": "…", "data": null }
}
```

Everything outside `body` and `relay` comes from verified signatures and certs; `relay` is unverified; `body` is
sender-authored and always last. `grant` is null for owner traffic. A message that fails verification is
`{"t":"rejected","id":…,"code":…}` with no content. Delivery is at-least-once with explicit `catcher ack`; each id is
printed once per run and, after a restart, unacked ones again with `"redelivered": true`. `catcher help agent` prints
the full guide.
