# Reminder Policy Override — Architecture Review & Optimized Design

**Status:** IMPLEMENTED（2026-07-17）— 架构评审通过后已完成实现，见文末「实现记录」。Carson confirmed the three open items in §7. Supersedes the original enhancement proposal.

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

`_ensureDefaultRules_`（建议改名 `_ensureRulesFromPolicy_`）现有判断依据是"这个 `task_id` 在 `ReminderRules` 里有没有任何行"（`taskIdsWithRules`）。这个"只在首次见到时生成一次"的门槛，正是需要配合决定 #3（Task > ReminderRules，§7）一起明确的地方：

- **null**：沿用现有 `taskIdsWithRules` 门槛，按 `DEFAULT_REMINDER_OFFSETS_MINUTES` 生成，`source: auto_default`——现状完全不变。这类 task 没有具体的"Task 侧权威值"可供比对（null 只表示"用默认策略"，不是一条具体声明），**现有"直接改表"escape hatch 对这类 task 维持不变**：人工改过之后不会被自动纠正回默认值。这与决定 #3 不冲突——Task > ReminderRules 针对的是 Task 上有具体内容需要保持一致的情况，null 没有这样的内容。
- **`offsets` 非空（用户创建时显式指定）**：这类 task 才是决定 #3 真正适用的对象——`reminder_policy` 是明确 Truth，ReminderRules 是它的 Projection。落地方式见下。
- **`offsets` 为空数组**：不生成任何规则行，不需要标记——已由决定 #1 确认为最终行为，见 §3.3。

**决定 #3 落地时机——已由 Carson 最终确认，窄口径。** Offset Engine 第一次发现该 task（`taskIdsWithRules` 未命中）时，按当时的 `task.reminder_policy` 生成规则；生成完成后不再持续比对。理由不是省扫描次数，而是保持 Reminder OS 现有"首次物化、后续只调度"这一运行模型和职责边界——手工直接改表（或改共享 Sheet）是本阶段之外的 escape hatch，不在这次的自动纠正范围内；未来如果加入"编辑 reminder policy"能力，由那个能力自己设计 Re-materialization/Rebuild 流程，不让 Offset Engine 的热路径承担持续一致性检查。

*实现层面一个极小的精确点（LOW，不影响上述决定，仅供写代码时对齐）：* "首次物化"应理解为"生成动作以 `reminder_policy` 为准"，而不是"`taskIdsWithRules` 命中就整体跳过"——避免任务刚创建、Offset Engine 还没来得及处理之前，如果碰巧已经有一行手工数据，导致这次物化被完全跳过、`reminder_policy` 从未真正生效过。这是现有 `taskIdsWithRules` 门槛本来就有的一个理论边界情况（对 auto_default 同样成立，从未出现过实际问题），沿用 Evidence-first 原则不作为新风险处理，只作为实现时的对齐说明。

### 3.3 "Due Reminder" 语义——已由决定 #1 确认

采用方案 B：`reminder_policy.offsets = []` 语义只有一个——不建立任何 Offset Reminder。不关闭现有 V1（`25_ReminderEngine.gs`）的到期提醒，不自动产生 offset=0 特殊规则。理由：Offset Reminder（提前提醒）和 Due Reminder（到期提醒）是两种不同职责，前者是 Offset Policy 管辖的全部范围；后者继续完全由 V1 按既有 `REMINDER_INTERVAL_HOURS` 逻辑负责，不为一个空 offset 引入新的特殊规则。OffsetEngine 侧因此不需要为空数组分支新增任何代码路径。

### 3.4 IDENTITY / UPDATABLE_FIELDS

- `reminder_policy` 不建议加入 `IDENTITY_AFFECTING_FIELDS`——跟 `budget`/`notes`/`description`/`tags` 同类，是"关于任务的元信息"而非"任务本身是什么"，不应该让改一次提醒策略触发去重 identity 重算。
- `UPDATABLE_FIELDS`：已由决定 #2 确认本轮**不做**。本次仅覆盖 Create 流程；"创建后修改 reminder policy"是独立能力，不顺带实现，未来需要时另开 ADR/Phase。

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
2. ADR updates —— 记录决定 #1/#2/#3，以及 §3.2「决定 #3 落地时机」的最终口径；挂靠新 ADR 还是现有 ADR 的 amendment，仍待你指定
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

