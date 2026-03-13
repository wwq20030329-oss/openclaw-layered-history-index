const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const pluginPath = path.join(__dirname, "..", "index.cjs");
const pluginSource =
  fs.readFileSync(pluginPath, "utf8") +
  "\nmodule.exports.__test = { buildPromptContext, mergeConfig, captureHistory };\n";

function loadPluginTestApi(fetchImpl) {
  const moduleObj = { exports: {} };
  vm.runInNewContext(
    pluginSource,
    {
      require,
      module: moduleObj,
      exports: moduleObj.exports,
      __dirname: path.dirname(pluginPath),
      __filename: pluginPath,
      process,
      console,
      Buffer,
      setTimeout,
      clearTimeout,
      AbortSignal,
      fetch: fetchImpl,
      Response,
    },
    { filename: pluginPath },
  );
  return moduleObj.exports.__test;
}

async function makeStateDir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "layered-history-index-test-"));
}

async function setupAgentState(stateDir, agentId, extra = {}) {
  const agentDir = path.join(stateDir, "agents", agentId, "agent");
  const sessionsDir = path.join(stateDir, "agents", agentId, "sessions");
  await fsp.mkdir(path.join(agentDir, "history"), { recursive: true });
  await fsp.mkdir(sessionsDir, { recursive: true });

  const models = {
    providers: {
      "minimax-portal": {
        baseUrl: "https://api.minimaxi.com/anthropic",
        api: "anthropic-messages",
        authHeader: true,
        apiKey: "minimax-oauth",
        models: [
          { id: "MiniMax-M2.5", api: "anthropic-messages" },
          { id: "MiniMax-M2.5-highspeed", api: "anthropic-messages" },
        ],
      },
    },
  };

  const authProfiles = {
    version: 1,
    profiles: {
      "minimax-portal:default": {
        type: "oauth",
        provider: "minimax-portal",
        access: "test-access-token",
      },
    },
  };

  await fsp.writeFile(path.join(agentDir, "models.json"), JSON.stringify(models, null, 2));
  await fsp.writeFile(path.join(agentDir, "auth-profiles.json"), JSON.stringify(authProfiles, null, 2));

  if (extra.timeline) {
    await fsp.writeFile(path.join(agentDir, "history", "timeline.md"), extra.timeline);
  }
  if (extra.decisions) {
    await fsp.writeFile(path.join(agentDir, "history", "decisions.md"), extra.decisions);
  }
  if (extra.tsidMap) {
    await fsp.writeFile(
      path.join(agentDir, "history", "tsid-session-map.json"),
      JSON.stringify(extra.tsidMap, null, 2),
    );
  }
  if (extra.sessions) {
    for (const [sessionId, text] of Object.entries(extra.sessions)) {
      await fsp.writeFile(path.join(sessionsDir, `${sessionId}.jsonl`), text);
    }
  }

  return { agentDir, sessionsDir };
}

function makeConfig(agentId) {
  return {
    models: {
      providers: {
        "minimax-portal": {
          baseUrl: "https://api.minimaxi.com/anthropic",
          api: "anthropic-messages",
          authHeader: true,
          apiKey: "minimax-oauth",
          models: [
            { id: "MiniMax-M2.5", api: "anthropic-messages" },
            { id: "MiniMax-M2.5-highspeed", api: "anthropic-messages" },
          ],
        },
      },
    },
    agents: {
      defaults: {
        model: {
          primary: "minimax-portal/MiniMax-M2.5",
        },
      },
      list: [
        {
          id: agentId,
          agentDir: path.join(process.env.__TEST_STATE_DIR__, "agents", agentId, "agent"),
          model: "minimax-portal/MiniMax-M2.5",
        },
      ],
    },
  };
}

test("does not trigger recall for runtime timestamps or IP addresses", async () => {
  const stateDir = await makeStateDir();
  process.env.__TEST_STATE_DIR__ = stateDir;
  const agentId = "normal-agent";
  const plugin = loadPluginTestApi(async () => {
    throw new Error("fetch should not be called");
  });
  await setupAgentState(stateDir, agentId, {
    timeline:
      "- 20260313070101 | OpenClaw Web部署配置整理\n- 20260313070109 | Nginx反代与证书配置确认\n",
  });

  const config = makeConfig(agentId);
  const options = plugin.mergeConfig({
    alwaysLoadL0: false,
    captureWithLlm: false,
    llmRouting: true,
  });
  const api = {
    config,
    runtime: {
      state: { resolveStateDir: () => stateDir },
      modelAuth: {},
    },
  };

  const timestampOnly = await plugin.buildPromptContext(
    api,
    options,
    { prompt: "[Fri 2026-03-13 07:08 GMT+8] 现在只回复 ok。" },
    { agentId, sessionId: "sess-1", sessionKey: `agent:${agentId}:main` },
  );
  const withIp = await plugin.buildPromptContext(
    api,
    options,
    { prompt: "[Fri 2026-03-13 07:08 GMT+8] 打开 http://127.0.0.1:18789/health 看一下" },
    { agentId, sessionId: "sess-2", sessionKey: `agent:${agentId}:main` },
  );

  assert.equal(timestampOnly, undefined);
  assert.equal(withIp, undefined);

  await fsp.rm(stateDir, { recursive: true, force: true });
  delete process.env.__TEST_STATE_DIR__;
});

