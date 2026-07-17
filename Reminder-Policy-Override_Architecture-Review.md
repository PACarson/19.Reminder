# Reminder Policy Override — Architecture Review & Optimized Design

**Status:** DRAFT — architecture review only, supersedes the original enhancement proposal pending Carson's decisions on the three open items in §7. Not implemented.

**Method:** 本文基于对 Personal-AI-main / Productivity-OS-main / Reminder-OS-main 三个项目实际源码与治理文档的审查（Connector Layer contracts、TaskIntentParser、TaskEngine、ReminderOffsetEngine、各自 Constitution/ADR/Known Limitations），而非仅从原始需求文本推演。原文档的若干假设与当前已实现的架构存在偏差，本文逐条订正并给出依据，力求成为可以直接替代原文档、进入实现阶段的版本。

---

## 0. 需求回顾（与原文档一致，未改动）

用户创建任务时可以直接覆盖默认提醒策略：

| 输入 | 行为 |
|---|---|
| `Pay rent tomorrow 3pm` | 使用默认策略（1天/1小时/15分钟前） |
| `Pay rent tomorrow 3pm remind me 30 minutes before` | 仅生成 1 条提醒：30分钟前 |
| `Doctor appointment Friday 9am remind me 3 days before and 2 hours before` | 生成 2 条：3天前、2小时前 |
| `Meeting tomorrow 2pm no advance reminder` | 不生成提前提醒（是否仍有到期提醒见 §3.3） |

---

## 1. 核心订正（vs. 原文档）

1. **Personal AI Core 本次是"零改动"，不只是"受限"。** 原文档写"Core MUST NOT calculate reminder times / MUST NOT implement reminder business logic"，方向对，但没说到点子上。实际情况是：`04_Main.gs` 对任务创建类输入，整句原文转发给 `ConnectorRegistry.invoke('Productivity', 'execute', 'HandleTaskIntent', {text}, {chatId})`，Core 自己完全不解析文本（见 `08_README.gs`「一、这一层解决什么问题」、`06_TaskIntentParser.gs` 的 `handleTaskIntent`）。只要 offset 短语识别做在 Productivity OS 的解析器里（见 §3.1），**Personal AI Core 和 Connector Layer（`08_` 前缀六个文件）本次不需要改一行代码**——这比"不碰业务逻辑"更强，值得明确写出来而不是留给隐含推导。

2. **"Reminder Rules" 不是要从零新建的抽象——它已经存在，形态比原文档描述的更具体。** 原文档的 pipeline（Task → Offset Engine → Reminder Rules → Scheduler → Dispatcher）读起来像是从零设计。实际上 `26_ReminderOffsetEngine.gs` 已经实现了 Rule / Occurrence / History 三表模型（`ReminderRules` / `ReminderOccurrences` / `ReminderHistory`，Reminder OS 自建自有），默认策略常量 `DEFAULT_REMINDER_OFFSETS_MINUTES = [1440, 60, 15]` 正好对应原文档"1天/1小时/15分钟"的例子，规则生成函数 `_ensureDefaultRules_` 也已经支持"空数组=关闭自动生成"的语义。这次要做的不是新建引擎，而是**给已有的规则生成逻辑新增第三个输入源（用户覆盖），同时保留另外两个（自动默认 / 直接改表）**。

3. **`reminder_policy` 长在 Task 记录上，不是权宜之计，是 Productivity OS 自己文档里已经预留过的模式。** `00_Known_Limitations.gs`（V4.7 补充）明确写着：Reminder OS 能读到 `due_time`/`due_datetime`，但"什么时候该提醒、提醒几次、怎么发通知"完全是 Reminder OS 自己的职责，**不会因为 Productivity OS 新增字段而产生任何反向依赖**。这段话几乎是在预先为"Task 上加字段、Reminder OS 读它但自己决定怎么用"这个模式背书，所以原文档 `reminder_policy` 的方向是对的，只是需要说清楚经由哪条既有通道传递（§2）。

