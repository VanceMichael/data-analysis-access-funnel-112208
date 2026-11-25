# 联合签署的流程依赖与可用性复核

时间为当周开门后的分钟，households 只记录已核实的复用许可。一次签署状态与申请办结状态独立。 所有资料均为合成记录。文件编码为 UTF-8，数字、日期及标记在原始记录中均以字符串保存。问号表示来源未能提供该值；加号分隔来源系统使用的组合编号。

## 资料

receipt里的已办结是当时确认事实。报表中最少样本按相互独立的家庭计；截止后受理的记录只供下一期。same team 同窗容量不相加，共用人数取表中同一时段上界。

- `households.json` 记录字段为 `family`、`student`、`app`、`proof`、`region`。
- `proofs.json` 记录字段为 `proof`、`at`、`status`、`mode`。
- `service.json` 记录字段为 `app`、`at`、`site`、`event`、`reference`。
- `capacity.json` 记录字段为 `site`、`window`、`team`、`mode`、`slots`、`shared`。
- `publication.json` 记录字段为 `report`、`channel`、`max_minutes`、`min_sample`、`as_of`、`state`。
- `commitment.json` 记录字段为 `app`、`accepted`、`deadline`、`report`。

- `period_observations.json` 记录字段为 `period`、`family`、`app`、`region`、`channel`、`ready`、`arrived`、`accepted`、`completed`、`observed_until`。
- `queue_receipts.json` 记录字段为 `reservation`、`app`、`site`、`at`、`kind`、`previous`。

period_observations 来自学校归档。W0 为开放远程前，W1 为开放后，时间按每期开门时重置。ready 为归档的首个可办分钟，observed_until 为观察止点。queue_receipts 为预约回执。

## 运行

使用 Node.js 22。项目无需下载第三方依赖。

```sh
npm ci --offline --ignore-scripts
npm test
```

`npm run data:check` 检查合成资料能否读取并核对相关记录的引用。资料校验脚本可以独立运行。

## 应用

这个仓库同时提供一个可运行的 Node.js 应用，让每期运营人员提交记录后核出真实等待、比较替代办理方案，并决定哪些服务可以对外承诺办结时间。

```sh
npm run check                       # 校验资料并给出整户状态摘要
npm start                           # 启动 HTTP 接口，默认 http://localhost:3000

node src/cli.js app A2 --as-of 50   # 单个申请的阶段、等待分段、卡点
node src/cli.js family H1           # 整户视图（一个孩子办结不关闭整户）
node src/cli.js month --period W1   # 周月报
node src/cli.js compare --before W0 --after W1
node src/cli.js shift --site 校甲 --from 远程 --to 窗口
node src/cli.js eligible --site 校乙
node src/cli.js reassign --app A2
node src/cli.js publication R01
node src/cli.js duty --team E1
node src/cli.js submit queue_receipts new-receipts.json
```

HTTP 接口（GET 查询，POST/PUT 提交）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/apps/:app?asOf=` | 生命周期与等待分段 |
| GET | `/families/:family?asOf=` | 整户视图 |
| GET | `/reports/monthly?period=&asOf=` | 每周月报 |
| GET | `/compare?before=&after=` | 远程开放前后比较 |
| GET | `/publications/:report` | 按公开规则核对承诺 |
| GET | `/eligible?site=&mode=&asOf=` | 当前可进入流程的客群 |
| GET | `/reassign?app=&asOf=` | 被改派人的准备状态与结局 |
| GET | `/shift?site=&from=&to=` | 协助时段转移的效果 |
| GET | `/commitments?asOf=` | 承诺清单与失约风险 |
| GET | `/duty?team=&asOf=` | 值班组：实际队列与调人风险 |
| POST | `/`:表名 | 追加记录并写回 `data/` |
| PUT | `/`:表名 | 整表替换并写回 `data/` |

### 已落实的业务规则

- **阶段与"具备下一步条件"**：`src/lifecycle.js` 把每个申请拆成家庭证明、学生窗口、办结三个阶段。只有真正具备下一步条件的阶段才会成为 `nextActionable`。真实零等待、尚未走完、观测中断、无需此步是四种独立状态（`WAIT_STATUS`），分别报告，不互相抵消。
- **整户不因一份结果关闭**：`familyLifecycle` 只有全部孩子办结才 `closed`，并列出 `keepOpenFor`。
- **共用证明的撤销**：共用证明被撤销会堵住仍未办妥的关联申请；撤销发生**之前**业务已确认受理/办结的申请仍可复核（`shielded`）。
- **真实等待的起点**：排队从实际到场起算，计划预约/改约时间永不计时。`waitBreakdown` 输出签署、到场前、排队、办理四段，并保留被截尾的未完成段。`avoidable` 另给出"本可更早受理"的参照差，但不冒充真实等待。
- **跨点再预约**：旧点占用只在新点"已接受"后释放（`occupiedReservations`）。"待接受"和"申请失败"都不释放。
- **月报**：`monthlyReport` 按入口给出首个可办时间、整户与单个学生两套办结分布、以及未完成原因分桶。最少样本按家庭计；截止后受理的记录进入 `deferred`。
- **开放前后比较**：`compareRemoteBeforeAfter` 以共享证明为单位合并同一家庭的多个观测，不把两个孩子当作两份独立证据。
- **被改派人的估值**：`reassignmentEstimate` 明确区分"已知准备状态"和"仍未成熟的结局"。
- **名额与协助时段**：`shiftAssistance` 对同一 team 同窗的 `shared=yes` 名额取上界、不相加，净增为 0，并提示不能假设名额兼顾两边。
- **拟议客群**：`eligibleCustomers` 要求当前可进入流程，排除跨点失败、提前退出、证明撤销、已办结、以及仍在别处占用排队者。
- **服务承诺**：`checkPublication` 按公开报表规则逐期核对观察覆盖（按家庭独立计）与办结上界，不把 W0 与 W1 混成一个样本；未签发报表（`待签`）不能对外承诺。`commitmentForApp` 让改派沿用原期限。`channelEvidenceChange` 在资料更正后停掉该渠道后续新承诺、标出既有预约风险，其他渠道照常。
- **值班组**：`dutyView` 按实际队列（实际到场所在点，而非申请类别）汇总未完成人数，并说明调人先损及哪类观测事实。

### 模块

| 文件 | 职责 |
| --- | --- |
| `src/normalize.js` | `?` 与组合编号的解析、区间与统计工具 |
| `src/schema.js` | 来源表字段规范与提交校验 |
| `src/store.js` | 数据目录的读写与克隆 |
| `src/model.js` | 索引与事件词表 |
| `src/lifecycle.js` | 阶段判定、整户视图、预约占用 |
| `src/waiting.js` | 等待分段与节省估计 |
| `src/reporting.js` | 月报与首个可办时间 |
| `src/planning.js` | 方案比较、承诺核对、值班视图 |
| `src/ops.js` | 资料自检与运营摘要 |
| `src/cli.js` / `src/server.js` | 命令行与 HTTP 入口 |

原始记录始终以字符串保存。应用只在提交时校验，不会悄悄改写来源值。
