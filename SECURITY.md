# Security policy

catcher carries approvals, one-time codes and agent-to-agent requests, so security reports get priority.

## Reporting

Please **do not open a public issue** for a vulnerability. Use GitHub's private reporting:
**Security → Report a vulnerability** on this repository. Include what you found, how to reproduce it, and the impact
you expect. You will get an acknowledgement within 3 days.

In scope: the protocol (`packages/protocol`), the relay (`apps/server`), the CLI (`crates/catcher-cli`), the owner app
(`apps/mobile`), and the deployed relay at `catcher.bang9.dev` (test against your own owner account only; no load
testing).

## What the design promises

See [docs/threat-model.md](docs/threat-model.md). In short: the relay cannot read message content, cannot forge
messages, certificates, grants, approvals or answers, and cannot hide a revocation or a dropped message without
agents or the owner noticing. Breaking any of those is a vulnerability.

## Secrets in this repository

This is a public repository. It must never contain keys, tokens, account ids or signing material. CI runs gitleaks on
every push. Deploy values live in GitHub environment secrets. If you spot something that looks like a secret, report
it privately as above.
