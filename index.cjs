"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const HISTORY_DIR = "history";
const TIMELINE_FILE = "timeline.md";
const DECISIONS_FILE = "decisions.md";
const TSID_MAP_FILE = "tsid-session-map.json";
const ROUTE_TRACE_FILE = "route-trace.jsonl";
const SUMMARY_FETCH_TIMEOUT_MS = 30000;

const DEFAULT_CONFIG = {
  alwaysLoadL0: true,
  captureWithLlm: true,
  llmRouting: true,
  routeModel: "",
  l0PromptEntries: 60,
  maxTimelineEntries: 300,
  l1PromptChars: 6000,
  l1MaxLines: 8,
  l2PromptChars: 10000,
  l2MaxSessions: 2,
  l2MaxMessagesPerSession: 30,
  l2MaxCharsPerMessage: 1500,
  captureMaxMessages: 24,
  captureMaxCharsPerMessage: 1600,
  recentDaysForRecall: 3,
  recentTsidsForRecall: 4,
  routeMaxTokens: 120,
  routeTimelineEntries: 6,
  persistRouteTrace: true,
  routeTraceMaxEntries: 200,
  summaryMaxTokens: 700,
  recallKeywords: [
    "之前",
    "上次",
    "上回",
    "前面",
    "昨天",
    "前天",
    "那次",
    "那天",
    "历史",
    "回顾",
    "还记得",
    "记不记得",
    "我们说过",
    "你说过",
    "聊过",
    "提过",
    "当时",
  ],
  strongRecallKeywords: [
    "完整对话",
    "原话",
    "原文",
    "完整过程",
    "详细过程",
    "聊天记录",
    "完整记录",
    "贴出来",
    "调出来",
    "逐字",
    "全文",
    "当时怎么说",
  ],
};

const writeQueues = new Map();

function mergeConfig(pluginConfig) {
  const merged = { ...DEFAULT_CONFIG };
  if (!pluginConfig || typeof pluginConfig !== "object" || Array.isArray(pluginConfig)) {
    return merged;
  }
  for (const [key, value] of Object.entries(pluginConfig)) {
    if (!(key in merged)) {
      continue;
    }
    if (Array.isArray(merged[key])) {
      merged[key] = Array.isArray(value)
        ? value.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
        : merged[key];
      continue;
    }
    if (typeof merged[key] === "number") {
      merged[key] = Number.isFinite(value) ? Number(value) : merged[key];
      continue;
    }
    if (typeof merged[key] === "boolean") {
      merged[key] = value === true || value === false ? value : merged[key];
      continue;
    }
    if (typeof merged[key] === "string") {
      merged[key] = typeof value === "string" ? value.trim() : merged[key];
    }
  }
  if (typeof pluginConfig.summaryModel === "string" && pluginConfig.summaryModel.trim()) {
    merged.summaryModel = pluginConfig.summaryModel.trim();
  }
  if (typeof pluginConfig.routeModel === "string" && pluginConfig.routeModel.trim()) {
    merged.routeModel = pluginConfig.routeModel.trim();
  }
  return merged;
}

function getHistoryDir(agentDir) {
  return path.join(agentDir, HISTORY_DIR);
}

function getTimelinePath(agentDir) {
  return path.join(getHistoryDir(agentDir), TIMELINE_FILE);
}

function getDecisionsPath(agentDir) {
  return path.join(getHistoryDir(agentDir), DECISIONS_FILE);
}

function getTsidMapPath(agentDir) {
  return path.join(getHistoryDir(agentDir), TSID_MAP_FILE);
}

function getRouteTracePath(agentDir) {
  return path.join(getHistoryDir(agentDir), ROUTE_TRACE_FILE);
}

function resolveAgentId(ctx) {
  if (typeof ctx?.agentId === "string" && ctx.agentId.trim()) {
    return ctx.agentId.trim();
  }
  const sessionKey = typeof ctx?.sessionKey === "string" ? ctx.sessionKey.trim() : "";
  const direct = sessionKey.split(":")[0];
  return direct || "main";
}

function resolveAgentDir(cfg, ctx, stateDir) {
  const agentId = resolveAgentId(ctx);
  const configuredAgents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  const match = configuredAgents.find((entry) => {
    return typeof entry?.id === "string" && entry.id.trim().toLowerCase() === agentId.toLowerCase();
  });
  const configuredDir =
    match && typeof match.agentDir === "string" && match.agentDir.trim() ? match.agentDir.trim() : "";
  return configuredDir || path.join(stateDir, "agents", agentId, "agent");
}

function resolveSessionsDir(agentDir) {
  return path.join(path.dirname(agentDir), "sessions");
}

function stripTrailingSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function stripTrailingV1(value) {
  return stripTrailingSlash(value).replace(/\/v1$/, "");
}

async function ensureHistoryDir(agentDir) {
  await fsp.mkdir(getHistoryDir(agentDir), { recursive: true });
}

