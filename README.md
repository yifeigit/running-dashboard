# 运动数据分析 — 跑步数据整合

统一整合 **小米运动健康（历史）** 与 **高驰 COROS（当前唯一数据源）** 的跑步数据。

## 数据来源

| 来源 | 目录 | 说明 | 时间范围 |
|---|---|---|---|
| 小米运动健康 | `tcx/` | 历史导出（.tcx，含 GPS 轨迹、步数） | 2025-02-17 ~ 2025-09-17（39 条） |
| 高驰 COROS | `fit/` | 当前数据源（.fit，文件名即 labelId） | 2025-11-15 ~ 至今（93 条） |

两个来源时间上**不重叠**，整合后共 **132 条**跑步记录，时间连续覆盖 2025-02-17 至今。

## 输出文件

- `activities.json` — 统一的结构化数据集（每条活动一个对象，按时间排序）
- `activities.csv` — 同内容的表格版，便于用 Excel / pandas 查看
- `summary.json` — 整合统计信息

### 每条活动的字段

| 字段 | 含义 | 小米 | 高驰 |
|---|---|---|---|
| `date` | 跑步日期（用户本地日期） | ✅ | ✅ |
| `source` | `xiaomi` / `coros` | ✅ | ✅ |
| `startTimeUtc` / `endTimeUtc` | 起止时间 | ✅ | ✅ |
| `durationSeconds` | 时长（秒） | ✅ | ✅ |
| `distanceKm` | 距离（公里） | ✅ | ✅ |
| `avgPaceSecPerKm` | 平均配速（秒/公里） | ✅ | ✅ |
| `avgHeartRate` / `maxHeartRate` | 平均 / 最大心率 | ✅ | ✅（max 来自 FIT） |
| `calories` | 卡路里 | ✅ | ✅ |
| `location` / `startLat` / `startLon` | 位置 | ❌ | ✅ |
| `labelId` / `sportType` | 高驰活动 ID / 运动类型 | ❌ | ✅ |
| `totalAscentM` / `totalDescentM` / `avgPower` | 爬升 / 下降 / 平均功率 | ❌ | ✅（来自 FIT） |
| `steps` | 步数 | ✅ | ❌ |
| `file` | 原始文件名 | ✅ | ✅ |

## 网页看板（可视化）

`index.html` 是一个独立的暗黑主题数据看板，用 **ECharts**（图表）+ **Leaflet**（暗黑地图）实现，双击即可打开，或启动本地服务：

```bash
# 在项目目录下
python -m http.server 8080
# 浏览器访问 http://127.0.0.1:8080/
```

### 功能

页面以**个人运动健康**为视角呈现（不区分设备来源），轨迹与卡牌统一按**配速热力着色**（红快 → 蓝慢）。

- **KPI 卡片**：最大摄氧量 VO₂max、阈值配速、恢复状态、静息心率、累计里程/时长、平均配速、全马预测
- **体能评估**：VO₂max、跑力等级、阈值配速、恢复状态、比赛成绩预测（5k/10k/半马/全马）、绑定设备
- **轨迹地图**：CARTO 暗黑底图 + 全部 132 条轨迹（按配速着色），点击轨迹或列表联动查看
- **训练分析图表**：月度训练量、配速区间分布、配速趋势、心率趋势、心率区间分布（Z1–Z5）、配速×心率散点、年度热力图
- **健康与恢复图表**：训练负荷趋势（短期/长期/负荷比）、睡眠 HRV、静息心率、压力、睡眠结构
- **轨迹卡牌墙**：全部 132 次跑步的轨迹缩略图网格，点击联动地图与详情
- **单次详情**：选中活动后展示配速 / 心率沿时间变化曲线
- **活动列表**：可搜索、排序，点击行联动地图与详情

> 图表库已本地化到 `vendor/`（无需 CDN），仅地图底图瓦片需联网。数据由 `data.js` 提供（`tools/generate_data.mjs` 生成）。

## 在线访问（GitHub Pages）

已部署到 GitHub Pages，可通过以下网址直接访问（分享给朋友）：

**https://yifeigit.github.io/running-dashboard/**

- 每日自动同步：GitHub Actions 每天 **北京时间 08:00** 自动从 COROS 拉取最新数据并更新网页
- 手动触发：仓库 → Actions → Daily Sync → Run workflow
- 密钥：`COROS_TOKEN`（COROS 登录凭证，自动轮换写回）、`GH_TOKEN`（GitHub token）

## 一键同步（以后只用高驰）

每次跑完步后，运行：

```bash
node sync_coros.mjs
```

它会自动完成：

1. 从 COROS MCP 拉取**全部**运动记录（所有运动类型、全部历史）
2. 对比本地 `fit/` 目录，**只下载缺失的 FIT 文件**
3. 重新解析 FIT（fitdecode）与 TCX（小米历史）
4. 重新整合并更新 `activities.json` / `activities.csv`

> 依赖：Python 3 + `pip install fitdecode`，以及已登录的 `coros-mcp`（token 缓存于
> `~/.coros-mcp-skill-gateway-ts/cn/`，会自动刷新；若过期需重新 `coros-mcp login`）。

## 目录结构

```
运动数据分析/
├── tcx/                    # 小米历史（不再更新）
├── fit/                    # 高驰数据源（持续同步）
├── activities.json         # 统一数据集
├── activities.csv          # 表格版
├── summary.json            # 统计
├── sync_coros.mjs          # 一键同步脚本
└── tools/                  # 解析与辅助脚本
    ├── coros_mcp.mjs       # 通用 COROS MCP 调用工具
    ├── parse_fit.py        # FIT 解析（fitdecode）
    └── parse_tcx.py        # TCX 解析
```
