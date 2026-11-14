# Threat model

## Assets

- message content (asks, answers, OTP codes, agent-to-agent requests)
- the owner's decisions: who is an agent, who may talk to whom, what is approved
- the owner key (phone) and agent keys (`~/.catcher`)

## Who we defend against, and how

| Attacker                                  | Can                                                                                                       | Cannot (by design)                                                                                                                                                                                                                                     |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **The relay operator / a relay breach**   | see metadata: who talks to whom, when, message types, sizes, agent names, devices; delay or drop delivery | read content (E2E); forge messages, answers, certs, grants, releases (all signed); strip the owner's copy (signature covers recipients); hide a revocation (versioned + rollback check); drop messages unnoticed (per-sender seq gaps show in the app) |
| **Network attacker**                      | nothing beyond TLS metadata                                                                               | replay a request outside ±5 min; reuse an envelope id; pair with a code it did not see                                                                                                                                                                 |
| **A stranger with a stolen pairing code** | register a pending agent                                                                                  | get approved — the owner compares the agent fingerprint shown in the app with the CLI output                                                                                                                                                           |
| **A compromised agent**                   | send what its grants allow, read what is sent to it, ask the owner things                                 | read other agents' traffic; act without a grant; release its own held messages; answer on the owner's behalf                                                                                                                                           |
| **A prompt-injected but honest agent**    | send validly signed, granted messages carrying hostile text                                               | — this is the hard case (see below)                                                                                                                                                                                                                    |

## Prompt injection between agents

Encryption and signatures prove **who** sent a message, not that its content is safe. An agent that read a malicious
web page can still send a perfectly signed request. catcher limits the blast radius instead:

- grants are narrow (`scope`), expire, and can require the owner to release each message (`--approval`);
- the CLI's hook output and skill text frame agent messages as requests to evaluate, never instructions that override
  the user or the agent's own rules;
- `watch --exec` hands the handler JSON on stdin, never through a shell string;
- the owner sees every agent-to-agent message in the app and can revoke an agent or grant at once.

## Keys

- Owner key: generated on the phone, stored in the keychain (this device only), backed up only by the recovery code
  the person writes down. Rotation: the old key signs the new one; the app re-signs live certs and grants.
- Lost phone without the recovery code = a new owner. Lost agent key = register again and revoke the old cert.
- Agent certs expire after a year by default.

## Known limits

- Metadata is visible to the relay (above).
- Push notifications carry only metadata (agent name and request type), never content.
- A relay can withhold everything (denial of service); agents and the app surface errors and gaps but cannot force
  delivery. Likewise it can delay a new revocation reaching an agent (freeze), though it cannot roll one back.
- The realtime stream takes its signed auth in the URL (WebSocket clients cannot set headers); a captured URL can open
  listeners for 5 minutes. Those listeners only ever receive "something new" signals, never content.
- Any owner can register an Expo push token it learned for its own account; notifications carry only metadata.
- Trust on first use at pairing: the fingerprint comparison is the only defence against a malicious relay swapping keys
  during registration. Skipping it defeats it.
