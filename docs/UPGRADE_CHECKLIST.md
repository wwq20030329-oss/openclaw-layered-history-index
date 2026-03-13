# OpenClaw Upgrade Checklist

Use this checklist whenever OpenClaw itself is upgraded and you want to confirm that `layered-history-index` still works.

## Verified Baseline

- Plugin repo version: `0.1.0`
- Verified plugin commit: `77721d4`
- Verified OpenClaw runtime observed during development: `2026.3.7`

## High-Risk Compatibility Seams

These are the parts most likely to break after an OpenClaw update.

1. Plugin hook contract
   - `before_prompt_build`
   - `agent_end`
   - Risk: event or ctx payload shape changes

2. Runtime services
   - `api.runtime.state.resolveStateDir(...)`
   - `api.runtime.modelAuth.resolveApiKeyForProvider(...)`
   - Risk: runtime auth helpers move or return different fields

3. Agent state layout
   - `agents/<agentId>/agent`
   - `agents/<agentId>/sessions/*.jsonl`
   - Risk: session storage path or naming changes

4. Session transcript schema
   - JSONL entries with `type: "message"`
   - `message.role`
   - `message.content`
   - Risk: `L2` transcript parsing stops matching

5. Model/provider config layout
   - `models.json`
   - `auth-profiles.json`
   - Risk: local fallback auth can no longer resolve provider tokens

## Before You Upgrade

1. Record current versions.
   - `openclaw --version`
   - `git -C /path/to/openclaw-layered-history-index rev-parse --short HEAD`

2. Confirm the current install is healthy.
   - `openclaw config validate`
   - `openclaw plugins info layered-history-index`
   - `openclaw health`

3. Keep a copy of your current plugin files.
   - `~/.openclaw/extensions/layered-history-index/index.cjs`
   - `~/.openclaw/extensions/layered-history-index/openclaw.plugin.json`

4. Keep one recent agent history snapshot if the memory data matters.
   - `history/timeline.md`
   - `history/decisions.md`
   - `history/tsid-session-map.json`
   - `history/route-trace.jsonl`

## After You Upgrade OpenClaw

Run these checks in order.

1. Validate config and plugin loading.

```bash
openclaw config validate
openclaw plugins info layered-history-index
openclaw plugins list
```

2. Run the plugin repo tests.

```bash
cd /path/to/openclaw-layered-history-index
npm test
```

3. Restart the gateway and verify health.

```bash
openclaw gateway restart
openclaw health
```

4. Confirm the plugin still loads.
   - Expected: `layered-history-index` shows `loaded`

## Manual Smoke Test

Use one agent that already has some prior history. Then test all three retrieval tiers.

1. Normal chat
   - Prompt: `现在只回复 ok`
   - Expected: no unwanted history recall

2. Vague recall
   - Prompt: `之前那个事你还有印象吗？`
   - Expected: `L0` only

3. Fact recall
   - Prompt: `上次那次的部署目录、命令和端口是什么？`
   - Expected: `L0 + L1`

4. Full replay recall
   - Prompt: `把上次那段完整对话调出来，我要核对原话。`
   - Expected: `L0 + L1 + L2`

## Files To Inspect

If something feels wrong, inspect these files first.

1. Local plugin install
   - `~/.openclaw/extensions/layered-history-index/index.cjs`
   - `~/.openclaw/extensions/layered-history-index/openclaw.plugin.json`

2. Agent memory outputs
   - `~/.openclaw/agents/<agentId>/agent/history/timeline.md`
   - `~/.openclaw/agents/<agentId>/agent/history/decisions.md`
   - `~/.openclaw/agents/<agentId>/agent/history/tsid-session-map.json`
   - `~/.openclaw/agents/<agentId>/agent/history/route-trace.jsonl`

3. Raw sessions
   - `~/.openclaw/agents/<agentId>/sessions/*.jsonl`

## Fast Triage Guide

If this symptom appears, check these areas first.

1. Plugin no longer loads
   - Check plugin manifest validity
   - Check whether hook names changed

2. `L1` and `L2` stop appearing
   - Check `before_prompt_build`
   - Check `route-trace.jsonl`
   - Check session file layout and transcript schema

3. Capturing stops writing new memory
   - Check `agent_end`
   - Check `timeline.md` and `decisions.md`
   - Check whether event messages still contain `role` and `content`

4. Summary/routing model calls fail
   - Check provider config
   - Check runtime auth helper
   - Check local `auth-profiles.json` fallback

5. Wrong history gets recalled
   - Check `route-trace.jsonl` for chosen `l1Dates`
   - Check `timeline.md` date coverage
   - Check whether prompt wording triggered strong recall

## Rollback

If the new OpenClaw version breaks the plugin and you need a quick recovery:

1. Restore the previous plugin files in `~/.openclaw/extensions/layered-history-index/`
2. Revert to the previous OpenClaw version if needed
3. Restart the gateway
4. Re-run `openclaw health`

## Maintenance Notes

- Prefer fixing compatibility in the plugin instead of forking OpenClaw core.
- Keep `npm test` green before and after OpenClaw upgrades.
- When an upgrade changes runtime payloads, update tests first, then patch plugin code.