async function safeReadText(filePath) {
  try {
    return await fsp.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

async function safeReadJson(filePath) {
  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeJson(filePath, value) {
  await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function loadAgentModelsConfig(agentDir) {
  if (!agentDir) {
    return {};
  }
  return safeReadJson(path.join(agentDir, "models.json"));
}

function formatDatePart(date) {
  return String(date).padStart(2, "0");
}

function formatTsid(date) {
  return [
    date.getFullYear(),
    formatDatePart(date.getMonth() + 1),
    formatDatePart(date.getDate()),
    formatDatePart(date.getHours()),
    formatDatePart(date.getMinutes()),
    formatDatePart(date.getSeconds()),
  ].join("");
}

function formatDateKey(date) {
  return [
    date.getFullYear(),
    formatDatePart(date.getMonth() + 1),
    formatDatePart(date.getDate()),
  ].join("-");
}

function dateFromTsid(tsid) {
  if (typeof tsid !== "string" || tsid.length < 8) {
    return null;
  }
  return `${tsid.slice(0, 4)}-${tsid.slice(4, 6)}-${tsid.slice(6, 8)}`;
}

function normalizeDateKey(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  const compactMatch = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compactMatch) {
    return `${compactMatch[1]}-${compactMatch[2]}-${compactMatch[3]}`;
  }
  const dateMatch = text.match(/^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?$/);
  if (!dateMatch) {
    return "";
  }
  const monthNumber = Number(dateMatch[2]);
  const dayNumber = Number(dateMatch[3]);
  if (!isValidMonthDay(monthNumber, dayNumber)) {
    return "";
  }
  return `${dateMatch[1]}-${formatDatePart(monthNumber)}-${formatDatePart(dayNumber)}`;
}

async function generateUniqueTsid(agentDir) {
  const map = await safeReadJson(getTsidMapPath(agentDir));
  let date = new Date();
  let tsid = formatTsid(date);
  while (Object.prototype.hasOwnProperty.call(map, tsid)) {
    date = new Date(date.getTime() + 1000);
    tsid = formatTsid(date);
  }
  return tsid;
}

function extractTextBlocks(content) {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "output_text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "input_text" && typeof block.text === "string") {
        return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

function stripInjectedRecallContext(text) {
  return String(text || "")
    .replace(/<conversation_timeline>[\s\S]*?<\/conversation_timeline>\s*/gi, "")
    .replace(/<key_decisions>[\s\S]*?<\/key_decisions>\s*/gi, "")
    .replace(/<full_conversation>[\s\S]*?<\/full_conversation>\s*/gi, "")
    .trim();
}

function collectConversationMessages(messages, options) {
  const maxMessages = options?.maxMessages ?? DEFAULT_CONFIG.captureMaxMessages;
  const maxCharsPerMessage =
    options?.maxCharsPerMessage ?? DEFAULT_CONFIG.captureMaxCharsPerMessage;
  const lines = [];
  const list = Array.isArray(messages) ? messages : [];
  for (const message of list) {
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = typeof message.role === "string" ? message.role : "";
    if (role !== "user" && role !== "assistant") {
      continue;
    }
    const text = stripInjectedRecallContext(extractTextBlocks(message.content));
    if (!text || text.startsWith("/")) {
      continue;
    }
    lines.push(`[${role}]: ${text.slice(0, maxCharsPerMessage)}`);
  }
  return lines.slice(-maxMessages).join("\n\n");
}

function getLastUserText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!message || typeof message !== "object" || message.role !== "user") {
      continue;
    }
    const text = stripInjectedRecallContext(extractTextBlocks(message.content));
    if (text && !text.startsWith("/")) {
      return text.trim();
    }
  }
  return "";
}

function getLastAssistantText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const message = list[index];
    if (!message || typeof message !== "object" || message.role !== "assistant") {
      continue;
    }
    const text = stripInjectedRecallContext(extractTextBlocks(message.content));
    if (text) {
      return text.trim();
    }
  }
  return "";
}

function sanitizeInlineText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .trim();
}

function fallbackTimelineSummary(messages) {
  const userText = sanitizeInlineText(getLastUserText(messages));
  if (userText) {
    return `${userText.slice(0, 36)}${userText.length > 36 ? "..." : ""}`;
  }
  const assistantText = sanitizeInlineText(getLastAssistantText(messages));
  if (assistantText) {
    return `${assistantText.slice(0, 36)}${assistantText.length > 36 ? "..." : ""}`;
  }
  return "记录了一次对话";
}

function parseModelSpec(modelSpec) {
  if (typeof modelSpec !== "string") {
    return null;
  }
  const trimmed = modelSpec.trim();
  const slashIndex = trimmed.indexOf("/");
  if (slashIndex <= 0 || slashIndex >= trimmed.length - 1) {
    return null;
  }
  return {
    provider: trimmed.slice(0, slashIndex),
    modelId: trimmed.slice(slashIndex + 1),
  };
}

function resolveAgentPrimaryModel(cfg, agentId) {
  const agents = Array.isArray(cfg?.agents?.list) ? cfg.agents.list : [];
  const direct = agents.find((entry) => {
    return typeof entry?.id === "string" && entry.id.trim().toLowerCase() === agentId.toLowerCase();
  });
  const entryModel = typeof direct?.model === "string" ? direct.model : direct?.model?.primary;
  const defaultModel =
    typeof cfg?.agents?.defaults?.model === "string"
      ? cfg.agents.defaults.model
      : cfg?.agents?.defaults?.model?.primary;
  return entryModel || defaultModel || "";
}

function extractProviders(cfgLike) {
  if (!cfgLike || typeof cfgLike !== "object") {
    return {};
  }
  if (cfgLike.models && typeof cfgLike.models === "object" && cfgLike.models.providers) {
    return cfgLike.models.providers || {};
  }
  if (cfgLike.providers && typeof cfgLike.providers === "object") {
    return cfgLike.providers || {};
  }
  return {};
}

function resolveProviderEntry(cfgLike, providerId) {
  const providers = extractProviders(cfgLike);
  if (providers[providerId]) {
    return providers[providerId];
  }
  const lower = providerId.toLowerCase();
  const match = Object.entries(providers).find(([key]) => key.toLowerCase() === lower);
  return match ? match[1] : undefined;
}

async function resolveModelTarget(api, cfg, ctx, modelSpec) {
  const configuredSpec =
    typeof modelSpec === "string" && modelSpec.trim()
      ? modelSpec.trim()
      : resolveAgentPrimaryModel(cfg, resolveAgentId(ctx));
  const parsed = parseModelSpec(configuredSpec);
  if (!parsed) {
    return null;
  }
  const stateDir = api.runtime.state.resolveStateDir(process.env);
  const agentDir = resolveAgentDir(cfg, ctx, stateDir);
  const agentModels = await loadAgentModelsConfig(agentDir);
  const localProviderEntry = resolveProviderEntry(agentModels, parsed.provider);
  const globalProviderEntry = resolveProviderEntry(cfg, parsed.provider);
  const providerEntry = localProviderEntry || globalProviderEntry;
  if (!providerEntry || !providerEntry.baseUrl) {
    return null;
  }
  const modelEntry =
    (Array.isArray(localProviderEntry?.models)
      ? localProviderEntry.models.find((model) => model && model.id === parsed.modelId)
      : undefined) ||
    (Array.isArray(globalProviderEntry?.models)
      ? globalProviderEntry.models.find((model) => model && model.id === parsed.modelId)
      : undefined) ||
    (Array.isArray(providerEntry.models)
      ? providerEntry.models.find((model) => model && model.id === parsed.modelId)
      : undefined);
  return {
    provider: parsed.provider,
    modelId: parsed.modelId,
    providerEntry,
    api: modelEntry?.api || providerEntry.api || globalProviderEntry?.api || "openai-completions",
    agentDir,
    agentModels,
  };
}

