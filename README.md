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
