# OpenClaw Layered History Index

Layered conversation memory plugin for OpenClaw.

## 功能特性

- **L0** 时间线记忆 - 快速浏览最近会话
- **L1** 决策/配置/命令记忆 - 提取关键信息（密码、路径、API配置等）
- **L2** 完整对话回忆 - 完整会话回放
- **LLM 路由** - 智能决定加载哪一层
- **日期限定路由** - 按日期筛选相关决策
- **路由追踪日志** - 可选功能，用于调试和调优

## 工作原理

| 场景 | 加载层级 | 说明 |
|------|----------|------|
| 正常聊天 | 无注入 | 不干扰正常对话 |
| 模糊回忆 | L0 | 加载时间线摘要 |
| 事实回忆 | L0 + L1 | 加载路径、命令、配置等 |
| 完整回放 | L0 + L1 + L2 | 完整会话内容 |

## 安装

```bash
# 克隆到本地
git clone https://github.com/wwq20030329-oss/openclaw-layered-history-index.git
cd openclaw-layered-history-index

# 安装插件
openclaw plugins install -l .
```

## 配置选项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `alwaysLoadL0` | false | 是否始终加载 L0 |
| `captureWithLlm` | true | 使用 LLM 捕获摘要 |
| `llmRouting` | true | 启用 LLM 路由决定 |
| `l0PromptEntries` | 20 | L0 时间线条目数 |
| `l1PromptChars` | 2500 | L1 最大字符数 |
| `l1MaxLines` | 4 | L1 最大行数 |
| `l2PromptChars` | 6000 | L2 最大字符数 |
| `l2MaxSessions` | 1 | L2 最大会话数（设为0禁用）|
| `recentDaysForRecall` | 2 | 回溯天数 |
| `recentTsidsForRecall` | 2 | 回溯会话数 |
| `persistRouteTrace` | true | 持久化路由追踪 |
| `routeTraceMaxEntries` | 200 | 追踪日志最大条目 |
| `routeTimelineEntries` | 4 | 路由时间线条目数 |
| `routeMaxTokens` | 120 | 路由最大 token 数 |
| `routeModel` | `""` | 路由判断使用的轻量模型（如 LongCat-Flash-Lite） |
| `routeModelProvider` | `""` | 路由模型所属的提供商（如 qqoq-duckdns-org），留空则根据模型名自动推断 |
| `logRoutingFailures` | `true` | 是否在路由失败时输出错误日志 |
| `routeCacheTtlSeconds` | `300` | 路由结果缓存时间（秒），0 表示禁用缓存 |
| `extraToolPacks` | `[]` | 用户自定义工具包，格式：`[{"name":"工具名","description":"描述"}]` |
| `extraFiles` | `[]` | 用户自定义工作区文件，格式：`[{"name":"文件名","description":"描述"}]` |
| `routingPromptTemplate` | `null` | 自定义路由 Prompt 模板，支持 `{{userMessage}}`, `{{timelineSection}}`, `{{packIndex}}`, `{{fileIndex}}` 变量 |
| `autoCleanup` | true | 启用自动清理 |
| `maxHistoryDays` | 30 | 历史保留天数 |

## 配置示例

```json
{
  "plugins": {
    "entries": {
      "layered-history-index": {
        "enabled": true,
        "config": {
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
          "routeModel": "LongCat-Flash-Lite",
          "routeModelProvider": "qqoq-duckdns-org",
          "logRoutingFailures": true,
          "routeCacheTtlSeconds": 300,
          "extraToolPacks": [
            {"name": "git", "description": "Git 版本控制操作"},
            {"name": "docker", "description": "Docker 容器管理"}
          ],
          "extraFiles": [
            {"name": "CLAUDE.md", "description": "Claude 协作规范"},
            {"name": "PROJECT.md", "description": "项目说明文档"}
          ],
          "autoCleanup": true,
          "maxHistoryDays": 30
        }
      }
    }
  }
}
```

## 生成的文件

每个 agent 目录下会生成：

- `history/timeline.md` - L0 时间线
- `history/decisions.md` - L1 决策记录
- `history/tsid-session-map.json` - 会话映射
- `history/route-trace.jsonl` - 路由追踪日志（启用时）

## Token 节省分析

启用 L2 后，插件会根据路由决定加载范围，典型节省效果：

| 场景 | 完整加载 | 路由加载 | 节省 |
|------|----------|----------|------|
| 模糊回忆 | ~8000 tokens | ~600 tokens | ~92% |
| 事实回忆 | ~8000 tokens | ~1200 tokens | ~85% |
| 完整回放 | ~8000 tokens | ~3500 tokens | ~56% |

查看节省详情：

```bash
npm run analyze:trace -- ~/.openclaw/agents/main/agent/history/route-trace.jsonl
```

## 中文关键词支持

插件内置中文关键词识别：

- **模糊回忆**: 回忆、之前、上次、以前、记得
- **强回忆**: 详细、完整、所有、具体

## 自动清理

启用后会自动清理旧历史文件：

- 超过 `maxHistoryDays` 天的历史
- 超过 `maxTimelineEntries` 条的时间线

## 开发

```bash
# 运行测试
npm test

# 分析 token 节省
npm run analyze:trace -- ./history/route-trace.jsonl
```

## 更新日志

### v0.2.0
- **新增**: 路由缓存功能 - 通过 `routeCacheTtlSeconds` 配置缓存时间（默认 300 秒），避免重复调用路由模型
- **新增**: `extraToolPacks` 配置项 - 支持用户自定义工具包（如 git、docker 等）
- **新增**: `extraFiles` 配置项 - 支持用户自定义工作区文件（如 CLAUDE.md、PROJECT.md 等）
- **新增**: `routingPromptTemplate` 配置项 - 支持自定义路由 Prompt 模板，支持多语言和场景定制
- **优化**: 工具包和文件描述改为动态合并，不再硬编码
- **优化**: 路由函数添加缓存键生成和缓存清理逻辑（最多 500 条）
- **文档**: 更新配置表格和示例，添加新配置项说明

### v0.1.4
- **修复**: 添加 `routeModelProvider` 配置项，解决路由模型提供商写死问题
- **修复**: 路由模型调用支持从模型名自动推断提供商（LongCat-* → qqoq-duckdns-org, MiniMax-* → minimax-portal）
- **新增**: `logRoutingFailures` 配置项，控制是否在路由失败时输出错误日志
- **修复**: 路由结果严格验证（类型检查、日期格式验证、字段长度限制）
- **修复**: 更新 package.json 版本号为 0.1.4
- **文档**: 更新 README 配置选项和示例，添加 `routeModelProvider` 和 `logRoutingFailures` 说明

### v0.1.3
- 添加完整的 Viking 风格路由模型调用逻辑
- 支持 LongCat-Flash-Lite 等轻量模型做路由判断
- 添加工具能力包（TOOL_PACKS）按需加载
- 添加 Workspace 文件按需加载支持
- 优化配置默认值

### v0.1.2
- 添加 `routeModel` 配置支持独立路由模型（如 LongCat-Flash-Lite）
- 添加 Viking 风格工具能力包配置（TOOL_PACKS）
- 添加 Workspace 文件按需加载支持
- 优化配置默认值

### v0.1.1
- 添加 `openclaw.extensions` 字段，修复安装警告
- 添加 `autoCleanup` 和 `maxHistoryDays` 自动清理功能
- 添加 `maxTimelineEntries` 限制时间线大小
- 优化配置默认值
- 完善中文 README

### v0.1.0
- 初始版本

## License

MIT