function resolveConfiguredHeaders(providerEntry) {
  const headers = {};
  if (!providerEntry || typeof providerEntry !== "object") {
    return headers;
  }
  for (const [name, value] of Object.entries(providerEntry.headers || {})) {
    if (typeof value !== "string") {
      continue;
    }
    if (value.startsWith("secretref-")) {
      continue;
    }
    headers[name] = value;
  }
  return headers;
}

async function resolveAgentAuthToken(agentDir, providerId) {
  if (!agentDir || !providerId) {
    return "";
  }
  const authProfiles = await safeReadJson(path.join(agentDir, "auth-profiles.json"));
  const profiles =
    authProfiles && typeof authProfiles === "object" && authProfiles.profiles && typeof authProfiles.profiles === "object"
      ? authProfiles.profiles
      : {};
  const exactKey = `${providerId}:default`;
  const exact = profiles[exactKey];
  if (exact && typeof exact === "object") {
    const direct = typeof exact.access === "string" ? exact.access.trim() : "";
    if (direct) {
      return direct;
    }
    const apiKey = typeof exact.apiKey === "string" ? exact.apiKey.trim() : "";
    if (apiKey) {
      return apiKey;
    }
  }
  for (const profile of Object.values(profiles)) {
    if (!profile || typeof profile !== "object") {
      continue;
    }
    if (String(profile.provider || "").toLowerCase() !== String(providerId).toLowerCase()) {
      continue;
    }
    const token = typeof profile.access === "string" ? profile.access.trim() : "";
    if (token) {
      return token;
    }
    const apiKey = typeof profile.apiKey === "string" ? profile.apiKey.trim() : "";
    if (apiKey) {
      return apiKey;
    }
  }
  return "";
}

function isPlaceholderApiKey(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) {
    return true;
  }
  if (trimmed.startsWith("secretref-")) {
    return true;
  }
  return /^[a-z0-9_-]*oauth[a-z0-9_-]*$/i.test(trimmed);
}

async function callTextModel(api, cfg, ctx, options, params) {
  const target = await resolveModelTarget(api, cfg, ctx, params?.modelSpec);
  if (!target) {
    return null;
  }
  const authResolver = api?.runtime?.modelAuth?.resolveApiKeyForProvider;
  const auth =
    typeof authResolver === "function"
      ? await authResolver({
          provider: target.provider,
          cfg,
        }).catch(() => null)
      : null;
  let resolvedApiKey = auth && typeof auth.apiKey === "string" ? auth.apiKey.trim() : "";
  if (isPlaceholderApiKey(resolvedApiKey)) {
    const fallbackToken = await resolveAgentAuthToken(target.agentDir, target.provider);
    if (fallbackToken) {
      resolvedApiKey = fallbackToken;
    }
  }
  if (!resolvedApiKey) {
    return null;
  }

  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "layered-history-index",
    ...resolveConfiguredHeaders(target.providerEntry),
  };

  if (target.api === "anthropic-messages") {
    headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
  }

  if (target.providerEntry?.authHeader === true || auth?.mode === "oauth" || auth?.mode === "token") {
    headers.Authorization = headers.Authorization || `Bearer ${resolvedApiKey}`;
  } else if (target.api === "anthropic-messages") {
    headers["x-api-key"] = headers["x-api-key"] || resolvedApiKey;
  } else {
    headers.Authorization = headers.Authorization || `Bearer ${resolvedApiKey}`;
  }

  const systemPrompt = [
    "你是一个技术会话归档助手，只能根据给定对话生成摘要。",
    "输出必须严格是下面格式，不要加解释：",
    "[L0]",
    "一句话极简概括，10-20字，不要时间戳、不要列表符号。",
    "",
    "[L1]",
    "如果本轮出现关键命令、路径、端口、URL、配置项或结论，即使只是记录信息，也要用多行 '- ' 列出；完全没有再输出'无'。",
  ].join("\n");

  const userPrompt = [
    typeof params?.userPrompt === "string" ? params.userPrompt : "",
  ].join("\n").trim();
  const signal =
    typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(SUMMARY_FETCH_TIMEOUT_MS)
      : undefined;

  if (target.api === "anthropic-messages") {
    const response = await fetch(`${stripTrailingV1(target.providerEntry.baseUrl)}/v1/messages`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: target.modelId,
        max_tokens: params?.maxTokens ?? options.summaryMaxTokens,
        system: typeof params?.systemPrompt === "string" ? params.systemPrompt : "",
        messages: [
          {
            role: "user",
            content: userPrompt,
          },
        ],
      }),
    });
    if (!response.ok) {
      return null;
    }
    const data = await response.json().catch(() => null);
    if (!data || !Array.isArray(data.content)) {
      return null;
    }
    return data.content
      .map((block) => {
        if (!block || typeof block !== "object" || block.type !== "text") {
          return "";
        }
        return typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
  }

  const requestVariants = [
    { max_tokens: options.summaryMaxTokens, temperature: 0 },
    { max_completion_tokens: options.summaryMaxTokens, temperature: 0 },
    { max_tokens: options.summaryMaxTokens },
  ];
  for (const extra of requestVariants) {
    const response = await fetch(`${stripTrailingSlash(target.providerEntry.baseUrl)}/chat/completions`, {
      method: "POST",
      headers,
      signal,
      body: JSON.stringify({
        model: target.modelId,
        messages: [
          { role: "system", content: typeof params?.systemPrompt === "string" ? params.systemPrompt : "" },
          { role: "user", content: userPrompt },
        ],
        ...extra,
      }),
    }).catch(() => null);
    if (!response || !response.ok) {
      continue;
    }
    const data = await response.json().catch(() => null);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }
  }
  return null;
}

