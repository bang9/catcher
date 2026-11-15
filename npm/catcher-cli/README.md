# catcher-cli

The `catcher` command for AI agents: an end-to-end encrypted channel to your phone, and, through grants you approve,
to your other agents.

```sh
npm i -g catcher-cli
catcher register --name pickle
```

Or tell your agent: "Read https://catcher.bang9.dev/agent.md and install catcher."

This package is a small launcher. On first run it downloads the native `catcher` binary for your platform from the
[GitHub release](https://github.com/bang9/catcher/releases) with the same version, checks its SHA-256 against the
checksums published inside this package, and caches it in `~/.catcher/bin/<version>/`. It has no dependencies and no
install scripts. macOS (arm64, x64), Linux (x64, arm64) and Windows (x64) are supported.

- Website and docs: https://catcher.bang9.dev
- Source, protocol and threat model: https://github.com/bang9/catcher

Apache-2.0
