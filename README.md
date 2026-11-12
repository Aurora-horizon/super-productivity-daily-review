# 每日复盘与计划 · Super Productivity Plugin

> **English summary** — A local-first daily review plugin for [Super Productivity](https://github.com/johannesjo/super-productivity). It snapshots each day's plan and reports consistent completion stats: on-time, late-checked, extra and missed are counted separately, so numbers never inflate each other. Overdue tasks get a triage queue (move to today / reschedule / mark as unachievable with a reason); recurring and series tasks never pile up duplicates; half-month archives work around the 256 KiB plugin-storage limit. Everything is stored on your machine — the plugin makes no network requests. Requires Super Productivity 19.1.0+.
>
> Changelog and per-version source are available through git tags (`git checkout v2.11.0`), and installable ZIPs are under [Releases](../../releases).

一个为 [Super Productivity](https://github.com/johannesjo/super-productivity) 写的本地复盘插件：把每天的计划、完成情况和未完成原因沉淀下来，用环形完成率、日历和趋势图回答一个问题——**这一周到底做成了什么**。

数据全部留在本机，插件不上传任何内容。

> 兼容 Super Productivity **19.1.0** 及以上版本。

## 它解决什么问题

Super Productivity 擅长"执行"，但不擅长"回看"。任务勾完就归档，逾期任务会被默默遗忘，几周后很难说清时间花在哪里、哪些计划长期落空。

这个插件的做法是：在任务数据之上叠一层**每日计划快照**，然后围绕快照给出一致口径的统计。

- **完成率有明确口径**：按时完成、补勾完成、额外完成、错过分别计算，不会互相灌水。
- **逾期有出口**：逾期任务进入队列，可以移到今天、重新安排，或标记"无法完成"并记录原因。
- **长期任务不叠加**：每日 / 短期 / 长期任务过期即按当天错过结算，不会滚成第二天的双份。

## 功能

- **每日视图**：环形完成率、带钟点的任务时间线、按状态分组的全天任务、任务详情滑入抽屉
- **双向勾选**：插件内直接勾选或取消，实时同步回主应用；已归档任务受官方 API 限制保持只读
- **逾期队列**：只汇总逾期的一次性任务，支持移到今天、顺延、重新安排、撤销改期
- **每日收尾**：「结束今天」逐项选择顺延、补勾完成或保持未完成，保存日结时的完成率
- **任务类型**：每日 / 一次性 / 短期 / 长期四类，短期与长期可填持续天数
- **任务系列**：每日、短期、长期任务按未来 7 天自动补齐，每个日期只生成一次，可暂停
- **完成日历**：月历展示每天完成率与任务点，点击进入当天明细
- **趋势**：30 天完成率折线，含 80% 目标线、近 7 天变化与原因分布
- **半月归档**：自动生成半月归档文件，突破插件同步数据 256 KiB 的写入上限
- **新建任务**：插件内直接建任务，走官方 `addTask` / `updateTask`

## 安装

1. 在 Releases 下载最新的 `daily-review-plugin-vX.Y.Z.zip`。
2. 打开 Super Productivity → `设置 → 插件 / Plugins`。
3. 导入该 ZIP 并启用「每日复盘与计划」。
4. 首次启用时允许插件的 Node 文件执行权限（用于写入归档文件）。
5. 打开插件的「归档」页，点一次「立即整理并导出」。

升级前建议先在旧版里「导出复盘」，避免数据口径变化时丢失历史。

## 从源码构建

仓库根目录就是插件本体（ZIP 解压后的结构），`index.html` 由 `build.js` 从 `index.source.html` 生成：

```bash
node build.js
```

`build.js` 会把内联脚本用 gzip 压缩并 base64 内联进 `index.html`，把发布包从约 103 KB 压到约 57 KB（需 Node 18+）。

打包：

```powershell
Compress-Archive -Path manifest.json,plugin.js,index.html,index.source.html,icon.svg,README.md `
  -DestinationPath daily-review-plugin.zip -Force
```

## 数据与隐私

- 复盘数据保存在插件同步键 `daily-review-data-v1`，可通过顶部「导出复盘」导出 JSON。
- 归档文件写入本机应用目录下的 `daily-review-plugin/archives/<年份>/<开始日期>_<结束日期>.json`。
- 单次写入上限 256 KiB，插件会在每次保存前检查并收缩到约 150 KiB，优先保留最近约 16 天的任务明细。
- 每个历史日期都保留一条轻量统计摘要，摘要默认保留约两年。
- 插件只读写本机文件，不发起任何网络请求。

## 计划自动化（可选）

插件本身不负责排程。仓库里的 [`TRAE_PROMPT.md`](TRAE_PROMPT.md) 记录了配合 Super Productivity 本地 REST API（`http://127.0.0.1:3876`）的自动写入方案：由外部助手生成 `plan.json`，再用脚本写入任务，插件负责展示与复盘。

该配套脚本不在本仓库内，需要按 `TRAE_PROMPT.md` 的说明自行实现；令牌保存在 `%APPDATA%\superProductivity\local-rest-api-token`，**不要提交到仓库**。

## 已知限制

- 已归档任务无法通过 Plugin API 修改完成状态，界面上勾选框为禁用状态。
- 已完成任务的详情不再可编辑（上游 API 行为）。
- 归档依赖 `nodeExecution` 权限；未授权时插件仍可正常复盘，只是不生成半月归档文件。
- 插件数据受同步机制限制，不适合存放超过数百 KiB 的明细，这也是引入半月归档的原因。

## 版本历史

完整变更见 [CHANGELOG.md](CHANGELOG.md)。每个版本都有对应的 git tag，可直接查看该版本的完整源码：

```bash
git checkout v2.9.4
```

## 许可证

[MIT](LICENSE)
