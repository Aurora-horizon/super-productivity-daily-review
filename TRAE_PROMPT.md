# Trae + Super Productivity 自动排程说明

## 结论

Super Productivity 19.1.0 自带本地 REST API，Trae 可以直接调用它写入任务，不需要再手动导入 JSON。

数据链路：

```text
你对 Trae 说任务
→ Trae 生成 plan.json
→ Trae 运行 sp-plan.ps1
→ sp-plan.ps1 调用 http://127.0.0.1:3876
→ Super Productivity 创建或更新任务
→ “每日复盘与计划”插件自动显示时间线、日历和趋势
```

## 一次性设置

1. 打开 Super Productivity。
2. 进入“设置 → 杂项”。
3. 打开“启用本地 REST API”。
4. 确认下面显示访问令牌。
5. 暂时不要关闭 Super Productivity。

访问令牌会保存在本机：

```text
%APPDATA%\superProductivity\local-rest-api-token
```

`sp-plan.ps1` 会依次尝试读取令牌文件、剪贴板和 `SP_REST_TOKEN` 环境变量。若脚本提示找不到令牌，请让用户复制“设置 → 杂项 → 访问令牌”，再运行一次；也可以通过环境变量传递：

```powershell
$env:SP_REST_TOKEN = "这里粘贴令牌"
```

不要把令牌写进 Git 仓库、截图或公开聊天。

## 给 Trae 的项目规则

把下面整段放进 Trae 的项目规则或每次对话开头：

```text
你是我的 Super Productivity 每日计划助手。

当我用自然语言告诉你日期和任务时，你需要：

1. 结合可用时间、固定日程、任务优先级、预计时长，生成可执行计划。
2. 严格遵守下面的计划 JSON 结构。
3. 将结果保存为当前工作目录下的 plan.json。
4. 运行：
   powershell -ExecutionPolicy Bypass -File "sp-plan.ps1" -PlanFile ".\plan.json"
5. 把脚本输出的“新建、更新、跳过、失败”数量告诉我。
6. 如果脚本报令牌或本地 REST API 错误，不要修改 Super Productivity 数据库，直接把错误告诉我。

计划 JSON：

{
  "version": 1,
  "defaults": {
    "project": "工作",
    "estimateMinutes": 30
  },
  "tasks": [
    {
      "id": "YYYY-MM-DD-序号",
      "date": "YYYY-MM-DD",
      "title": "具体、可执行的任务标题",
      "start": "HH:MM",
      "estimateMinutes": 45,
      "project": "项目标题",
      "tags": ["标签"],
      "notes": "补充信息"
    }
  ]
}

排程规则：

- 固定日程优先。
- 任务之间至少留 10 分钟缓冲。
- 单个任务优先拆成 25–90 分钟。
- 不要把任务排到可用时间之外。
- P0 放在精力较好的时段，P1 次之。
- 任务标题动词开头，避免“处理一下”“继续推进”等模糊表述。
- 只使用 Super Productivity 中已有的项目和标签。
- 同一天重复生成时保持相同 id，便于脚本更新而不是重复创建。
- 每次最多 100 个任务。
- 只写 plan.json 和调用脚本，不直接修改 IndexedDB、备份文件或同步数据库。
```

## 日常使用示例

你对 Trae 说：

```text
帮我安排 2026-10-24：
- 09:00-12:00 要写周报，预计 90 分钟
- 下午要整理下周计划，预计 40 分钟
- 回复合作方邮件，P1，20 分钟
- 15:00-15:30 有会议
- 12:00-13:00 午餐
```

Trae 应生成类似：

```json
{
  "version": 1,
  "defaults": {
    "project": "工作",
    "estimateMinutes": 30
  },
  "tasks": [
    {
      "id": "2026-10-24-1",
      "date": "2026-10-24",
      "title": "撰写周报",
      "start": "09:00",
      "estimateMinutes": 90,
      "project": "工作",
      "tags": ["专注"]
    },
    {
      "id": "2026-10-24-2",
      "date": "2026-10-24",
      "title": "整理下周计划",
      "start": "13:30",
      "estimateMinutes": 40,
      "project": "工作",
      "tags": ["规划"]
    },
    {
      "id": "2026-10-24-3",
      "date": "2026-10-24",
      "title": "回复合作方邮件",
      "start": "15:40",
      "estimateMinutes": 20,
      "project": "工作",
      "tags": []
    }
  ]
}
```

然后 Trae 自动执行：

```powershell
powershell -ExecutionPolicy Bypass -File "sp-plan.ps1" -PlanFile ".\plan.json"
```

## 脚本行为

- `POST /tasks` 创建任务。
- `PATCH /tasks/:id` 更新同一计划 ID 的已有任务。
- 任务备注中写入 `<!-- sp-plan:ID -->`，用于去重。
- `start` 会转换为 `dueWithTime`。
- 没有 `start` 的任务使用 `dueDay`。
- `project` 支持项目标题或 ID。
- `tags` 支持标签标题或 ID。
- 未知项目会报错，未知标签会警告并跳过。
- 默认在终端输出每一项的新建或更新状态。

## 安全事项

本地 REST API 只监听 `127.0.0.1:3876`，并且需要 Bearer Token。不要：

- 把 3876 端口映射到局域网或公网。
- 把令牌写入仓库或公开文档。
- 让插件或脚本获得 `nodeExecution` 权限。
- 直接用脚本修改 Super Productivity 的 IndexedDB 或同步数据。

如果不再需要自动排程，关闭“设置 → 杂项 → 启用本地 REST API”即可。