function resolveSummaryModelSpec(cfg, ctx, options) {
  if (typeof options.summaryModel === "string" && options.summaryModel.trim()) {
    return options.summaryModel.trim();
  }
  return resolveAgentPrimaryModel(cfg, resolveAgentId(ctx));
}

function chooseRouteModelId(primaryModelId, modelIds) {
  const baseId = String(primaryModelId || "").trim();
  if (!baseId) {
    return "";
  }
  const ids = Array.isArray(modelIds) ? modelIds.filter((entry) => typeof entry === "string" && entry.trim()) : [];
  const lowerBase = baseId.toLowerCase();
  const exact = ids.find((entry) => entry === `${baseId}-highspeed`) ||
    ids.find((entry) => entry === `${baseId}-Lightning`) ||
    ids.find((entry) => entry.toLowerCase() === `${lowerBase}-lightning`) ||
    ids.find((entry) => entry.toLowerCase() === `${lowerBase}-highspeed`);
  if (exact) {
    return exact;
  }
  const containsLightning = ids.find((entry) => entry.toLowerCase().startsWith(lowerBase) && entry.toLowerCase().includes("lightning"));
  if (containsLightning) {
    return containsLightning;
  }
  const containsHighspeed = ids.find((entry) => entry.toLowerCase().startsWith(lowerBase) && entry.toLowerCase().includes("highspeed"));
  if (containsHighspeed) {
    return containsHighspeed;
  }
  const same = ids.find((entry) => entry === baseId);
  return same || "";
}

async function resolveRouteModelSpec(api, cfg, ctx, options) {
  if (typeof options.routeModel === "string" && options.routeModel.trim()) {
    return options.routeModel.trim();
  }
  const primarySpec = resolveAgentPrimaryModel(cfg, resolveAgentId(ctx));
  const parsed = parseModelSpec(primarySpec);
  if (!parsed) {
    return "";
  }
  const target = await resolveModelTarget(api, cfg, ctx, primarySpec);
  if (!target) {
    return primarySpec;
  }
  const localProviderEntry = resolveProviderEntry(target.agentModels, parsed.provider);
  const globalProviderEntry = resolveProviderEntry(cfg, parsed.provider);
  const modelIds = [
    ...(Array.isArray(localProviderEntry?.models) ? localProviderEntry.models.map((entry) => entry?.id).filter(Boolean) : []),
    ...(Array.isArray(globalProviderEntry?.models) ? globalProviderEntry.models.map((entry) => entry?.id).filter(Boolean) : []),
  ];
  const routeModelId = chooseRouteModelId(parsed.modelId, [...new Set(modelIds)]);
  return routeModelId ? `${parsed.provider}/${routeModelId}` : primarySpec;
}

async function callSummaryModel(api, cfg, ctx, options, transcriptText) {
  return callTextModel(api, cfg, ctx, options, {
    modelSpec: resolveSummaryModelSpec(cfg, ctx, options),
    maxTokens: options.summaryMaxTokens,
    systemPrompt: [
      "你是一个技术会话归档助手，只能根据给定对话生成摘要。",
      "输出必须严格是下面格式，不要加解释：",
      "[L0]",
      "一句话极简概括，10-20字，不要时间戳、不要列表符号。",
      "",
      "[L1]",
      "如果本轮出现关键命令、路径、端口、URL、配置项或结论，即使只是记录信息，也要用多行 '- ' 列出；完全没有再输出'无'。",
    ].join("\n"),
    userPrompt: [
      "请基于下面对话生成归档摘要：",
      "",
      transcriptText,
    ].join("\n"),
  });
}

function parseSummaryResult(raw, messages) {
  const safeFallback = fallbackTimelineSummary(messages);
  const result = { l0: safeFallback, l1: "" };
  if (typeof raw !== "string" || !raw.trim()) {
    return result;
  }
  const l0Match = raw.match(/\[L0\]\s*([\s\S]*?)(?=\[L1\]|$)/i);
  const l1Match = raw.match(/\[L1\]\s*([\s\S]*?)$/i);
  if (l0Match && l0Match[1]) {
    const firstLine = l0Match[1]
      .split("\n")
      .map((line) => sanitizeInlineText(line))
      .find(Boolean);
    if (firstLine) {
      const candidate = firstLine.replace(/^-\s*/, "").replace(/^\d{12,14}\s*\|\s*/, "");
      if (isUsableTimelineSummary(candidate)) {
        result.l0 = candidate;
      }
    }
  }
  if (l1Match && l1Match[1]) {
    const body = sanitizeDecisionSummary(l1Match[1]);
    if (body) {
      result.l1 = body;
    }
  }
  return result;
}

function isUsableTimelineSummary(text) {
  const candidate = sanitizeInlineText(text);
  if (!candidate) {
    return false;
  }
  if (candidate.length > 80) {
    return false;
  }
  const lower = candidate.toLowerCase();
  if (
    lower.includes("conversation_timeline") ||
    lower.includes("key_decisions") ||
    lower.includes("full_conversation") ||
    lower.includes("[user]") ||
    lower.includes("[assistant]") ||
    candidate.includes("<") ||
    candidate.includes(">") ||
    candidate.startsWith("以下是")
  ) {
    return false;
  }
  return true;
}

function sanitizeDecisionSummary(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== "无" && !line.startsWith("无"))
    .filter((line) => line.startsWith("- "))
    .filter((line) => {
      const lower = line.toLowerCase();
      return (
        !lower.includes("conversation_timeline") &&
        !lower.includes("key_decisions") &&
        !lower.includes("full_conversation") &&
        !line.includes("<") &&
        !line.includes(">")
      );
    });
  return lines.join("\n");
}

function tagDecisionLines(text, tsid) {
  return String(text || "")
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("- ")) {
        return "";
      }
      if (/^- \[\d{12,14}\]/.test(trimmed)) {
        return trimmed;
      }
      return trimmed.replace(/^- /, `- [${tsid}] `);
    })
    .filter(Boolean)
    .join("\n");
}