test("captures L0 and L1 using local auth fallback when runtime model auth is unavailable", async () => {
  const stateDir = await makeStateDir();
  process.env.__TEST_STATE_DIR__ = stateDir;
  const agentId = "capture-agent";
  let authHeader = "";
  const plugin = loadPluginTestApi(async (_url, init = {}) => {
    authHeader = init.headers.Authorization;
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: [
              "[L0]",
              "OpenClaw部署配置归档",
              "",
              "[L1]",
              "- 部署目录 /srv/openclaw/app",
              "- 重启命令 pm2 restart openclaw-web",
              "- Nginx端口 8317",
            ].join("\n"),
          },
        ],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  await setupAgentState(stateDir, agentId);
  const config = makeConfig(agentId);
  const options = plugin.mergeConfig({
    captureWithLlm: true,
  });
  const api = {
    config,
    runtime: {
      state: { resolveStateDir: () => stateDir },
      modelAuth: {},
    },
  };

  await plugin.captureHistory(
    api,
    options,
    {
      success: true,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "请记录部署目录 /srv/openclaw/app、重启命令 pm2 restart openclaw-web 和 Nginx 端口 8317。",
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "已记录：部署目录 /srv/openclaw/app，重启命令 pm2 restart openclaw-web，Nginx 端口 8317。",
            },
          ],
        },
      ],
    },
    { agentId, sessionId: "capture-session", sessionKey: `agent:${agentId}:main` },
  );

  const timeline = await fsp.readFile(
    path.join(stateDir, "agents", agentId, "agent", "history", "timeline.md"),
    "utf8",
  );
  const decisions = await fsp.readFile(
    path.join(stateDir, "agents", agentId, "agent", "history", "decisions.md"),
    "utf8",
  );

  assert.equal(authHeader, "Bearer test-access-token");
  assert.match(timeline, /OpenClaw部署配置归档/);
  assert.match(decisions, /部署目录 \/srv\/openclaw\/app/);
  assert.match(decisions, /重启命令 pm2 restart openclaw-web/);
  assert.match(decisions, /Nginx端口 8317/);

  await fsp.rm(stateDir, { recursive: true, force: true });
  delete process.env.__TEST_STATE_DIR__;
});

