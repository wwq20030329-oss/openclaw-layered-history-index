# OpenClaw Layered History Index

Layered conversation memory plugin for OpenClaw.

It adds:

- `L0` timeline recall
- `L1` decisions/config/command recall
- `L2` full conversation recall
- lightweight routing so vague recall uses less context than full replay
- date-scoped `L1` routing to keep decision recall tighter
- optional route trace logging for debugging and tuning

## Features

- Works as a normal OpenClaw plugin
- Keeps current OpenClaw core untouched
- Writes layered history per agent under `agent/history/`
- Uses `L0` for vague recall
- Uses `L0 + L1` for facts like paths, commands, ports, config, URLs
- Uses `L0 + L1 + L2` for full transcript recall
- Lets the route model pick specific `L1` dates from the timeline before loading decisions
- Narrows `L2` to relevant turns instead of dumping the full tail of a session
- Handles current OpenClaw runtime quirks such as missing runtime auth and timestamp/IP false positives

## Files Written

For each agent, the plugin writes:

- `history/timeline.md`
- `history/decisions.md`
- `history/tsid-session-map.json`
- `history/route-trace.jsonl` when route tracing is enabled

## Install

OpenClaw does not install plugins directly from a GitHub URL.

Clone this repo locally, then install with `--link`:

```bash
git clone <this-repo-url>
cd openclaw-layered-history-index
openclaw plugins install -l .
```

Or install from a release archive:

```bash
openclaw plugins install ./openclaw-layered-history-index.tgz
```

## Tested Flow

- Normal chat: no forced history injection
- Vague recall: `L0`
- Fact recall: `L0 + L1`
- Full replay recall: `L0 + L1 + L2`

## Config

Example:

```json
{
  "plugins": {
    "entries": {
      "layered-history-index": {
        "enabled": true,
        "config": {
          "alwaysLoadL0": false,
          "captureWithLlm": true,
          "llmRouting": true,
          "l0PromptEntries": 20,
          "l1PromptChars": 2500,
          "l1MaxLines": 4,
          "l2PromptChars": 6000,
          "l2MaxSessions": 1,
          "recentDaysForRecall": 2,
          "recentTsidsForRecall": 2,
          "persistRouteTrace": true,
          "routeTraceMaxEntries": 200,
          "routeTimelineEntries": 4,
          "routeMaxTokens": 120
        }
      }
    }
  }
}
```

## Notes

- This repo ships only the plugin source and manifest.
- It does not include user config, auth profiles, agent state, or conversation data.
- The plugin reads the local agent's runtime/model config on the target machine.
- `route-trace.jsonl` is capped and append-only so you can inspect why a prompt loaded `L0`, `L1`, or `L2`.
- Each route trace entry now includes estimated `actual`, `baseline`, and `saved` token counts.

## Development

Run tests locally:

```bash
npm test
```

CI runs the same test suite on pushes and pull requests.

Analyze token savings from a route trace:

```bash
npm run analyze:trace -- ~/.openclaw/agents/main/agent/history/route-trace.jsonl
```

You can also point it at a directory and it will scan recursively for `route-trace.jsonl`.

For OpenClaw version upgrades, use the compatibility checklist in [docs/UPGRADE_CHECKLIST.md](/Users/wwq/openclaw-layered-history-index/docs/UPGRADE_CHECKLIST.md).

## License

MIT
