# pi-compact-transcript

A compact transcript extension for [pi](https://pi.dev):

- Collapses hidden thinking blocks into `Thinking...` and consecutive thinking blocks into `Thinking... (Nx)`.
- Shows only real collapsed thinking labels/counters; it does not invent next-step prose.
- Collapses tool calls/results into one-line previews, including custom/external tools added by other extensions.
- Consecutive non-mutating tool uses are summarized by count and kind, e.g. `Used 7 tools: 4 read, 2 grep, 1 bash · latest read src/foo.ts`.
- Mutating tools (`edit`, `write`, configured mutation tools, and destructive-looking `bash` commands) stay visible as transcript anchors and break tool bursts.
- Failed tools stay visible by default so errors are not hidden.
- Expanded tool output still falls back to pi's original renderer, so you can use pi's normal tool expansion when details matter.
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

## Commands

```text
/compact-transcript              # open the settings-style panel
/compact-transcript status       # same as above
/compact-transcript disabled|balanced|aggressive|debug
/compact-transcript custom-tools on|off
/compact-transcript failed on|off
/compact-transcript bash-mutations on|off
/compact-transcript always-show <tool[,tool]|/regex/|clear>
/compact-transcript mutation-tools <tool[,tool]|/regex/|clear>
/compact-transcript template <tool|/regex/> <template|clear>
```

In interactive pi, `/compact-transcript` opens a focused settings-style panel in the editor area instead of writing status text into the transcript or footer. Press `Enter`/`Space` to toggle values, edit list/template rows inline, and `Esc` to close it.

Modes:

- `balanced` (default): compact non-mutating bursts, keep mutations/failures visible, and preserve normal hidden-thinking markers.
- `aggressive`: shorter previews, custom tool compaction enabled, and coalesced thinking-only markers.
- `debug`: compact rows but do not hide earlier burst rows; useful when tuning rules.
- `disabled`: fully disable compact-transcript rendering for future rows and clear any compact-transcript footer status. (`off` is accepted as a legacy alias.)

Preview templates support `{name}`, `{args}`, top-level argument names like `{path}` and `{command}`, and nested fields like `{arg.query.text}`. In the panel, edit templates as semicolon-separated `tool=template` pairs.

Examples:

```text
/compact-transcript always-show ask_user_question,/^deploy_/
/compact-transcript mutation-tools db_query,kubectl
/compact-transcript template fetch_content fetch {url}
```

## Notes

This extension changes display only. Tool execution is still handled by pi and any other extensions that registered or override tools.

For built-in and extension tools, compact rendering uses pi's public exported TUI components where available. The cross-tool burst compaction and consecutive-thinking coalescing still rely on pi's current TUI component internals, so if pi changes those internals in a future release, the extension falls back to pi's normal rendering behavior for the affected rows.