async function appendTimelineLine(agentDir, line, options) {
  const timelinePath = getTimelinePath(agentDir);
  const existing = await safeReadText(timelinePath);
  const nextLines = existing
    .split("\n")
    .map((entry) => entry.trimEnd())
    .filter(Boolean);
  nextLines.push(line);
  const clipped = nextLines.slice(-options.maxTimelineEntries);
  await fsp.writeFile(timelinePath, `${clipped.join("\n")}\n`, "utf8");
}

async function appendDecisions(agentDir, tsid, decisionText) {
  if (!decisionText) {
    return;
  }
  const dateKey = dateFromTsid(tsid) || formatDateKey(new Date());
  const decisionsPath = getDecisionsPath(agentDir);
  const existing = (await safeReadText(decisionsPath)).trim();
  const tagged = tagDecisionLines(decisionText, tsid);
  if (!tagged) {
    return;
  }
  const header = `## ${dateKey}`;
  if (!existing) {
    await fsp.writeFile(decisionsPath, `${header}\n\n${tagged}\n`, "utf8");
    return;
  }
  if (existing.includes(header)) {
    await fsp.writeFile(decisionsPath, `${existing}\n${tagged}\n`, "utf8");
    return;
  }
  await fsp.writeFile(decisionsPath, `${existing}\n\n${header}\n\n${tagged}\n`, "utf8");
}

async function appendRouteTrace(agentDir, traceEntry, options) {
  if (!traceEntry || typeof traceEntry !== "object") {
    return;
  }
  const tracePath = getRouteTracePath(agentDir);
  const existing = (await safeReadText(tracePath))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  existing.push(JSON.stringify(traceEntry));
  const clipped = existing.slice(-Math.max(1, options.routeTraceMaxEntries || 1));
  await fsp.writeFile(tracePath, `${clipped.join("\n")}\n`, "utf8");
}

function parseTimeline(timelineText) {
  const lines = String(timelineText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));
  const dateMap = {};
  const tsids = [];
  for (const line of lines) {
    const match = line.match(/^-\s*(\d{12,14})\s*\|/);
    if (!match) {
      continue;
    }
    const tsid = match[1];
    const dateKey = dateFromTsid(tsid);
    tsids.push(tsid);
    if (!dateKey) {
      continue;
    }
    if (!dateMap[dateKey]) {
      dateMap[dateKey] = [];
    }
    dateMap[dateKey].push(tsid);
  }
  return { lines, dateMap, tsids };
}

async function loadL0(agentDir, options) {
  const timelineText = await safeReadText(getTimelinePath(agentDir));
  if (!timelineText.trim()) {
    return {
      available: false,
      prompt: "",
      rawTimeline: "",
      lines: [],
      dateMap: {},
      tsids: [],
      tsidMap: {},
    };
  }
  const parsed = parseTimeline(timelineText);
  const tsidMap = await safeReadJson(getTsidMapPath(agentDir));
  const clippedLines = parsed.lines.slice(-options.l0PromptEntries);
  return {
    available: clippedLines.length > 0,
    prompt: clippedLines.length
      ? `<conversation_timeline>\n以下是历史时间线索引：\n${clippedLines.join("\n")}\n</conversation_timeline>`
      : "",
    rawTimeline: clippedLines.join("\n"),
    lines: parsed.lines,
    dateMap: parsed.dateMap,
    tsids: parsed.tsids,
    tsidMap,
  };
}

function extractTsidsFromText(text) {
  const ids = [];
  const regex = /\[(\d{12,14})\]|(?:^|\s)(\d{12,14})(?=\s|$)/g;
  let match = null;
  while ((match = regex.exec(String(text || ""))) !== null) {
    const tsid = match[1] || match[2];
    if (tsid && !ids.includes(tsid)) {
      ids.push(tsid);
    }
  }
  return ids;
}

function stripLeadingRuntimeTimestamp(text) {
  return String(text || "").replace(
    /^\[[A-Za-z]{3}\s+\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\s+GMT[+-]\d+\]\s*/u,
    "",
  );
}

function tokenizeForMatch(text) {
  const tokens = [];
  const normalized = String(text || "").toLowerCase().trim();
  if (!normalized) {
    return tokens;
  }
  const segments = normalized.split(/[\s\p{P}]+/u).filter(Boolean);
  for (const segment of segments) {
    if (/[\u4e00-\u9fff]/.test(segment)) {
      const chars = Array.from(segment).filter((char) => /[\u4e00-\u9fff]/.test(char));
      if (chars.length >= 2) {
        tokens.push(chars.join(""));
      }
      for (let index = 0; index < chars.length; index += 1) {
        tokens.push(chars[index]);
        if (index < chars.length - 1) {
          tokens.push(chars[index] + chars[index + 1]);
        }
      }
      continue;
    }
    if (segment.length >= 2) {
      tokens.push(segment);
    }
  }
  return [...new Set(tokens)];
}

function stripRecallPhrases(text, options) {
  let sanitized = String(text || "");
  const phrases = [
    ...(Array.isArray(options?.recallKeywords) ? options.recallKeywords : []),
    ...(Array.isArray(options?.strongRecallKeywords) ? options.strongRecallKeywords : []),
    "对话",
    "历史",
    "记录",
    "回顾",
    "之前",
    "上次",
    "那次",
    "当时",
    "调出来",
    "完整",
  ]
    .filter(Boolean)
    .sort((left, right) => String(right).length - String(left).length);
  for (const phrase of phrases) {
    sanitized = sanitized.split(String(phrase)).join(" ");
  }
  return sanitized;
}

function scoreTextMatch(text, keywords) {
  if (!text || !Array.isArray(keywords) || keywords.length === 0) {
    return 0;
  }
  const haystack = String(text || "").toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    if (!keyword || keyword.length < 2) {
      continue;
    }
    if (haystack.includes(keyword)) {
      score += keyword.length >= 4 ? 3 : 2;
    }
  }
  return score;
}