4. **Parser Upgrade 放在 Productivity OS 是对的位置，但需要一次显式的边界扩展，不能悄悄加。** `00_Known_Limitations.gs` 给出的判断标准是：确定性的"解析时间/重复规则"在职责内，需要语义判断的"理解任务多急、归哪类"不在。"30 minutes before"和"tomorrow 3pm"是同一类可枚举、可正则匹配的时间表达式，不需要语义判断，延伸解析器合理——但解析范围此前被清楚记录为"止于 due_date/recurring"，这次需要仿照 V4.7 加 `due_time` 时的做法，显式补一条边界扩展记录，而不是隐式假设已经被允许（§3.1）。

5. **这次功能完全不需要打开 Reminder OS 的 Connector 写能力。** `08_ReminderConnector.gs` 现状是 `CreateReminder`/`UpdateReminder`/`DeleteReminder` 等六个写操作全部 `supported:false`（Reminder OS v1.0 不接受被当 Library 调用、不接 webhook，Constitution P2）。由于第 2、3 点的机制（Reminder OS 通过已有的只读 `QueryEngine` 通道读取 Task 数据），**这次功能不需要、也不应该触碰这个写能力缺口**——那是一个独立于本次需求、影响远更大的既有架构决策（是否打破 Reminder OS 的自主运作原则），不应该被"允许覆盖提醒策略"这个需求顺带触发。

---

## 2. 修正后的架构流程

```
用户输入（Telegram 原始文本，如
"Pay rent tomorrow 3pm remind me 30 minutes before"）
        │
        ▼
Personal AI Core · 04_Main.gs                                 ← 零改动
  ConnectorRegistry.invoke('Productivity', 'execute',
    'HandleTaskIntent', {text}, {chatId})   — 原文整句转发
        │
        ▼
Productivity OS · 06_TaskIntentParser.gs                       ← 改动 ①
  parseTaskIntent(rawText)
    → extractDateTime(text)  [09_TemporalParser.gs，改动 ②]
      现有：due_date / due_time / due_datetime / recurrence_rule
      新增：reminder_policy { offsets: [{value, unit}, ...] } | null
    → title = 剥离时间短语和 offset 短语之后剩下的文本
        │
        ▼
Productivity OS · IdempotencyManager → TaskEngine.createTaskDirect_   ← 改动 ③
  meta.reminder_policy 原样透传，存入 task.reminder_policy
  （JSON 字符串；不进 IDENTITY_AFFECTING_FIELDS，理由见 §3.4）
        │
        ▼
EventBus.publish('TASK_CREATED', task, ...)
  → ProjectionEngine.projectTaskCreated_ 通用透传                ← 已核实无需改动
        │
        ▼
Reminder OS · getPendingTasks()                                 ← 已核实无需改动
  （按表头通用读取，reminder_policy 自动出现在扁平对象上）
        │
        ▼
Reminder OS · 26_ReminderOffsetEngine.gs                         ← 改动 ④
  规则生成逻辑扩展（§3.2）：
    reminder_policy == null       → DEFAULT_REMINDER_OFFSETS_MINUTES
                                      （source: auto_default，现状不变）
    reminder_policy.offsets 非空   → 按这些 offset 生成
                                      （source: user_override，新增）
    reminder_policy.offsets == []  → 本轮不生成（天然幂等，见 §3.2）
```

**结论：Connector Layer 六个文件和 `04_Main.gs` 全程不出现在这条链路里，因为它们本来就不参与"提醒策略"这件事。** 修改只发生在 Productivity OS 的解析/持久化层和 Reminder OS 的规则生成层，与 Architecture Principles「Core 不碰提醒业务逻辑」完全一致，且是更强的版本——不是"被禁止碰"，是"结构上碰不到"。

---

## 3. 设计细节

### 3.1 解析范围扩展

`00_Known_Limitations.gs`「一、Natural Language Parser Scope」新增一条，格式仿照 V4.7 `due_time` 那次：

> **扩展草案：** Natural language parser scope 扩展为 due_date / due_time / due_datetime / recurring / **reminder_policy**。理由：reminder offset 短语（"N minutes/hours/days before"）与 due_date/recurring 属于同一类确定性时间表达式解析，不涉及语义判断——沿用本文件既有测试标准，不新引入一条。

