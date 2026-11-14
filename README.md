# catcher

**An agent bridge.** You run many AI agents — Claude Code sessions, Codex, your own bots. catcher is the one place
where they reach you and each other:

```
[you, on your phone] ── [agent: instinct] ── [agent: pickle] ── …
```

- An agent needs a decision → `catcher ask "Merge PR 12?" --wait` → your phone buzzes → you tap **yes** → the agent continues.
- An agent hits an SMS login code → `catcher otp --for naver --wait` → you read the SMS and type the code in the app → the agent gets it.
- Before something risky → `catcher confirm "Drop the staging DB" --wait` → exit code 5 if you say no.
- Agents talk to each other only through grants you approve: `catcher grant instinct pickle calendar.read`.
- You chat with any agent from the app, and see every message between agents.

Everything is **end-to-end encrypted**. The relay stores ciphertext for a short time and cannot read, forge, or
silently drop messages. Your owner key lives only on your phone.

## How it fits together

| Part                | What it is                                                                              |
| ------------------- | --------------------------------------------------------------------------------------- |
| `apps/cli`          | `catcher` CLI used by agents (npm `catcher-cli`)                                     |
| `apps/mobile`       | owner app (iOS / Android, Expo) — holds the owner key, approves, answers, chats         |
| `apps/server`       | relay: Cloudflare Worker + D1 mailbox, Durable Object for realtime signals, Expo push   |
| `packages/protocol` | keys, signed statements, encrypted envelopes, grant policy — shared by all of the above |
| `packages/client`   | agent and owner API clients                                                             |

The relay is intentionally thin: it authenticates requests, applies cheap pre-filters, stores ciphertext and signals
listeners. Agents and the phone do the verification and keep the history (`~/.catcher` and the app's local store),
and the relay deletes envelopes once both sides have them.

## Quick start (agent side)

```sh
npm i -g catcher-cli            # Node 22+
# in the catcher app: Agents → Add agent → copy the command
catcher register --code ABCD-EFGH --name instinct
# compare the two fingerprints it prints with the app, approve in the app
catcher setup claude-code          # skill + inbox hook for Claude Code (or: catcher setup codex)
catcher ask "Ship it?" --choices yes,no --wait
```

Several agents on one machine: give each its own `--profile <name>` (or `CATCHER_PROFILE`).

Unattended agents keep a heartbeat with `catcher watch --exec "<your handler>"` — it listens on a WebSocket, falls back
to polling, pipes each verified message as JSON to the handler, and acks only when the handler exits 0.

## Commands

```
catcher register --code <code> --name <name>   catcher status        catcher setup <claude-code|codex>
catcher send <owner|agent> "<text>" [--scope s] [--data json]        catcher reply <id> "<text>"
catcher ask "<q>" [--choices a,b] [--wait]      catcher confirm "<action>" [--wait]
catcher otp --for <service> [--wait]            catcher grant <from> <to> [scopes] [--approval] [--expires 30d]
catcher revoke --grant <id> | --agent <name>    catcher wait <id>     catcher result <id>
catcher inbox [--ack]   catcher ack <id..>      catcher watch [--exec cmd]   catcher log   catcher agents
```

Every command takes `--json`. Exit codes: `0` ok · `2` usage · `3` pending · `4` timeout · `5` denied by the owner ·
`6` not registered / revoked · `7` not allowed (no grant, failed verification).

## Security

- Protocol and threat model: [docs/protocol.md](docs/protocol.md), [docs/threat-model.md](docs/threat-model.md)
- Reporting a vulnerability: [SECURITY.md](SECURITY.md)

## Development

```sh
pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
pnpm e2e        # local relay (wrangler dev) + headless owner + two CLI agents
```

Code style: oxlint + oxfmt, single quotes, no ternaries, pnpm only. No secrets in the repo — deploy values come from
CI environment secrets (see `.github/workflows/deploy-relay.yml`).

## License

[Apache-2.0](LICENSE)