function isValidMonthDay(month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function extractDateTokens(promptText) {
  const matches = new Set();
  const text = String(promptText || "");
  const fullDateRegex = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/g;
  let full = null;
  while ((full = fullDateRegex.exec(text)) !== null) {
    const year = full[1];
    const monthNumber = Number(full[2]);
    const dayNumber = Number(full[3]);
    if (!isValidMonthDay(monthNumber, dayNumber)) {
      continue;
    }
    const month = formatDatePart(monthNumber);
    const day = formatDatePart(dayNumber);
    matches.add(`${year}-${month}-${day}`);
  }
  const monthDayRegex = /(?<!\d)(\d{1,2})[-/.月](\d{1,2})(?!\d)/g;
  let short = null;
  while ((short = monthDayRegex.exec(text)) !== null) {
    const now = new Date();
    const year = now.getFullYear();
    const monthNumber = Number(short[1]);
    const dayNumber = Number(short[2]);
    if (!isValidMonthDay(monthNumber, dayNumber)) {
      continue;
    }
    const month = formatDatePart(monthNumber);
    const day = formatDatePart(dayNumber);
    matches.add(`${year}-${month}-${day}`);
  }
  const now = new Date();
  if (text.includes("今天")) {
    matches.add(formatDateKey(now));
  }
  if (text.includes("昨天")) {
    matches.add(formatDateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000)));
  }
  if (text.includes("前天")) {
    matches.add(formatDateKey(new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000)));
  }
  return [...matches];
}

function chooseRecentDates(dateMap, count) {
  return Object.keys(dateMap || {})
    .sort()
    .slice(-count);
}

function chooseRecentTsids(l0Result, count) {
  return Array.isArray(l0Result?.tsids) ? l0Result.tsids.slice(-count) : [];
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    return null;
  }
  const stripped = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  const direct = stripped.startsWith("{") && stripped.endsWith("}") ? stripped : "";
  const candidate = direct || (stripped.match(/\{[\s\S]*\}/) || [])[0] || "";
  if (!candidate) {
    return null;
  }
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function extractRouteDates(parsed, availableDates) {
  const candidates = [];
  const collect = (value) => {
    if (typeof value === "string" && value.trim()) {
      candidates.push(value.trim());
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && entry.trim()) {
          candidates.push(entry.trim());
        }
      }
    }
  };
  collect(parsed?.l1Dates);
  collect(parsed?.dates);
  collect(parsed?.targetDates);
  collect(parsed?.l1Date);
  collect(parsed?.date);
  const allowed = new Set(Array.isArray(availableDates) ? availableDates.filter(Boolean) : []);
  return [...new Set(candidates.map(normalizeDateKey).filter(Boolean))].filter((dateKey) => {
    return allowed.size === 0 || allowed.has(dateKey);
  });
}

function isVagueRecallPrompt(promptText) {
  const text = String(promptText || "").trim();
  if (!text) {
    return false;
  }
  const vagueMarkers = [
    "还有印象",
    "还有印象吗",
    "有印象吗",
    "还记得",
    "记得吗",
    "记不记得",
    "之前那个事",
    "上次那个事",
    "前面那个事",
  ];
  const factMarkers = [
    "什么",
    "哪个",
    "哪次",
    "多少",
    "路径",
    "目录",
    "命令",
    "端口",
    "配置",
    "文件",
    "地址",
    "链接",
    "url",
    "日志",
    "报错",
    "原因",
    "步骤",
    "过程",
    "原话",
    "完整",
    "全文",
    "调出来",
    "贴出来",
  ];
  return vagueMarkers.some((marker) => text.includes(marker)) && !factMarkers.some((marker) => text.toLowerCase().includes(marker));
}

async function routeRecallLayers(api, cfg, ctx, options, promptText, l0Result, plan) {
  if (!options.llmRouting || !plan?.recall) {
    return null;
  }
  if (!plan.strongRecall && isVagueRecallPrompt(promptText)) {
    return {
      loadL1: false,
      loadL2: false,
    };
  }
  const routeModelSpec = await resolveRouteModelSpec(api, cfg, ctx, options);
  if (!routeModelSpec) {
    return null;
  }
  const availableDates = chooseRecentDates(l0Result.dateMap, Math.max(1, options.routeTimelineEntries || 1));
  const routeTimeline = l0Result.lines.slice(-Math.max(1, options.routeTimelineEntries || 1)).join("\n");
  const raw = await callTextModel(api, cfg, ctx, options, {
    modelSpec: routeModelSpec,
    maxTokens: options.routeMaxTokens,
    systemPrompt: [
      "你是一个分层记忆路由器，只负责决定是否需要注入 L1 和 L2 记忆。",
      "L0 时间线默认已经可用，不需要你决定。",
      "L1 适合找命令、路径、配置、端口、结论、摘要化事实。",
      "L2 适合找完整对话、原话、逐字内容、完整过程，或当 L1 不足以回答时。",
      "如果你能从时间线里定位到具体日期，请返回 l1Dates 数组，只保留最相关的 YYYY-MM-DD 日期。",
      "只输出 JSON，不要解释。",
      '格式: {"loadL1": boolean, "loadL2": boolean, "reason": string, "l1Dates": ["YYYY-MM-DD"]}',
    ].join("\n"),
    userPrompt: [
      "当前用户请求：",
      promptText,
      "",
      "最近的 L0 时间线：",
      routeTimeline || "(empty)",
      "",
      "可选日期（若返回 l1Dates，只能从这些日期中选择）：",
      availableDates.join(", ") || "(empty)",
      "",
      "如果用户只是在泛泛提到历史，且并未索要具体事实，可让 loadL1=false。",
      "如果用户要求完整对话、原文、逐字、详细过程，或明确需要强证据，设 loadL2=true。",
    ].join("\n"),
  }).catch(() => null);
  const parsed = parseJsonObject(raw);
  if (!parsed) {
    return null;
  }
  return {
    loadL1: parsed.loadL1 === true || parsed.needL1 === true,
    loadL2: parsed.loadL2 === true || parsed.needL2 === true,
    l1Dates: extractRouteDates(parsed, availableDates),
    reason: typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 160) : "",
  };
}

