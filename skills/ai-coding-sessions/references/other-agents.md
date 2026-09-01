---
name: other-agents
description: "ACS 未实现的其它 coding agent 本地目录与落盘形态, 只读对照; 不实现解析"
tags: [ai-coding-sessions, sources, reference, other-agents]
date: 2026-09-01T12:00:00+08:00
---

# 其它 coding agent 本地目录 (补充参考)

ACS 已实现 8 source 的路径与字段口径以 [sources.md](./sources.md) 为准。本页只补 **尚未做成 source** 的 agent: 常见落盘根、文件形态、以及和已实现 source 重叠处的差异。**对照目录与思路, 不要把用量扫描器的 parser 直接搬进来。**

本地是否有数据: `bun skills/ai-coding-sessions/scripts/check-local-agents.ts` (默认 JSON, 只报 present)。`--format=md` / `--kind=other` / `--all`。路径 catalog 在 `scripts/local-agent-probes.ts`。

## 资料来源

目录与扫描分类主要对照 [junhoyeo/tokscale](https://github.com/junhoyeo/tokscale) (`crates/tokscale-core/src/clients.rs`, `scanner.rs`, `sessions/`; 维护者可 shallow clone 到本机 github 目录)。那是 **usage-first** 的 token/成本扫描器 (`UnifiedMessage` = 一条计价 token 行), 不是 ACS 的 session 协议。包代码不依赖该 clone。

## 为什么不要直接做成 ACS source

- ACS 要完整 session (messages / tools / parent_id / trace / handoff)。用量扫描只要 token 行。
- 若干 "client" 没有 transcript: Cursor 用量 CSV、Warp 聚合请求、Trae 账户 API、MiniMax headless 捕获、LM Studio 只留 usage log.
- 已覆盖的 8 个, 扫描口径也不完全相同 (见重叠差异). 改 ACS 解析走 sources.md.

只为 **成本看板** 看 extras 时, 直接跑现成用量扫描器比在 ACS 里加 source 便宜.

## 常见扫描流水 (对照)

```
client 注册 (id / 路径根类型 / glob / 本地 parse)
  → 并行 walk + 额外根 + SQLite 特例
  → 每 client 一份 parser → 用量行
  → 外部价表计价
```

路径根类型大致是: 家目录 / XDG data / 扫描器自建 cache / 系统 AppData / 环境变量 / ReasonixHome. 扫描器再叠: 环境覆盖、legacy 改名、macOS Application Support、VS Code server、隔离测试 home.

## 落盘形态 (按解析思路分组)

**JSONL / JSON transcript** (session = 文件或目录): Claude projects、Pi 族 (`~/.pi|senpi|omp|gjc|prime/agent/sessions`, Kimchi harness)、Kimi `wire.jsonl`、Grok `updates.jsonl`、Qwen projects、Junie `events.jsonl`、OpenClaw agents、Command Code、OpenCodeReview、CodeBuddy；JSON 快照: Amp `T-*.json`、Droid `*.settings.json`、Augment.

**SQLite**: OpenCode `opencode.db` (+ channel 后缀)、Hermes `state.db` (+ profiles)、Goose `sessions.db`、Zed `threads.db`、Kilo CLI `kilo.db`、ZCode v2 `db.sqlite`、WorkBuddy fallback db、MiMo `*.db`、Devin CLI `sessions.db`、Unsloth `studio.db`、Antigravity CLI `conversations/*.db`、Crush 经 `projects.json` 找到 per-project db.

**VS Code extension task**: Roo / Kilo Code / Cline 的 `ui_messages.json`. 默认文档常写 Linux `~/.config/Code/...`; macOS 真根在 `~/Library/Application Support/Code/...`. 探测脚本两条都扫; 上游对 Cline 补了 mac 路径, Roo/Kilo 默认没有.

**压缩 JSONL**: DSH `session.jsonl.zstd` (也接受未压缩)、Codex `.jsonl.zst`. 按 magic 判断, 不按后缀.

**用量快照 / 日志** (无完整对话): fx `usage-v2.json`、Mux `session-usage.json`、Reasonix `stats/*.jsonl`、LM Studio `server-logs/**/*.log` (只读 usage 对象).

**用量 API 二次缓存** (不是 agent 原生目录; 本机若跑过用量扫描器, 常见落在 `~/.config/tokscale/`): Cursor `cursor-cache/usage*.csv`、Antigravity RPC→jsonl、Trae 官方 usage API、Warp GraphQL 聚合、mcode `headless/mcode/*.jsonl`. 这些 **不适合** 做 ACS source.

**再归因**: Synthetic 从其它 client 的 `hf:` / `synthetic` provider 拆出来; 另扫 Octofriend sqlite.

**Pi 族共享 parser**: Pi JSONL header (`type=session`, `parentSession`, `rlmDepth`) 被 Senpi / OMP / Kimchi / Prime Agent / GJC 复用, 只换根目录. 若 ACS 要接其中之一, 先抽 Pi 格式, 不要每个 fork 一份.

## 与 ACS 重叠的差异

- **Cursor**: ACS 读 Desktop `state.vscdb` + `~/.cursor/projects/*/agent-transcripts` (本地无 billed usage). 用量扫描器 **故意不读** `~/.cursor`, 改走 Cursor 用量导出 CSV. 两套数据不可互相替代.
- **Kimi**: ACS `KIMI_DATA_DIR` → 优先存在的 `~/.kimi-code` / `~/.kimi`. 用量扫描同时扫 kimi-cli、kimi-code、以及 macOS Kimi Work (`Library/Application Support/kimi-desktop/.../sessions`).
- **Grok**: ACS `~/.grok/sessions`. 用量扫描另读 `~/.grok/logs/unified.jsonl` 做 per-inference 拆分.
- **ZCode**: ACS 主路径是 v2 sqlite. 用量扫描还扫 legacy `~/.zcode/projects/**/*.jsonl`.
- **OpenCode**: ACS 用 `opencode db path` / `OPENCODE_DB_PATH`. 用量扫描扫 XDG 下 `opencode.db` 与 `opencode-*.db`, 以及未迁移的 `storage/message/*.json`.
- **Codex**: ACS 还有 `state_*.sqlite` + rollout zst. 用量扫描以 `sessions/` + `archived_sessions/` JSONL 为主.
- **WorkBuddy**: 两边都是 `~/.workbuddy`; 用量扫描额外走 Tencent Buddy extension log.

## 未实现 extras (按值得关注程度)

先跑 check 脚本看本机规模, 再决定要不要做 ACS source.

- 本机开发者 CLI 常见: Gemini、Copilot OTEL、Qwen、Hermes、DSH、Pi/OMP、Amp、Cline
- IDE / 扩展: Zed、Goose、Roo、Kilo、Kiro、Cherry Studio、Devin
- 几乎肯定不该进 ACS: 用量 API 二次缓存 (Cursor CSV / Trae / Warp / Antigravity sync / mcode headless)、LM Studio logs、Synthetic 再归因

## 新 source 决策

同时满足再考虑写 `*-code.ts` / `*-source.ts`:

1. check 脚本本机 `present` 且规模不是玩具 (个位数 session / < 1MB 默认不做)
2. 磁盘上有 **可还原的 transcript** (能 detail / trace), 不只是日汇总 token
3. 不是用量扫描器自己的 API cache
4. 用户真的会跨 agent 续作 (handoff), 而不是只想看烧了多少钱

成本-only → 用现成用量扫描器. 路径探测 → 本 skill 的 check 脚本. 实现 → [sources.md](./sources.md) 新 source 步骤.
