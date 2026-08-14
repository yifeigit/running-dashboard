# 维护指南（拉取分析记录）

> 本文档由仓库分析自动生成，用于后续维护。最后分析时间：2026-08-14 之后（基于 `main` @ `0856cc2`）。

## 1. 项目是什么

一个**个人跑步数据整合 + 可视化看板**：

- 历史数据来自**小米运动健康**（`tcx/`，已停止更新）
- 当前唯一数据源是**高驰 COROS**（`fit/`，每天自动同步）
- 最终产物是一个**单文件暗黑看板** `index.html`，数据内嵌在 `data.js`
- 部署在 GitHub Pages：https://yifeigit.github.io/running-dashboard/

## 2. 数据流（端到端）

```
COROS MCP 服务器 (https://mcpcn.coros.com/mcp)
        │  OAuth2 (refresh_token 自动轮换)
        ▼
sync_coros.mjs ───────────── 1. querySportRecords（仅跑步 100/101/102/103）
        │                    2. queryActivityFitFileDownloadUrls → 下载缺失 .fit
        │                    3. parse_fit.py → fit_parsed.json
        │                    4. parse_tcx.py → tcx_parsed.json
        │                    5. integrate（内联在 sync_coros.mjs）→ activities.json/csv + summary.json
        │                    6. extract_tracks.py → tracks.json（GPS 轨迹，Douglas-Peucker 抽稀）
        │                    7. fetch_health.mjs → health_raw.json → parse_health.mjs → health.json
        │                    8. generate_data.mjs → data.js（前端唯一数据源）
        ▼
   index.html（ECharts + Leaflet，读 window.RUN_DATA）
```

关键点：**`data.js` 是唯一被 commit 的数据产物**（`activities.json` / `activities.csv` / `summary.json` / `tools/*.json` 全部在 `.gitignore` 里，只在本地/CI 运行期生成）。

## 3. 文件清单

| 路径 | 角色 | 是否提交 |
|---|---|---|
| `index.html` | 看板页面（56 KB，ECharts + Leaflet） | ✅ |
| `data.js` | 前端数据包（约 979 KB，`window.RUN_DATA`） | ✅（自动生成，勿手改） |
| `sync_coros.mjs` | 一键同步主脚本（含内联 integrate/文本解析） | ✅ |
| `README.md` | 使用说明（**部分计数已过期，见 §7**） | ✅ |
| `fit/*.fit` | COROS 原始 FIT（文件名 = labelId） | ✅（91 个） |
| `tcx/*.tcx` | 小米历史 TCX（文件名 `YYYYMMDD户外跑步`） | ✅（38 个） |
| `vendor/echarts.min.js` | ECharts 5.5.1 本地化 | ✅ |
| `vendor/leaflet/` | Leaflet 1.9.4 + css + images 本地化 | ✅ |
| `.github/workflows/daily-sync.yml` | 每日自动同步 CI | ✅ |
| `tools/coros_mcp.mjs` | 通用 COROS MCP 调用 CLI | ✅ |
| `tools/fetch_health.mjs` | 拉取健康指标原始文本 | ✅ |
| `tools/parse_health.mjs` | 健康文本 → 结构化 JSON | ✅ |
| `tools/parse_fit.py` | FIT 解析（fitdecode） | ✅ |
| `tools/parse_tcx.py` | TCX 解析（stdlib XML） | ✅ |
| `tools/extract_tracks.py` | GPS 轨迹抽取 + 抽稀 | ✅ |
| `tools/integrate.mjs` | 整合逻辑（**与 sync 内联版重复**） | ✅ |
| `tools/parse_records.mjs` | 记录文本解析（**与 sync 内联版重复**） | ✅ |
| `tools/generate_data.mjs` | 打包 data.js | ✅ |
| `tools/compare_fit.mjs` | 对比本地 fit 与 COROS 记录 | ✅ |
| `tools/download_vendor.mjs` | 下载 ECharts/Leaflet 到本地 | ✅ |
| `activities.json/csv`、`summary.json`、`tools/*.json` | 中间产物 | ❌（gitignore） |

## 4. 运行环境与依赖

- **Node.js** ≥ 22（CI 用 22，本地建议同版本；脚本全用全局 `fetch`、ESM、`node:fs` 等）
- **Python** 3.12 + `pip install fitdecode`（仅 `parse_fit.py` / `extract_tracks.py` 依赖）
- **COROS 登录态**：token 缓存在 `~/.coros-mcp-skill-gateway-ts/cn/token.json`
  - 首次需 `coros-mcp login`；之后脚本用 refresh_token 自动轮换并写回
  - 可用环境变量覆盖：`MCP_CACHE_ROOT` / `MCP_CACHE_PATH`（见 `tools/coros_mcp.mjs`）
- 网页运行无需构建，仅需静态服务器：`python -m http.server 8080`

## 5. 密钥与 CI（`.github/workflows/daily-sync.yml`）

| Secret | 用途 |
|---|---|
| `COROS_TOKEN` | COROS OAuth token 的 JSON 原文，CI 启动时写入本地缓存文件 |
| `GH_TOKEN` | GitHub token，用于把**轮换后的新 token 写回** `COROS_TOKEN` secret（存在时） |

流程：每天 UTC 00:00（北京时间 08:00）→ checkout → 装 Node/Python/fitdecode → 恢复 token → `node sync_coros.mjs` → （有 GH_TOKEN 则回写 token）→ `git add -A && commit && push`。