async function loadL1(agentDir, params, options) {
  const decisionsText = await safeReadText(getDecisionsPath(agentDir));
  if (!decisionsText.trim()) {
    return { available: false, prompt: "", tsids: [] };
  }

  const targetDates = Array.isArray(params?.dates) ? params.dates.filter(Boolean) : [];
  const targetTsids = Array.isArray(params?.tsids) ? params.tsids.filter(Boolean) : [];
  const scoreTsids = Array.isArray(params?.scoreTsids) ? params.scoreTsids.filter(Boolean) : [];
  const matchKeywords = tokenizeForMatch(stripRecallPhrases(params?.promptText || "", options));
  const lines = [];
  let currentDate = "";

  for (const rawLine of decisionsText.split("\n")) {
    const line = rawLine.trimEnd();
    const headerMatch = line.match(/^##\s+(\d{4}-\d{2}-\d{2})$/);
    if (headerMatch) {
      currentDate = headerMatch[1];
      continue;
    }
    if (!line.trim().startsWith("- ")) {
      continue;
    }
    const lineTsids = extractTsidsFromText(line);
    const dateHit = targetDates.length === 0 || targetDates.includes(currentDate);
    const tsidHit =
      targetTsids.length === 0 || lineTsids.some((tsid) => targetTsids.includes(tsid));
    if (dateHit && tsidHit) {
      const rendered = `- ${currentDate} ${line.trim().replace(/^- /, "")}`;
      const recencySeed = lineTsids[0] || "";
      const score =
        scoreTextMatch(rendered, matchKeywords) +
        (scoreTsids.length > 0 && lineTsids.some((tsid) => scoreTsids.includes(tsid)) ? 6 : 0);
      lines.push({
        line: rendered,
        tsids: lineTsids,
        score,
        recencySeed,
      });
    }
  }

  if (lines.length === 0) {
    return { available: false, prompt: "", tsids: [] };
  }

  const hasPositiveScore = lines.some((entry) => entry.score > 0);
  const ranked = lines
    .filter((entry) => !hasPositiveScore || entry.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return String(right.recencySeed).localeCompare(String(left.recencySeed));
    })
    .slice(0, options.l1MaxLines);
  const joined = ranked.map((entry) => entry.line).join("\n");
  const clipped = joined.slice(-options.l1PromptChars);
  return {
    available: true,
    prompt: `<key_decisions>\n以下是相关历史决策摘要：\n${clipped}\n</key_decisions>`,
    tsids: ranked
      .flatMap((entry) => entry.tsids)
      .filter((tsid, index, array) => array.indexOf(tsid) === index),
  };
}

function parseSessionTranscript(rawText, options) {
  const lines = [];
  const rawLines = String(rawText || "")
    .split("\n")
    .filter(Boolean);
  for (const rawLine of rawLines) {
    try {
      const entry = JSON.parse(rawLine);
      if (entry?.type !== "message" || !entry.message) {
        continue;
      }
      const role = entry.message.role;
      if (role !== "user" && role !== "assistant") {
        continue;
      }
      const text = stripInjectedRecallContext(extractTextBlocks(entry.message.content));
      if (!text) {
        continue;
      }
      lines.push(`[${role}]: ${text.slice(0, options.l2MaxCharsPerMessage)}`);
    } catch {
      continue;
    }
  }
  return lines.slice(-options.l2MaxMessagesPerSession).join("\n\n");
}

async function resolveSessionFilePath(sessionsDir, sessionId) {
  const direct = path.join(sessionsDir, `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) {
    return direct;
  }
  try {
    const files = await fsp.readdir(sessionsDir);
    const match = files
      .filter((name) => name.startsWith(`${sessionId}-topic-`) && name.endsWith(".jsonl"))
      .sort()
      .pop();
    return match ? path.join(sessionsDir, match) : null;
  } catch {
    return null;
  }
}

async function loadL2(agentDir, sessionIds, options) {
  const sessionsDir = resolveSessionsDir(agentDir);
  const targetIds = Array.isArray(sessionIds) ? sessionIds.filter(Boolean).slice(0, options.l2MaxSessions) : [];
  if (targetIds.length === 0) {
    return { available: false, prompt: "" };
  }
  const chunks = [];
  let usedChars = 0;

  for (const sessionId of targetIds) {
    if (usedChars >= options.l2PromptChars) {
      break;
    }
    const filePath = await resolveSessionFilePath(sessionsDir, sessionId);
    if (!filePath) {
      continue;
    }
    const raw = await safeReadText(filePath);
    const text = parseSessionTranscript(raw, options);
    if (!text) {
      continue;
    }
    const remaining = options.l2PromptChars - usedChars;
    const clipped = text.length > remaining ? `${text.slice(0, remaining)}\n...(truncated)` : text;
    chunks.push(`### Session ${sessionId}\n${clipped}`);
    usedChars += clipped.length;
  }

  if (chunks.length === 0) {
    return { available: false, prompt: "" };
  }
  return {
    available: true,
    prompt: `<full_conversation>\n以下是相关完整对话：\n${chunks.join("\n\n---\n\n")}\n</full_conversation>`,
  };
}

function resolveSessionIdsFromTsids(tsids, tsidMap) {
  const sessionIds = [];
  for (const tsid of tsids || []) {
    const sessionId = tsidMap?.[tsid];
    if (sessionId && !sessionIds.includes(sessionId)) {
      sessionIds.push(sessionId);
    }
  }
  return sessionIds;
}

function hasKeyword(text, keywords) {
  return keywords.some((keyword) => keyword && String(text).includes(keyword));
}

function buildRecallPlan(promptText, l0Result, options) {
  const normalizedPrompt = stripLeadingRuntimeTimestamp(promptText);
  const explicitTsids = extractTsidsFromText(normalizedPrompt);
  const explicitDates = extractDateTokens(normalizedPrompt);
  const recall =
    hasKeyword(normalizedPrompt, options.recallKeywords) ||
    explicitDates.length > 0 ||
    explicitTsids.length > 0;
  const strongRecall = hasKeyword(normalizedPrompt, options.strongRecallKeywords);
  const recentDates = recall && explicitDates.length === 0
    ? chooseRecentDates(l0Result.dateMap, options.recentDaysForRecall)
    : explicitDates;
  const recentTsids =
    explicitTsids.length > 0
      ? explicitTsids
      : recentDates.flatMap((dateKey) => l0Result.dateMap[dateKey] || []);
  const fallbackTsids =
    recall && recentTsids.length === 0 ? chooseRecentTsids(l0Result, options.recentTsidsForRecall) : [];
  const tsids = [...new Set([...recentTsids, ...fallbackTsids])];
  return {
    recall,
    strongRecall,
    dates: [...new Set(recentDates)],
    tsids,
    explicitTsids,
    normalizedPrompt,
  };
}