对应扩展 Productivity OS 自己那份 `09_TemporalParser.gs`（注意与 Personal-AI-main 同名文件是两个独立文件，互不影响）的 `extractDateTime()`，识别原文档举的短语（`N minutes/hours/days before`、多个 offset 共存、"no advance reminder"），识别后从清洗后的 title 里一并剥离——这是 `_cleanTitle_` 既有逻辑的自然延伸。

### 3.2 Reminder OS 规则生成逻辑扩展

`_ensureDefaultRules_`（建议改名 `_ensureRulesFromPolicy_`）现有判断依据是"这个 `task_id` 在 `ReminderRules` 里有没有任何行"（`taskIdsWithRules`）。新版本在此之外先检查 `task.reminder_policy`：

- **null**：`taskIdsWithRules` 未命中时按 `DEFAULT_REMINDER_OFFSETS_MINUTES` 生成，`source: auto_default`——现状完全不变。
- **`offsets` 非空**：`taskIdsWithRules` 未命中时按这些 offset 生成，`source: user_override`——跟 auto_default 共用同一套"只在首次见到时生成"机制，不需要新的去重逻辑。
- **`offsets` 为空数组**：不生成任何规则行，**且不需要任何"已处理过"的标记**——"不生成"这个动作天然幂等，每轮重新读一次 `task.reminder_policy`（本来就要从 `pendingTasks` 里取）成本可忽略，不需要为了"记住已跳过"而造占位数据。这比原文档"materialize only Due Reminder"更简单，也避免把 §3.3 的开放问题带进这一层实现。

**需要 Carson 决定、不适合单方面假设的边界情况：** 若一个 task 已有人工直接改表加的 `source: manual` 规则行，创建时又带 `reminder_policy` override，`taskIdsWithRules` 会命中，override 会被静默跳过——这跟现有 auto_default 对 manual 的让步一致（先来后到），但这是新增的第三条路径，建议显式写注释说明这是沿用既有优先级，而非疏漏（对应 §7 第3项）。

### 3.3 关于"Due Reminder"——需要你决定，不是我可以替你定的

原文档"no advance reminder → only due reminder"这句话，在当前真实架构下有两种不冲突但语义不同的落地方式：

- **方案 A（推荐，改动更小）：** 把 `offset_minutes = 0` 当成 OffsetEngine 现有机制里的普通一员——`fireAt = effectiveDue - 0 = effectiveDue`，到期时刻触发一次。不需要 OffsetEngine 新增任何代码路径，"空数组"分支的行为从"不生成"改成"生成一条 offset=0 的规则"。
- **方案 B：** "Due Reminder"指现有 `25_ReminderEngine.gs`（V1，`checkReminders`，每小时触发，按 `REMINDER_INTERVAL_HOURS[priority]` 重复提醒直到完成）——即什么都不用做，因为 V1 和 V2（OffsetEngine）本来就是两套独立并行机制（各自 trigger：`checkReminders` 每小时、`checkOffsetReminders` 每5分钟），V1 完全不知道 `reminder_policy` 概念，不管这次改不改都会按自己节奏继续跑。

两者的真实产品行为不同：方案 A 是"到期那一刻提醒一次就不再提醒"；方案 B 是"到期前后按优先级持续重复提醒，直到任务完成或取消"。这是需要你确认的产品决策，不是实现细节。

### 3.4 IDENTITY / UPDATABLE_FIELDS

- `reminder_policy` 不建议加入 `IDENTITY_AFFECTING_FIELDS`——跟 `budget`/`notes`/`description`/`tags` 同类，是"关于任务的元信息"而非"任务本身是什么"，不应该让改一次提醒策略触发去重 identity 重算。
- 是否加入 `UPDATABLE_FIELDS`（创建后再改提醒策略）不在原始需求的三个例子范围内，建议作为明确的范围决定而非隐式假设（§7 第2项）。

### 3.5 已核实、确认不需要改动的部分