test("uses layered routing for vague recall, fact recall, and full replay recall", async () => {
  const stateDir = await makeStateDir();
  process.env.__TEST_STATE_DIR__ = stateDir;
  const agentId = "route-agent";
  const routeModels = [];
  const plugin = loadPluginTestApi(async (_url, init = {}) => {
    const body = JSON.parse(init.body);
    routeModels.push(body.model);
    const prompt = String(body.messages?.[0]?.content || "");
    const responseText = prompt.includes("把上次 nginx 那次完整对话调出来")
      ? '{"loadL1":true,"loadL2":true,"reason":"full replay","l1Dates":["2026-03-13"]}'
      : '{"loadL1":true,"loadL2":false,"reason":"fact lookup","l1Dates":["2026-03-13"]}';
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: responseText }],
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  await setupAgentState(stateDir, agentId, {
    timeline:
      [
        "- 20260312070101 | Docker 构建缓存排查",
        "- 20260313070101 | OpenClaw Web部署配置整理",
        "- 20260313070109 | Nginx反代与证书配置确认",
        "",
      ].join("\n"),
    decisions: [
      "## 2026-03-12",
      "",
      "- [20260312070101] Docker命令: docker build -t openclaw:test .",
      "",
      "## 2026-03-13",
      "",
      "- [20260313070101] 部署目录: /srv/openclaw/app",
      "- [20260313070101] 重启命令: pm2 restart openclaw-web",
      "- [20260313070109] Nginx端口: 8317",
      "- [20260313070109] Nginx配置: /etc/nginx/conf.d/openclaw.conf",
      "",
    ].join("\n"),
    tsidMap: {
      "20260312070101": "sess-b",
      "20260313070101": "sess-a",
      "20260313070109": "sess-a",
    },
    sessions: {
      "sess-a": [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "[Fri 2026-03-13 06:58 GMT+8] 先记一下 docker build 需要 --no-cache。",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "收到，docker build --no-cache 这个我先记着。",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "[Fri 2026-03-13 07:01 GMT+8] 请记录部署目录 /srv/openclaw/app、重启命令 pm2 restart openclaw-web、Nginx 端口 8317 和配置文件 /etc/nginx/conf.d/openclaw.conf。",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "已记录：部署目录 /srv/openclaw/app，重启命令 pm2 restart openclaw-web，Nginx 端口 8317，配置文件 /etc/nginx/conf.d/openclaw.conf。",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "[Fri 2026-03-13 07:03 GMT+8] UI 颜色后面改成蓝色系。",
              },
            ],
          },
        }),
        JSON.stringify({
          type: "message",
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text: "好的，UI 颜色改成蓝色系。",
              },
            ],
          },
        }),
      ].join("\n"),
      "sess-b": [
        JSON.stringify({
          type: "message",
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "[Thu 2026-03-12 07:01 GMT+8] docker build 那次先这样。",
              },
            ],
          },
        }),
      ].join("\n"),
    },
  });

  const config = makeConfig(agentId);
  const options = plugin.mergeConfig({
    alwaysLoadL0: false,
    llmRouting: true,
    captureWithLlm: false,
    routeTimelineEntries: 4,
    routeMaxTokens: 120,
  });
  const api = {
    config,
    runtime: {
      state: { resolveStateDir: () => stateDir },
      modelAuth: {},
    },
  };

  const vague = await plugin.buildPromptContext(
    api,
    options,
    { prompt: "[Fri 2026-03-13 07:08 GMT+8] 之前那个事你还有印象吗？" },
    { agentId, sessionId: "sess-vague", sessionKey: `agent:${agentId}:main` },
  );
  const facts = await plugin.buildPromptContext(
    api,
    options,
    { prompt: "[Fri 2026-03-13 07:08 GMT+8] 之前部署那次说的部署目录、重启命令和 nginx 端口是什么？" },
    { agentId, sessionId: "sess-facts", sessionKey: `agent:${agentId}:main` },
  );
  const full = await plugin.buildPromptContext(
    api,
    options,
    { prompt: "[Fri 2026-03-13 07:08 GMT+8] 把上次 nginx 那次完整对话调出来，我要确认端口和配置文件。" },
    { agentId, sessionId: "sess-full", sessionKey: `agent:${agentId}:main` },
  );
  const routeTrace = await fsp.readFile(
    path.join(stateDir, "agents", agentId, "agent", "history", "route-trace.jsonl"),
    "utf8",
  );
  const routeEntries = routeTrace
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  assert.match(vague.prependContext, /<conversation_timeline>/);
  assert.doesNotMatch(vague.prependContext, /<key_decisions>/);
  assert.doesNotMatch(vague.prependContext, /<full_conversation>/);

  assert.match(facts.prependContext, /<conversation_timeline>/);
  assert.match(facts.prependContext, /<key_decisions>/);
  assert.doesNotMatch(facts.prependContext, /<full_conversation>/);
  assert.match(facts.prependContext, /部署目录: \/srv\/openclaw\/app/);
  assert.match(facts.prependContext, /Nginx端口: 8317/);
  assert.doesNotMatch(facts.prependContext, /docker build -t openclaw:test/);

  assert.match(full.prependContext, /<conversation_timeline>/);
  assert.match(full.prependContext, /<key_decisions>/);
  assert.match(full.prependContext, /<full_conversation>/);
  assert.match(full.prependContext, /按问题缩窄后的相关历史对话片段/);
  assert.match(full.prependContext, /部署目录 \/srv\/openclaw\/app/);
  assert.match(full.prependContext, /配置文件 \/etc\/nginx\/conf\.d\/openclaw\.conf/);
  assert.doesNotMatch(full.prependContext, /docker build --no-cache/);
  assert.doesNotMatch(full.prependContext, /UI 颜色改成蓝色系/);

  assert.ok(routeModels.every((entry) => entry === "MiniMax-M2.5-highspeed"));
  assert.equal(routeEntries.length, 3);
  assert.deepEqual(routeEntries[1].route.l1Dates, ["2026-03-13"]);
  assert.equal(routeEntries[1].resolved.loadedL1, true);
  assert.equal(routeEntries[1].resolved.loadedL2, false);
  assert.equal(routeEntries[2].resolved.loadedL2, true);

  await fsp.rm(stateDir, { recursive: true, force: true });
  delete process.env.__TEST_STATE_DIR__;
});