function enqueueWrite(agentDir, task) {
  const previous = writeQueues.get(agentDir) || Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  writeQueues.set(
    agentDir,
    next.finally(() => {
      if (writeQueues.get(agentDir) === next) {
        writeQueues.delete(agentDir);
      }
    }),
  );
  return next;
}

async function captureHistory(api, options, event, ctx) {
  if (!event?.success || !ctx?.sessionId) {
    return;
  }
  const stateDir = api.runtime.state.resolveStateDir(process.env);
  const agentDir = resolveAgentDir(api.config, ctx, stateDir);
  await enqueueWrite(agentDir, async () => {
    await ensureHistoryDir(agentDir);
    const tsid = await generateUniqueTsid(agentDir);
    const transcriptText = collectConversationMessages(event.messages, {
      maxMessages: options.captureMaxMessages,
      maxCharsPerMessage: options.captureMaxCharsPerMessage,
    });
    const rawSummary =
      options.captureWithLlm && transcriptText
        ? await callSummaryModel(api, api.config, ctx, options, transcriptText).catch(() => null)
        : null;
    const summary = parseSummaryResult(rawSummary, event.messages);
    const tsidMap = await safeReadJson(getTsidMapPath(agentDir));
    tsidMap[tsid] = ctx.sessionId;
    await writeJson(getTsidMapPath(agentDir), tsidMap);
    await appendTimelineLine(agentDir, `- ${tsid} | ${summary.l0}`, options);
    if (summary.l1) {
      await appendDecisions(agentDir, tsid, summary.l1);
    }
  });
}

async function buildPromptContext(api, options, event, ctx) {
  const stateDir = api.runtime.state.resolveStateDir(process.env);
  const agentDir = resolveAgentDir(api.config, ctx, stateDir);
  const l0Result = await loadL0(agentDir, options);
  if (!l0Result.available) {
    return undefined;
  }

  const promptText = typeof event?.prompt === "string" ? event.prompt : "";
  const plan = buildRecallPlan(promptText, l0Result, options);
  const routeDecision = plan.recall
    ? await routeRecallLayers(api, api.config, ctx, options, plan.normalizedPrompt || promptText, l0Result, plan)
    : null;
  const segments = [];
  const recallDates =
    routeDecision && Array.isArray(routeDecision.l1Dates) && routeDecision.l1Dates.length > 0
      ? routeDecision.l1Dates
      : plan.dates;
  const recallTsids =
    plan.explicitTsids.length > 0
      ? plan.explicitTsids
      : recallDates.flatMap((dateKey) => l0Result.dateMap[dateKey] || []).filter(Boolean);
  const scopedTsids = recallTsids.length > 0 ? [...new Set(recallTsids)] : plan.tsids;

  if ((options.alwaysLoadL0 || plan.recall) && l0Result.prompt) {
    segments.push(l0Result.prompt);
  }

  if (!plan.recall) {
    return segments.length > 0 ? { prependContext: segments.join("\n\n") } : undefined;
  }

  const shouldLoadL1 = routeDecision
    ? Boolean(routeDecision.loadL1 || routeDecision.loadL2 || plan.explicitTsids.length > 0)
    : true;
  const shouldLoadL2 = routeDecision ? Boolean(routeDecision.loadL2 || plan.strongRecall) : plan.strongRecall;
  let l1Result = { available: false, prompt: "", tsids: [] };
  if (shouldLoadL1) {
    l1Result = await loadL1(
      agentDir,
      {
        dates: recallDates,
        tsids: scopedTsids,
        scoreTsids: plan.explicitTsids,
        promptText: plan.normalizedPrompt || promptText,
      },
      options,
    );
    if (l1Result.available) {
      segments.push(l1Result.prompt);
    }
  }

  if (shouldLoadL2) {
    const l2Tsids = l1Result.tsids && l1Result.tsids.length > 0 ? l1Result.tsids : scopedTsids;
    const sessionIds = resolveSessionIdsFromTsids(l2Tsids, l0Result.tsidMap);
    const l2Result = await loadL2(agentDir, sessionIds, options);
    if (l2Result.available) {
      segments.push(l2Result.prompt);
    }
  }

  if (options.persistRouteTrace && plan.recall) {
    await enqueueWrite(agentDir, async () => {
      await ensureHistoryDir(agentDir);
      await appendRouteTrace(
        agentDir,
        {
          ts: new Date().toISOString(),
          sessionId: ctx?.sessionId || "",
          prompt: sanitizeInlineText(plan.normalizedPrompt || promptText).slice(0, 240),
          plan: {
            recall: Boolean(plan.recall),
            strongRecall: Boolean(plan.strongRecall),
            explicitTsids: plan.explicitTsids,
            explicitDates: plan.dates,
          },
          route: routeDecision
            ? {
                loadL1: Boolean(routeDecision.loadL1),
                loadL2: Boolean(routeDecision.loadL2),
                l1Dates: routeDecision.l1Dates || [],
                reason: routeDecision.reason || "",
              }
            : null,
          resolved: {
            dates: recallDates,
            tsids: scopedTsids,
            loadedL0: segments.some((segment) => segment.includes("<conversation_timeline>")),
            loadedL1: segments.some((segment) => segment.includes("<key_decisions>")),
            loadedL2: segments.some((segment) => segment.includes("<full_conversation>")),
          },
        },
        options,
      );
    });
  }

  return segments.length > 0 ? { prependContext: segments.join("\n\n") } : undefined;
}

module.exports = {
  id: "layered-history-index",
  name: "Layered History Index",
  description: "Layered history index with L0 timeline, L1 decisions, and on-demand L2 recall.",
  register(api) {
    const options = mergeConfig(api.pluginConfig);

    api.on("before_prompt_build", async (event, ctx) => {
      return buildPromptContext(api, options, event, ctx);
    });

    api.on("agent_end", async (event, ctx) => {
      await captureHistory(api, options, event, ctx);
    });
  },
};