- **`10_ProjectionEngine.gs`**：`projectTaskCreated_` 是整个 event payload 通用 `upsertRowByKey_` 进 Tasks 和 ActiveTasks，`reminder_policy` 只要出现在 `TASK_CREATED` payload 里就会自动同步到两张表。（`reminder_count` 在 ActiveTasks 里被跳过是 `projectReminderSent_` 这个不同函数的行为，不影响 CREATE 路径。）
- **`22_QueryEngine.gs`（Reminder OS）**：按表头通用转成扁平对象，`reminder_policy` 列一旦存在于 ActiveTasks 会自动出现在 `getPendingTasks()` 返回值里——跟当年 `due_time`/`due_datetime` 免改这个文件同理。
- **`08_ProductivityConnector.gs` / `08_ReminderConnector.gs` / `08_ConnectorRegistry.gs` / `08_ConnectorTypes.gs` / `08_ConnectorResponse.gs` / `04_Main.gs`**：全程不参与这条链路（§1 第1点）。
- **`12_TemporalEngine.gs`（Reminder OS）**：ADR-004 已明确排除"提前N天/N小时提醒"类逻辑——这是 OffsetEngine 的简单减法，不是 TemporalEngine 的"重复规律"计算范畴。

---

## 4. Backward Compatibility（精确化）

原文档"no migration required"基本成立但需要精确一下：**不需要数据回填**（存量任务 `reminder_policy` 留空即等价于 null），**但需要一次 schema 迁移**（新增列本身）。建议仿照 V4.7 `due_time` 那次的既有模式，新增 `migrateSchemaReminderPolicy()`，不需要重跑整个 `setupSheets()`。"加列"和"填数据"是两件事，原文档措辞容易让人误以为完全不需要动任何迁移脚本。

---

## 5. Review Required 对照结果

| 检查项 | 结论 |
|---|---|
| Cross-domain leakage | 无新增——走的是"Task 字段、Reminder OS 只读"既有通道模式（`00_Known_Limitations.gs` V4.7 补充已预先允许） |
| CQRS violation | 无——`reminder_policy` 经 `TASK_CREATED` 事件 payload 走 Projection，未绕过 Event 直接写表 |
| Truth Layer | 无违反——Productivity OS 仍是 Task 数据唯一真相来源，Reminder OS 仍只读不写 |
| 业务逻辑重复 | 无——确定性的 offset 短语识别留在 Productivity OS；"何时真正触发、怎么发"的业务判断仍完全在 Reminder OS 的 OffsetEngine |
| Connector Layer contract | 无需变更（§3.5） |

---

## 6. Deliverables（沿用原文档编号，补充实际范围）

1. Architecture Review —— 本文档
2. ADR updates —— 视 §7 第1、2项决定而定
3. Schema changes —— `15_Setup.gs`（表头 + `migrateSchemaReminderPolicy()`）
4. Productivity Parser changes —— `06_TaskIntentParser.gs` + `09_TemporalParser.gs`（Productivity OS 版本）
5. Task persistence changes —— `20_TaskEngine.gs` + `09_IdempotencyManager.gs`
6. Reminder Offset Engine changes —— `26_ReminderOffsetEngine.gs`（`_ensureDefaultRules_` 扩展）
7. Unit tests —— 对应 4/5/6 各自现有测试文件扩展
8. Integration tests —— 端到端：一句话创建带 override 的任务 → 确认生成的是 override 而非默认值
9. Backward compatibility verification —— 无 `reminder_policy` 的存量任务，`_ensureDefaultRules_` 行为完全不变
10. Documentation updates —— `00_Known_Limitations.gs` + 本文档归档

**明确排除（原文档未排除，这里核实后排除）：** Personal AI Core 任何文件、Connector Layer 六个文件、`10_ProjectionEngine.gs`、`22_QueryEngine.gs`（Reminder OS）、`12_TemporalEngine.gs`。

---

## 7. 需要你决定的三件事

1. **§3.3 Due Reminder 语义**——方案 A（`offset=0` 规则，OffsetEngine 内统一处理）还是方案 B（维持 V1 现状不变，不新增语义）？
2. **ADR 归档位置**（新开一份还是作为现有 ADR 的又一轮 amendment）+ `UPDATABLE_FIELDS` 是否本次一并做？
3. **§3.2 人工规则的优先级让步**——接受"先来后到"（manual 优先于 override），还是希望 override 显式覆盖已存在的 manual 规则？
