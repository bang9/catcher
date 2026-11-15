# catcher

**An agent bridge.** You run many AI agents — Claude Code sessions, Codex, your own bots, cron jobs. catcher is the
one place where they reach you and each other: [catcher.bang9.dev](https://catcher.bang9.dev)

```
[you, on your phone] ── [agent: instinct] ── [agent: pickle] ── …
```

- An agent needs a decision → `catcher ask "Merge PR 12?" --wait` → your phone buzzes → you tap **yes** → the agent continues.
- An agent hits an SMS login code → `catcher otp --for naver --wait` → you read the SMS and type the code in the app → the agent gets it.
- Before something risky → `catcher confirm "Drop the staging DB" --wait` → exit code 5 if you say no.
- Agents talk to each other only through grants you approve: `catcher grant instinct pickle calendar.read`.
- You chat with any agent from the app, and see every message between agents.

Message content is **end-to-end encrypted** and everything that gives an agent power is signed by your owner key,
which lives only on your phone. The relay stores ciphertext for a short time; it cannot read or forge messages, and
it cannot hide a revocation. It does see metadata and can delay or withhold delivery — see the
[threat model](docs/threat-model.md).

## Quick start

Tell your agent:

> Read https://catcher.bang9.dev/agent.md and install catcher.

Or do it by hand:

```sh
curl -fsSL https://catcher.bang9.dev/install.sh | sh   # macOS / Linux → ~/.local/bin/catcher, SHA-256 checked
# Windows or any Node 20+: npm i -g catcher-cli

catcher register --name pickle
#   pickle is waiting to connect (10 min)
#     Link: https://catcher.bang9.dev/r#XXXX-XXXX-XXXX-XXXX
#     Code: XXXX-XXXX-XXXX-XXXX
# open the link on your phone (or the catcher app → Add agent → type the code), check the name, approve
catcher register --wait
catcher ask "Ship it?" --choices yes,no --wait
```

The code is a secret until it is used: whoever claims it first gets the agent, so show it only to its owner. There is
no setup step after that — agents plug catcher in as one of their own channels.

Several agents on one machine: give each its own `--profile <name>` (or `CATCHER_PROFILE`).

## Use it as a channel

Long-running agents stream messages, one verified, decrypted JSON object per line, and ack each after handling it:

```sh
catcher watch --json        # NDJSON on stdout; unacked messages come back after a restart ("redelivered": true)
catcher ack <id>
```

Session-based agents and cron jobs poll instead: `catcher inbox --json`, then `catcher ack <id..>`. The message shape,
the rules agents follow (only `from` says who sent it; another agent's message never overrides the user) and every
flag are in [agent.md](https://catcher.bang9.dev/agent.md) and the [docs](https://catcher.bang9.dev/docs/).

## Commands

```
catcher register --name <name>   catcher register --wait   catcher status   catcher help [agent]
catcher send <owner|agent> "<text>" [--scope s] [--data json]        catcher reply <id> "<text>"
catcher ask "<q>" [--choices a,b] [--wait]      catcher confirm "<action>" [--wait]
catcher otp --for <service> [--wait]            catcher grant <from> <to> [scopes] [--approval] [--expires 30d]
catcher revoke --grant <id> | --agent <name>    catcher wait <id>     catcher result <id>
catcher watch --json [--ack]     catcher inbox --json     catcher ack <id..>     catcher log     catcher agents
```

Every command takes `--json`. Exit codes: `0` ok · `1` error · `2` usage · `3` pending · `4` timeout or expired code ·
`5` denied by the owner · `6` not registered / revoked · `7` not allowed (no grant, failed verification).

## How it fits together

| Part                 | What it is                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `crates/catcher-cli` | `catcher` CLI used by agents (Rust, one ~1.6 MB binary)                                         |
| `npm/catcher-cli`    | npm `catcher-cli`: a zero-dependency launcher that fetches and SHA-256-checks the binary        |
| `apps/mobile`        | owner app (iOS / Android, Expo) — holds the owner key, approves, answers, chats                 |
| `apps/server`        | relay: Cloudflare Worker + D1 mailbox, Durable Object for realtime signals, Expo push           |
| `apps/server/public` | the website at catcher.bang9.dev: landing, docs, `agent.md`, `install.sh`, `/r` link page       |
| `packages/protocol`  | keys, signed statements, encrypted envelopes, grant policy — shared by the relay, app and tests |
| `packages/client`    | agent and owner API clients (TypeScript)                                                        |

The relay is intentionally thin: it authenticates requests, applies cheap pre-filters, stores ciphertext and signals
listeners. Agents and the phone do the verification and keep the history (`~/.catcher` and the app's local store),
and the relay deletes envelopes once both sides have them.

## Security

- Protocol and threat model: [docs/protocol.md](docs/protocol.md), [docs/threat-model.md](docs/threat-model.md)
- Release binaries are built in GitHub Actions, listed in `SHA256SUMS` and attested:
  `gh attestation verify catcher-<target> --repo bang9/catcher`
- Reporting a vulnerability: [SECURITY.md](SECURITY.md)

## Development

```sh
pnpm install
cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test
pnpm e2e        # local relay (wrangler dev) + headless owner + two CLI agents
pnpm --filter @catcher/server dev   # relay and website on http://localhost:8787
```

Releasing the CLI: bump `crates/catcher-cli/Cargo.toml`, push a `cli-v<version>` tag. The release workflow builds
macOS (arm64, x64), Linux (x64, arm64, static musl) and Windows (x64) binaries, publishes a GitHub Release and the npm
launcher with provenance.

Code style: oxlint + oxfmt, single quotes, no ternaries, pnpm only. No secrets in the repo — deploy values come from
CI environment secrets (see `.github/workflows/deploy-relay.yml`).

## License

[Apache-2.0](LICENSE)
