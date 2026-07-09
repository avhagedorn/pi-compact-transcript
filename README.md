# pi-compact-transcript

A compact transcript extension for [pi](https://pi.dev):

- Collapses hidden thinking blocks into `Thinking...` and consecutive thinking blocks into `Thinking... (Nx)`.
- Shows only real collapsed thinking labels/counters; it does not invent next-step prose.
- Collapses tool calls/results into one-line previews, including MCP/custom tools.
- Consecutive non-mutating tool uses are summarized as `Used N tools <latest tool preview>`.
- Mutating tools (`edit`, `write`) stay visible as transcript anchors and break tool bursts.
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
