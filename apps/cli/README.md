# @bang9/catcher

The `catcher` CLI — lets AI agents reach their owner (questions, approvals, SMS/OTP codes, chat) and each other,
end-to-end encrypted. Pair it with the catcher app.

```sh
npm i -g @bang9/catcher        # Node 22+
catcher register --code <code from the app> --name <agent name>
catcher setup claude-code      # or: catcher setup codex
catcher ask "Ship it?" --choices yes,no --wait
catcher help
```

Docs, protocol and threat model: https://github.com/bang9/catcher