⚠️ 若 `GH_TOKEN` 缺失或过期，token 轮换不会回写，几次刷新后 `COROS_TOKEN` 会失效，之后每日同步会失败。这是最常见的“自动同步突然断掉”的原因。

## 6. 日常维护操作

| 场景 | 操作 |
|---|---|
| 手动同步 | `node sync_coros.mjs`（本机，需已登录 + Python + fitdecode） |
| CI 手动触发 | 仓库 → Actions → Daily Sync → Run workflow |
| token 过期 | 本机重新 `coros-mcp login`；或确认 `GH_TOKEN` 正常后跑一次同步回写 |
| 重新下载前端库 | `node tools/download_vendor.mjs` |
| 单独调 COROS MCP | `node tools/coros_mcp.mjs --list-tools` / `--tool <name> --args-file args.json` |
| 只重算 data.js（不拉数据） | 先有 `activities.json`、`tools/tracks.json`、`tools/health.json`，再 `node tools/generate_data.mjs .` |

## 7. 数据现状（README 计数已于 2026-08-14 修正）

- 实际 `data.js`：**91 coros + 38 xiaomi = 129 条**；`fit/` 91 个文件、`tcx/` 38 个文件，与 `data.js` 一致。
- 数据日期范围：`2025-02-17` ~ `2026-08-09`（xiaomi 到 `2025-09-17`，coros 从 `2025-11-15` 起，两来源不重叠）。
- 曾出现 README 写「93 + 39 = 132」的过期计数（提交 `ae89007`「仅保留 91 条跑步」删数据后未同步），已修正。

## 8. 代码结构与技术债（维护时注意）

1. **三处重复的 OAuth/HTTP/MCP 客户端**：`sync_coros.mjs`、`tools/coros_mcp.mjs`、`tools/fetch_health.mjs` 各自内联了一套几乎相同的 `HttpClient` + `registerClient` + `refresh` + `ensureToken` + `mcpRequest`。改 token/认证逻辑要同步改三处，极易漏改。建议抽成公共模块。
2. **两处重复的整合逻辑**：`sync_coros.mjs` 内联的 `integrate()`/`parseRecordsText()` 与 `tools/integrate.mjs`、`tools/parse_records.mjs` 重复；`sync_coros.mjs` 运行时**并不调用**这两个 tools 脚本（它自己内联实现）。维护时以 `sync_coros.mjs` 内联版为准，两个 tools 脚本目前是“历史遗留/备用”，存在漂移风险。
3. **文本解析脆弱**：COROS MCP 的 `querySportRecords` 等工具返回的是**人类可读文本**，脚本靠正则（如 `startTimestamp=(\d+)`、`(\d+):(\d+) /km \| Avg HR`）解析。COROS 只要改文案格式，解析会静默失败（得 0/null，不会报错）。改版时优先检查这里。
4. **健康指标全靠正则**（`tools/parse_health.mjs`）：`VO2max:\s*(\d+)`、`HRV Avg:` 等，同上脆弱；`queryDailyHealthData` 的正则甚至依赖特定段落格式（`--- 20250814 ---`）。
5. **未使用代码**：`sync_coros.mjs` 与 `fetch_health.mjs` 里 `isRecord` 定义后未使用；`parse_records.mjs` 第 76–80 行用 `records.find` 二次回填坐标，是 O(n²) 且逻辑绕（坐标其实可直接从当前块读取，见 `sync_coros.mjs` 内联版的正则实现）。
6. **数据不重叠假设**：整合时用 `overlapDates` 做 sanity check，README 声明两来源时间不重叠。若未来 COROS 数据回填到 2025 上半年，会出现日期重叠，看板“按日期”排序/去重逻辑需复核。
7. **仅同步跑步**：`sync_coros.mjs` 里 `sportTypeCodes: [100,101,102,103]`（户外/室内/越野/跑道跑），徒步(104)、爬山(105)、体能训练等被排除。若要纳入其他运动，改这里 + README。

## 9. 前端看板结构速查（`index.html`）

- 依赖：`vendor/leaflet/leaflet.css` + `leaflet.js` + `echarts.min.js`，数据来自 `data.js`（`window.RUN_DATA`）。
- 地图底图：CARTO 暗黑瓦片 `https://{s}.basemaps.cartocdn.com/dark_all/...`（唯一需联网的部分；库本身已本地化）。
- 主要逻辑在 `<script>`（第 374 行起）：`const D = window.RUN_DATA` 后展开 KPI、轨迹地图、训练图表、健康图表、详情曲线、列表联动。
- 轨迹按配速热力着色（红快→蓝慢），点击轨迹/列表/卡牌联动地图与详情。
- 修改看板只改 `index.html`（+ 必要时 `tools/generate_data.mjs` 的打包字段），不需要构建步骤。

## 10. 常见故障排查

| 症状 | 排查 |
|---|---|
| Actions 同步失败 | 看 `COROS_TOKEN` 是否过期、`GH_TOKEN` 是否缺失、fitdecode 是否安装失败 |
| 本地 `node sync_coros.mjs` 报 no token | 先 `coros-mcp login` |
| 解析出 0 条/字段为空 | COROS MCP 文本格式可能变更，检查 `querySportRecords` 返回原文（用 `tools/coros_mcp.mjs` 单独调用） |
| 看板地图空白但图表正常 | CARTO 瓦片需联网；检查网络/代理 |
| 看板数据不更新 | `data.js` 是否被重新生成并 push；本地是否缓存了旧 `data.js` |
