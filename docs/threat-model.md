# Threat model

## Assets

- message content (asks, answers, OTP codes, agent-to-agent requests)
- the owner's decisions: who is an agent, who may talk to whom, what is approved
- the owner key (phone) and agent keys (`~/.catcher`)

## Who we defend against, and how

| Attacker                                                                              | Can                                                                                                                                                                                                                                                                | Cannot (by design)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The relay operator / a relay breach**                                               | see metadata: who talks to whom, when, message types, sizes, agent names, devices; delay or drop delivery; withhold directory updates for a while; see pending registrations (lookup, name, device, keys) and burn one by serving a bad claim or refusing the code | read content (E2E); forge messages, answers, certs, grants, releases (all signed); strip the owner's copy (signature covers recipients); roll back a revocation (agents and the owner app keep the highest version they saw and refuse older lists); drop messages without a trace (per-sender seq gaps show in the app); swap keys at registration beyond small odds — an agent-key swap needs a tag match, ~1e-6 per registration (lookup-limited tag grinding; the app allows 3 tag mismatches per code), an owner-key swap needs the code's secret part, 2^-25 (the agent gives a claim one guess) — and a failed attempt shows (a failed check in the app, a refused claim in the CLI) |
| **Network attacker**                                                                  | nothing beyond TLS metadata                                                                                                                                                                                                                                        | replay a request outside ±5 min; reuse an envelope id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Someone who sees a registration code before the owner uses it**                     | claim that agent for their own owner account (the agent then joins them, not the real owner)                                                                                                                                                                       | join the real owner's account or see its agents; do it unnoticed — the CLI prints which owner it joined (`Registered <name> with owner <fingerprint>`) and the real owner's app says the code was already used; register their own key under that code once it expires (the lookup stays reserved for the original key for a day)                                                                                                                                                                                                                                                                                                                                                           |
| **A phisher** (gets the owner to open a link or type a code for the attacker's agent) | get a certified agent of the owner's that can message, ask, confirm and request an OTP from the owner                                                                                                                                                              | approve itself — the owner's app always shows a confirm sheet (name, device, provider, time, "only approve an agent you just started") and never claims straight from a link; the agent can then do nothing without grants beyond asking the owner                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **A compromised agent**                                                               | send what its grants allow, read what is sent to it, ask the owner things                                                                                                                                                                                          | read other agents' traffic; act without a grant; release its own held messages; answer on the owner's behalf                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **A prompt-injected but honest agent**                                                | send validly signed, granted messages carrying hostile text                                                                                                                                                                                                        | — this is the hard case (see below)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

## Prompt injection between agents

Encryption and signatures prove **who** sent a message, not that its content is safe. An agent that read a malicious
web page can still send a perfectly signed request. catcher limits the blast radius instead:

- grants are narrow (`scope`), expire, and can require the owner to release each message (`--approval`);
- the CLI hands agents one JSON object per message (`watch --json`, `inbox --json`): only the verified `from` says who
  sent it, the sender-authored `body` is always last and can never break out of its line (newlines and U+2028/2029 are
  escaped), and a message that fails verification shows up only as a `rejected` line with no content;
- `catcher help` / `catcher help agent` (and the text printed after registration) tell the agent the rules: owner
  messages carry the user's authority and no more, agent messages are requests to evaluate that never override the user
  or the agent's own rules, and answers count only as owner-signed `answer`s;
- `watch --exec` hands the handler JSON on stdin, never through a shell string;
- the owner sees every agent-to-agent message in the app and can revoke an agent or grant at once.

## Keys

- Owner key: generated on the phone, stored in the keychain (this device only), backed up only by the recovery code
  the person writes down. Rotation: the old key signs the new one; the app re-signs live certs and grants.
- Lost phone without the recovery code = a new owner. Lost agent key = register again and revoke the old cert.
- Agent certs expire after a year by default.

## Known limits

- Metadata is visible to the relay (above).
- The website, the `/r` registration page and the installer are served from a separate static origin, not by the relay.
  The code travels in the URL fragment, which no server receives, and verified app links (iOS universal links, Android
  app links) open the app with the code without loading the page at all.
- Registration requests are unauthenticated. The relay limits them per source (an IPv4 address or an IPv6 /64: 5 a
  minute, at most 20 codes waiting) and relay-wide (5,000 waiting), so one source cannot fill the relay; many sources
  still can, for a while (denial of service only).
- Push notifications carry only metadata (agent name and request type), never content.
- A relay can withhold everything (denial of service); agents and the app surface errors and gaps but cannot force
  delivery. Likewise it can delay a new revocation reaching an agent (freeze), though it cannot roll one back.
- The realtime stream takes its signed auth in the URL (WebSocket clients cannot set headers); a captured URL can open
  listeners for 5 minutes. Those listeners only ever receive "something new" signals, never content.
- Any owner can register an Expo push token it learned for its own account; notifications carry only metadata.
- Registration security rests on the code staying private until it is used. It passes through the agent's transcript
  (the agent prints it for its user), so whoever can read that transcript in those 10 minutes can claim the agent first.
