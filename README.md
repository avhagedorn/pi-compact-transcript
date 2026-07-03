# pi-compact-transcript

A compact transcript extension for [pi](https://pi.dev):

- Collapses hidden thinking blocks into `Thinking...` and consecutive thinking blocks into `Thinking... (Nx)`.
- Adds a short, visible next-step summary to collapsed thinking rows without exposing raw chain-of-thought.
- Collapses built-in tool calls/results into one-line previews.
- Consecutive tool uses in the same agent run are summarized as `Used N tools <latest tool preview>`.
- Minimizes vertical space so long agent runs do not scroll away as quickly.

## Install from GitHub

```bash
pi install git:github.com/avhagedorn/pi-compact-transcript
```

Or try it for one run:

```bash
pi -e git:github.com/avhagedorn/pi-compact-transcript
```

Reload or restart pi after installing:

```text
/reload
```

## Install from npm

Once published to npm:

```bash
pi install npm:pi-compact-transcript
```

## Recommended settings

The extension works best with hidden thinking and no output padding:

```json
{
  "hideThinkingBlock": true,
  "outputPad": 0
}
```

Set these in `~/.pi/agent/settings.json`, or use `/settings` in pi.

## Notes

This extension overrides the built-in tool renderers for `bash`, `read`, `write`, `edit`, `grep`, `find`, and `ls`. It delegates execution to pi's original built-in tools; only display is changed.

The consecutive-thinking collapse and compact self-rendered tool rows use pi's current internal TUI components. If pi changes those internal paths in a future release, the extension falls back to the normal hidden-thinking/tool rendering behavior.