## 7. 决定记录（已闭环）

**已由 Carson 确认（2026-07-17）：**

1. **Due Reminder 语义**——方案 B：V1 保持不变，不新增 offset=0 特殊规则（§3.3）。
2. **范围**——本次只做 Create 流程；「创建后修改 reminder policy」不在本次范围内，需要时另开 ADR/Phase（§3.4）。
3. **冲突优先级原则**——Task.reminder_policy 是唯一 Truth Source，ReminderRules 是 Materialized Projection，Task > ReminderRules（§3.2）。
4. **落地时机**——窄口径：只在 Offset Engine 首次物化该 task 时生效，不引入持续 Rebuild；手工改表是本阶段之外的 escape hatch；未来若支持编辑 reminder policy，由那个能力自行设计 Re-materialization 流程（§3.2）。

五项原则全部保持成立：Core Connector 不改 / Reminder OS Connector 只读 / Productivity Parser 解析自然语言 / Reminder OS 物化规则（首次物化，非持续） / 完全向后兼容。未发现新的 HIGH/MEDIUM 风险，设计阶段结束，可进入实现。

---

## 8. 实现记录（2026-07-17）

**改动文件（只列有改动/新增的，按 Carson 的既有惯例，.gs 以 .txt 交付）：**

Reminder OS：`26_ReminderOffsetEngine.txt`（核心引擎逻辑）、
`50_ReminderOffsetEngine_Tests.txt`（新增场景 G/H/I + `_offsetToMinutes_`
纯函数测试）、`00_ADR_006_Reminder_Policy_Override.txt`（新建）、
`00_Project_State.txt`（追加变更记录）。

Productivity OS：`09_TemporalParser.txt`（新增 `_extractReminderOffsets_`）、
`06_TaskIntentParser.txt`、`20_TaskEngine.txt`、`15_Setup.txt`、
`11_ProjectionRebuilder.txt`（新增 `migrateSchemaReminderPolicy`）、
`00_Known_Limitations.txt`、`00_ADR.txt`（新增
ADR-2026-07-17-009）、`34_Tests_ReminderPolicy.txt`（新建）。

**实现过程中发现、需要你知道的两件事：**

1. **实际解析器是中文优先的，原始需求文档的英文例子只是示意。** 09_TemporalParser.gs 里其余的日期/重复规则识别（"明天"、"下周"、"每天"）全部只认中文，00_Known_Limitations.gs 早就明确记录"不支持英文日期/重复说法"。这次新增的 offset 短语识别因此做成中英文都支持——中文（"提前30分钟提醒我"）匹配这份解析器实际的使用语言，英文（"remind me 30 minutes before"）逐字匹配原始需求文档举的例子——两者字符集不重叠，同时支持不冲突。具体识别规则见 09_TemporalParser.gs 函数头注释的"已知限制"（比如要求"提前"/"remind me"字面出现，多个 offset 需要连接词）。

2. **Productivity OS 的 `00_Project_State.txt` 这次没有改。** 打开后发现这份文件实际记录的是"Rider OS"（同一个仓库里的另一个子域——预约/奖励那部分，31_ReminderQueue.gs/27_BookingEngine.gs 所在的领域）的状态快照，不是 Task 管理这部分的。Task 域的变更记录已经写进 00_ADR.txt 的 ADR-2026-07-17-009，但如果 Task 域本身也应该有一份对应的"当前快照"文件、只是我没找到，需要你指一下具体在哪，我可以补上。

**验证：** Reminder OS 侧完整跑了现有测试 harness（`node run_offset_tests.js`），51 项全部通过（含新增的 G/H/I 三个场景和 `_offsetToMinutes_` 的 5 个断言）。Productivity OS 侧没有现成的 Node harness，我用同样的方式手动搭了一个（eval 实际的 `09_TemporalParser.txt`/`06_TaskIntentParser.txt`/`34_Tests_ReminderPolicy.txt` 源文件本身，不是重新抄一遍逻辑），19 项断言全部通过，覆盖原始需求文档三个例子（含英文）、七个中文等价表达、两个误伤规避场景、title 清洗残渣检查、以及 `_formatReminderPolicyDisplay_` 的五种展示情形。两边都是真正执行的结果，不是只做了语法检查。
