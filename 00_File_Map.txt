/**
 * 00_File_Map.gs
 * Reminder OS v1.0 — 文件地图
 *
 * LAST_UPDATED: 2026-07-15 — 修复第五轮外部审计（HIGH RISK 1-4、MEDIUM
 * RISK 1、LOW RISK 1）+ 同日 GAS Console 实测3个问题，完整依据见
 * 00_ADR_002「第五轮外部审计」。2_Runtime/26_ReminderOffsetEngine.gs 和
 * 5_Testing/50_ReminderOffsetEngine_Tests.gs 首次补上占位记录（⚠️ 不是
 * 完整设计历史，该功能是第四轮之后新增的，见对应条目说明）；5_Testing
 * 新增 50_SheetUtils_Tests.gs/50_EventBus_Tests.gs/50_Output_Tests.gs。
 * 2026-07-11 — 拿到 Productivity OS 代码，解决第三轮外部
 * 审计遗留的 HIGH RISK 2：22_QueryEngine.gs 的 getPendingTasks() 改用
 * ActiveTasks 取候选任务+对 Tasks 定点查两个字段；21_SheetUtils.gs
 * 新增 batchReadFieldsByKey_；00_Project_Constitution.gs P3 正式修订
 * 读边界。
 * 2026-07-10 — 修复第四轮外部审计发现的 HIGH RISK 1/2/3、
 * MEDIUM RISK 1 共4项（EventBus 批量发布 Events、重试 trigger 清理、
 * 时间预算重新推导、Tasks 表定点字段更新）；核实 MEDIUM RISK 2/
 * LOW RISK 1 属实但不适合/不需要代码修复。完整决策依据见 00_ADR_002
 * 「第四轮外部审计」章节。
 * 2026-07-06 — 按 Domain OS Blueprint 全面重写；11_Setup.gs
 * 已替换为你提供的真实代码；修复第一轮外部审计对 25_ReminderEngine.gs /
 * 20_EventBus.gs 的 6 项发现；评估 Reminder OS V2 构想并规划分阶段
 * Roadmap；Phase A（Temporal Engine）完成 Contract 设计（A0）+ 实现
 * （A1），5_Testing 层第一次有内容；修复第二轮外部审计的 6 项发现，
 * 并发现修复一个既有的更严重 bug（last_reminder_at 从未写入）；修复
 * 第三轮外部审计发现（分批写+失败重试、lock竞争自动重试、正则简化），
 * 记录 Phase B 的 3 个 Open Questions 待日后回答。完整决策依据见
 * 00_ADR_001 到 00_ADR_004（见下）。
 */

// ============================================================
// 一、按 blueprint 层级列出的文件
// ============================================================

/**
 * ── 0_Governance ──────────────────────────────────────────
 *
 * 00_Project_Constitution.gs — 项目宪法。P1-P2 未变（P1 在第四轮审计后
 *   新增一段核实记录，结论仍是"未变"，见下），P3 更新为批量写入
 *   机制，P4 记录 HIGH RISK 2（上一轮）已修复，P5 记录 Domain OS Blueprint
 *   采用，P6 记录 Telegram callback 跨项目契约，P7 长期方向（一句话
 *   指向 ADR-003，不在 Constitution 里罗列细节）。【2026-07-10】P3 进一步
 *   更新为定点字段更新+Events批量发布，见下 21/25/20 三个文件的条目。
 * 00_Project_State.gs — 项目状态快照。本次更新：新增本轮 6 项审计修复的
 *   完成记录，「已知问题」新增 MEDIUM RISK 1（持续存在、非单边可修复），
 *   新增「长期方向」一节（Current/Future/Status 三行快照，指向 ADR-003）。
 *   【2026-07-10】新增第四轮 4 项修复的完成记录，「已知问题」新增
 *   MEDIUM RISK 2（Telegram 送达状态不确定），「下一步」新增两个第四轮
 *   引入的可调参数说明。
 * 00_File_Map.gs — 本文件。
 * 00_ADR_001_Domain_OS_Blueprint_Adoption.gs — 记录采用 blueprint 的
 *   背景、号段分配、文件映射表、以及几个关键判断（为什么
 *   SheetUtils/ReminderEngine 不拆分、Setup 归属哪层、Intelligence/Testing
 *   为什么留空）的完整理由。
 * 00_ADR_002_ReminderEngine_Audit_Fixes.gs — 记录外部审计对
 *   ReminderEngine/EventBus/SheetUtils/Output/Setup 四轮发现逐条核实+
 *   修复的过程，包括对个别审计原始建议的修正（比如 GAS 触发器不能绑定到
 *   IIFE 属性）、哪些问题只能"文档化+诊断"而不是"消除"、以及第四轮
 *   两处"审计建议的具体修法本身会引入新风险/跟既有架构决定冲突"因而
 *   改用其他方式处理的判断过程。
 * 00_ADR_003_Reminder_OS_V2_Vision_Evaluation.gs — 评估"Reminder OS V2"
 *   构想（7个引擎+schema扩展+Intelligence预留+8个Domain OS集成+11种
 *   事件类型），好的部分/担心的部分/建议范围；Architecture Roadmap
 *   （Phase A→F，按"确定性"分层——接口/草图/仅目的三种颗粒度）；
 *   Progression Rule（roadmap 不是 backlog，不因为列在上面就该做）；
 *   各 phase 的 Exit Criteria。STATUS: Proposed，范围待 Carson 拍板。
 * 00_ADR_004_Temporal_Engine_Design.gs — Phase A 拆成 A0（这份文档：
 *   Contract 设计）+ A1（实现，见 1_Foundation/12_TemporalEngine.gs）。
 *   定义 RuleSpec/Schedule Model 长什么样、四个函数的精确签名、
 *   Immutable/Pure Function/Dependency Rule 等约束、边界情况决定（比如
 *   monthly day_of_month 溢出时"跳过"而非"clamp"、every_n_days 的
 *   start_date 锚点）、V1 支持哪些规则形状/明确不支持哪些、Test Matrix。
 *   STATUS: Accepted，Gate Review 已过，A1 已实现并通过全部测试。
 *
 * ── 1_Foundation ──────────────────────────────────────────
 *
 * 10_SecureConfig.gs 〔原 01_SecureConfig.gs〕— Configuration。
 *   本地副本，逐字未改。
 * 11_Setup.gs 〔原 15_Setup.gs〕— Configuration（+部分 Testing/Validation，
 *   未物理拆分，见 ADR-001 判断5）。2026-07-06 收到真实代码后已替换掉
 *   最初的反推重建版；同日稍晚 runDiagnostics() 新增 Telegram webhook
 *   可达性检查（MEDIUM RISK 1 关联，见 ADR-002）。【2026-07-10】
 *   runDiagnostics() 新增 checkReminders 名下 trigger 数量检查（第四轮
 *   HIGH RISK 2 关联）。createTriggers() 逐字未改。
 * 12_TemporalEngine.gs — 【新增，Phase A / A1】通用日期规则计算引擎，
 *   Contract 见 00_ADR_004。不知道"提醒"，不调用本项目任何其他文件——
 *   刻意保持零依赖，方便以后整份文件复制到 Finance OS/Vehicle OS 等
 *   全新项目。Pure Function（无 IO/无 Logger/不读当前时间），Schedule
 *   Model 不可变。支持 daily/weekly/monthly/yearly/every_n_days 五种
 *   规则，V1 明确不支持的形状见 ADR-004。
 *   【2026-07-13，Disposition Review Finding 1/2】parseRule 收紧
 *   yearly 非法日期组合校验，calculateNextOccurrence 对不支持的
 *   schedule.type 显式 throw（原来静默返回 undefined）。
 *   【2026-07-15 第五轮审计 LOW RISK 1，见 ADR-004「2026-07-15 修订
 *   记录」】parseRule 返回前新增 Object.freeze(schedule)——Finding 3
 *   从 2026-07-13 的 Fix Later 提升为 Fix Now，Schedule Model 的不可变
 *   约定从"约定"变成运行时强制。
 *
 * ── 2_Runtime ─────────────────────────────────────────────
 *
 * 20_EventBus.gs 〔原 02_EventBus.gs〕— Event。
 *   精简版：只发 REMINDER_SENT，不需要本地 ProjectionEngine
 *   （EventBus.publish() 内部的 "typeof ProjectionEngine !== 'undefined'"
 *   检查会安全跳过）。【2026-07-06 修改】_sheet_() 新增惰性缓存
 *   （第一轮 LOW RISK 2），同一次执行内不再重复 openById；公开 API 和
 *   行为不变。第二轮审计的 MEDIUM RISK 1（并发实例下内存去重失效）
 *   核实属实但决定不修，理由见 00_Project_State.gs「已知问题」。
 *   【2026-07-10 第四轮，HIGH RISK 1】新增 publishBatch()，一次
 *   setValues() 写入多行，取代 25_ReminderEngine.gs 循环内逐条调用
 *   publish() 的单行同步写。原有 publish() 不变，继续保留作为单条发布
 *   的能力。
 *   【2026-07-15 第五轮审计，HIGH RISK 2】publishBatch() 内部实现改成
 *   逐行 appendRow()（不再是 getLastRow()+1 算起始行、一次 setValues()
 *   写连续多行）——后者"先读行数再写入"两步非原子，Reminder OS/
 *   Personal AI Core/Productivity OS 三个独立项目共享同一张 Events 表，
 *   并发写入时可能互相静默覆盖。appendRow 是 GAS 文档保证的原子操作，
 *   本文件的 publish() 一直用它、历次审计都没点名过，是同一个平台保证
 *   在起作用。对外行为/签名不变，只是内部从"1次多行写"变成"最多N次
 *   单行写"。新增 5_Testing/50_EventBus_Tests.gs（此前这个文件完全
 *   没有专属测试）。
 * 21_SheetUtils.gs 〔原 05_SheetUtils.gs〕— Projection（主：upsertRowByKey_/
 *   deleteRowByKey_/batchUpsertRowsByKey_/batchUpdateFieldsByKey_）+
 *   Decision 支撑（isOverdue_/parseDueDate_，供 ReminderEngine 用）+
 *   跨层通用工具（round1_/round2_/shallowCopy_/_cleanTitle_，历史上就是
 *   为了反重复实现才统一搬到这里）。
 *   横跨多个子分类但没有物理拆分，理由见 ADR-001 判断6。
 *   【2026-07-06 第二轮审计，LOW RISK 1】包进 IIFE（SheetUtils 模块），
 *   是最后一个完成这项改造的"引擎风格"文件，对外暴露 SheetUtils.xxx
 *   共11个函数，调用方（22_QueryEngine.gs/25_ReminderEngine.gs）同步
 *   改成命名空间形式。第二轮 MEDIUM RISK 2（单一共享 Spreadsheet 的
 *   容量/隔离顾虑）核实属实但决定不修，理由见 00_Project_State.gs
 *   「已知问题」。
 *   【2026-07-06 第三轮审计，LOW RISK】_cleanTitle_ 的正则从一个"锚定+
 *   交替分支"的写法拆成两次独立 replace（头/尾各一次），消除审计指出的
 *   回溯疑虑，行为完全等价。第三轮 HIGH RISK 2（QueryEngine 读整张表的
 *   性能问题，见下）核实属实但不在这个文件修，理由见
 *   00_Project_State.gs「已知问题」。
 *   【2026-07-10 第四轮审计，MEDIUM RISK 1】新增 batchUpdateFieldsByKey_：
 *   只读 key 列定位行号、只对实际改动的字段做单元格级定点写入，成本
 *   正比于本批大小而不是表总行数，取代 25_ReminderEngine.gs 分批持久化
 *   时复用的 batchUpsertRowsByKey_（那个函数每次调用都整表读写，成本
 *   正比于表总行数）。batchUpsertRowsByKey_ 本身不变，继续保留给真正
 *   需要"找不到就插入"语义的场景用。对外暴露函数数量从11个增加到12个。
 *   【2026-07-11，解决第三轮遗留的 HIGH RISK 2】新增
 *   batchReadFieldsByKey_：batchUpdateFieldsByKey_ 的读版本，只读 key
 *   列定位行号、对给定的一批 key 定点读取指定字段。给 22_QueryEngine.gs
 *   用，对候选任务列表从 Tasks 定点取 reminder_count/last_reminder_at。
 *   对外暴露函数数量从12个增加到13个。
 *   【2026-07-15 第五轮审计】三处改动：① parseDueDate_ 新增 Date 类型
 *   直接返回分支（GAS Console 实测 TypeError: raw.match is not a
 *   function——Sheets 日期格式单元格 getValues() 返回原生 Date 对象，
 *   不是字符串，见 ADR-002「第五轮」问题A）；② batchReadFieldsByKey_
 *   内部实现从"命中key数×字段数"次逐格 getValue() 改成一次包络
 *   getValues()+内存查找（HIGH RISK 3），对外行为/签名不变；③ 新增
 *   batchDeleteRowsByKey_（MEDIUM RISK 1 关联，只读 key 列一次、按
 *   行号降序批量删除，供 26_ReminderOffsetEngine.gs 用）。对外暴露
 *   函数数量从13个增加到14个。新增 5_Testing/50_SheetUtils_Tests.gs
 *   （此前这个文件完全没有专属测试，只测这次改到的三个函数）。
 * 22_QueryEngine.gs 〔原 12_QueryEngine.gs〕— Query。
 *   精简版，只有 getPendingTasks/getCompletedTasks/getTaskById。
 *   【2026-07-06】调用 SheetUtils 的方式同步改成命名空间形式
 *   （SheetUtils.getSheet_/SheetUtils.getHeaderMap_）。
 *   ⚠️ 第三轮审计 HIGH RISK 2：_readAllRows_ 每次都读 Tasks 表全部
 *   历史行（含早已 DONE/CANCELLED 的），表越大越慢——核实属实，当时
 *   因为看不到 Productivity OS 代码、无法评估有没有更好的数据源，
 *   没有在这里修，理由见 00_Project_State.gs「已知问题」（历史记录）。
 *   ✅【2026-07-11 已解决】拿到 Productivity OS 代码后，getPendingTasks()
 *   改为两步：①从 ActiveTasks（Productivity OS 实时维护、只含非终态
 *   任务的小表）取候选；②对候选列表用新增的
 *   SheetUtils.batchReadFieldsByKey_ 从 Tasks 定点取 reminder_count/
 *   last_reminder_at（权威数据仍在 Tasks，原因见文件头）。新增
 *   ACTIVE_TASKS_SHEET 常量（='ActiveTasks'，只读，不写）。
 *   getCompletedTasks()/getTaskById() 本项目目前无调用方，未跟着改，
 *   继续读全量 Tasks。完整决策依据见
 *   00_ADR_002_ReminderEngine_Audit_Fixes.txt「第三轮 HIGH RISK 2
 *   后续解决」。
 *   ⚠️ 本项目对 Productivity OS 数据的依赖范围从"只读 Tasks 表"扩大为
 *   "读 Tasks + ActiveTasks 两张表"，这是一处需要留意的跨项目耦合面
 *   扩大——完整边界定义见 00_Project_Constitution.gs P3
 *   「2026-07-11 更新」。
 * 25_ReminderEngine.gs 〔原 92_ReminderEngine.gs〕— Decision
 *   （_shouldRemind/_isOverdue/_hoursUntilDue）+ Execution
 *   （checkReminders/_buildReminder/_sendReminder/_recordReminderSent，
 *   后者会触发 Runtime/Event 和 Runtime/Projection）。横跨两个子分类但
 *   没有物理拆分，理由见 ADR-001 判断7。
 *   【2026-07-06 早些时候】_shouldRemind 修复上一轮 HIGH RISK 2：新增
 *   REMINDER_ADVANCE_HOURS 常量 + _hoursUntilDue 辅助函数，未逾期且距
 *   due_date 超过提前量时直接不提醒。里程类 due_date 不受影响。
 *   【2026-07-06 同日稍晚，第一轮外部审计6项发现，见 ADR-002】结构性
 *   重写：全部逻辑包进 IIFE（ReminderEngine 模块），只保留 checkReminders
 *   一个全局薄封装函数供 GAS 触发器绑定（MEDIUM RISK 2）；checkReminders
 *   循环内不再逐任务 upsertRowByKey_，改成收集后批量写（HIGH RISK 1）；
 *   _sendReminder 之间新增 Utilities.sleep(1000) 节流（HIGH RISK 2）；
 *   lock.waitLock 从 5000ms 延长到 30000ms（LOW RISK 1）；
 *   _updateReminderCount 改名 _recordReminderSent。
 *   【2026-07-06 第二轮外部审计，见 ADR-002「第二轮」】checkReminders
 *   再次重构：forEach 改 for 循环 + 时间预算机制（接近6分钟上限提前
 *   中断但保证已处理部分落盘，HIGH RISK 1新）；_sendReminder 返回发送
 *   结果，只有确认成功才更新状态（HIGH RISK 2新）；单任务 try/catch
 *   加固；调用 SheetUtils 的方式改成命名空间形式（isOverdue_→
 *   SheetUtils.isOverdue_ 等，LOW RISK 1新）。
 *   ⚠️ 同批顺带修了一个更严重的既有 bug（不在任何审计报告里）：
 *   _recordReminderSent 之前从未设置 task.last_reminder_at，导致
 *   REMINDER_INTERVAL_HOURS 的分级提醒间隔从未生效，所有任务每小时都
 *   会重发。已修复并补充回归测试验证。
 *   【2026-07-06 第三轮外部审计，见 ADR-002「第三轮」】批量写改成分批
 *   （_persistBatch，每20个已发送任务写一次），单批失败重试一次，不
 *   让异常拖累其他批次或往上抛（HIGH RISK 1新）；拿不到锁时安排一次性
 *   5分钟后重试（_scheduleRetryOnce + Script Property 防重复排队，
 *   不做无限链式重试），不再干等下一个整点（MEDIUM新）。审计另外两条
 *   （JSON.parse未捕获、UrlFetchApp deadline参数）核实后发现跟实际
 *   代码/GAS平台能力不符，没有改动，理由见 00_Project_State.gs
 *   「已知问题」。TemporalEngine"死代码"那条不是新问题，是已经记录过
 *   的刻意决定（见「长期方向」）。
 *   【2026-07-10 第四轮外部审计，见 ADR-002「第四轮」】四处修复：
 *   ① _recordReminderSent 不再直接调 EventBus.publish，改成把事件草稿
 *   塞进 pendingEvents 数组，checkReminders 跟 Tasks 批量写用同一套
 *   节奏调 EventBus.publishBatch（HIGH RISK 1新）；② 新增
 *   _cleanupStaleRetryTrigger_，checkReminders 最开头无条件调用，清理
 *   上一次 _scheduleRetry_（原 _scheduleRetryOnce 改名）建的一次性
 *   trigger，避免累积逼近20个trigger硬配额（HIGH RISK 2新）；
 *   ③ EXECUTION_TIME_BUDGET_MS 改成显式按"硬上限−最坏单任务耗时−
 *   安全垫"推导，BATCH_WRITE_CHUNK_SIZE 从20降到5（HIGH RISK 3新）；
 *   ④ _persistBatch 改调 SheetUtils.batchUpdateFieldsByKey_ 而不是
 *   batchUpsertRowsByKey_（MEDIUM RISK 1）。同时 RETRY_FLAG_KEY 语义
 *   从"布尔标记"改成"存 trigger uniqueId"，新增 RETRY_COUNT_KEY 支持
 *   最多 MAX_RETRY_ATTEMPTS(2) 次重试（原来只重试1次，LOW RISK 2新）。
 *   审计另外两条（MEDIUM RISK 2 送达状态不确定、LOW RISK 1 抽象层建议）
 *   核实属实但不适合/不需要代码修复，理由见 00_Project_State.gs
 *   「已知问题」和 00_Project_Constitution.gs P1。
 *   2026-07-03 拆分时的判断逻辑本身、发消息内容、按钮结构均未变。
 *   【2026-07-15 第五轮审计，HIGH RISK 4】checkReminders 的
 *   LockService.getScriptLock() 调用点新增注释，说明这把锁只能防止
 *   本项目自己并发执行、无法阻止 Personal AI Core/Productivity OS
 *   并发写共享表这一评估过程——核实属实但无法从本项目单方面解决，见
 *   00_Project_State.gs「已知问题」，逻辑本身未改。
 * 26_ReminderOffsetEngine.gs — ⚠️ 最小占位记录，不是完整设计历史。
 *   第四轮（2026-07-10/11）之后新增，经过多轮设计精化，引入了
 *   00_Project_Constitution.gs P8（保守演进作为审查默认）/P9
 *   （Reminder OS ≠ Calendar OS 的领域边界）两条新原则，但那个设计
 *   过程本身没有被记录进本文件或 00_Project_State.gs——完整回填需要
 *   单独排一次任务，见 00_Project_State.gs「下一步」#10。这里只记录
 *   这次（第五轮）审计实际touch到的部分：Decision（_resolveEffectiveDue
 *   Datetime_/_computeIdempotencyKey_/_offsetLabel_）+ Execution
 *   （checkOffsetReminders/_persistBatch_/_publishPendingEvents_），
 *   跟 25_ReminderEngine.gs 是同一脉络的姊妹引擎，处理的是"到期时间前
 *   N 分钟提醒"这类 offset 规则，不是 25_ReminderEngine.gs 已有的
 *   逻辑。三表模型 ReminderRules→ReminderOccurrences→ReminderHistory，
 *   参照 Tasks/ActiveTasks 先例。
 *   【2026-07-15 第五轮审计】HIGH RISK 1：resolved_fire_ats 每个
 *   channel 存的值语义从"上次的 fireAt"改成"上次解决时的到期时间
 *   快照"，修复到期时间改早时被误判成已处理的 bug；MEDIUM RISK 1：
 *   staleRuleIds（改名 ruleDeletes）并入批量 flush 节奏，_persistBatch_
 *   的规则删除和 occurrence 删除都改调新的 batchDeleteRowsByKey_；
 *   HIGH RISK 4：LockService 调用点新增跨项目锁评估注释，逻辑未改。
 *   【2026-07-15，GAS Console 实测】_resolveEffectiveDueDatetime_ 传给
 *   SheetUtils.parseDueDate_ 的 task.due_date 如果是 Sheets 原生 Date
 *   对象会抛错——根因在 parseDueDate_ 本身（21_SheetUtils.gs 条目里的
 *   问题A），已在那边加固，这个文件本身不用改调用方式。
 *
 * ── 3_Intelligence ────────────────────────────────────────
 *   （暂无文件，见 3_Intelligence/_RESERVED.txt）
 *
 * ── 4_Integration ─────────────────────────────────────────
 *
 * 40_Output.gs 〔原 03_Output.gs〕— APIs / External Systems（Telegram Bot
 *   API，本项目发消息的唯一出口）。核心发送逻辑逐字未改。【2026-07-10
 *   第四轮，MEDIUM RISK 2 关联】catch 分支新增 ambiguousDelivery 标记，
 *   用于区分"确定没发出去"和"可能已经送达但响应丢失"两种失败，纯诊断
 *   增强，不改变原有的返回结构（仍是 {ok, error}，只是多一个可选字段）。
 *   【2026-07-15，GAS Console 实测】sendMessage 在 Telegram 返回业务级
 *   失败（body.ok===false）时，原来直接转发 Telegram 的原始响应体
 *   （error_code/description 两个字段），没有补上本函数其余三条失败
 *   路径统一用的 error 字段——调用方（25_ReminderEngine.gs/
 *   26_ReminderOffsetEngine.gs）读 sendResult.error 对这条最常见的
 *   失败路径永远是 undefined，实测复现（见 ADR-002「第五轮」问题C）。
 *   补上 error 字段（取 description，没有就退化成 error_code），不
 *   删除原始字段。新增 5_Testing/50_Output_Tests.gs（此前这个文件
 *   完全没有专属测试）。
 *
 * ── 5_Testing ─────────────────────────────────────────────
 *
 * 50_TemporalEngine_Tests.gs — 【新增】这个 blueprint 层第一次有内容。
 *   覆盖 ADR-004 Test Matrix 的全部用例（daily/weekly/monthly/yearly/
 *   every_n_days 的正常情况+边界情况、闰年/世纪年、fromTime/untilTime
 *   精确命中、parseRule 非法输入、Immutable 验证、Reminder/Finance/
 *   Vehicle 三种视角的消费者验证）。GAS 没有现成测试框架，跟
 *   runDiagnostics() 一样的风格——手动跑、Logger.log 输出 PASS/FAIL。
 *   之前这里空的时候有 _RESERVED.txt 说明原因，现在有真实内容了，那份
 *   文件已经删除，不需要再带进 Apps Script 项目。
 *   【2026-07-13，Disposition Review Finding 4】新增 MAX_OCCURRENCES
 *   上限的自动化测试（原来零覆盖）。断言数 39→43。
 *   【2026-07-15 第五轮审计 LOW RISK 1】新增2个断言：直接验证
 *   Object.isFrozen(schedule) 为 true、验证对已冻结对象赋值静默失败
 *   不生效。断言数 43→45。
 * 50_ReminderOffsetEngine_Tests.gs — ⚠️ 最小占位记录，不是完整设计
 *   历史（跟 2_Runtime/26_ReminderOffsetEngine.gs 同样的缺口，见该文件
 *   条目说明）。涉及 SheetUtils/QueryEngine/EventBus/Output/LockService
 *   等一整套 GAS 平台依赖，只能通过 Node 沙盒（mocks.js +
 *   run_offset_tests.js 搭的内存版 GAS shim）运行，不支持直接贴进 GAS
 *   编辑器跑。【2026-07-15 第五轮审计】新增场景F：验证 HIGH RISK 1 的
 *   修复——到期时间改早、且改早前该 channel 已经 resolve 过时，不应该
 *   被误判为已处理；场景F对照组验证没有连带破坏"没改期就不重发"这个
 *   基本幂等性。断言数 28→32。resetAll() 直接在 GAS 编辑器里跑会报
 *   ReferenceError: global is not defined（GAS Console 实测，见
 *   ADR-002「第五轮」问题B）——不是这次改坏的，是这份文件设计上就只能
 *   走 Node 沙盒，被误当成能直接跑的入口函数调用了。修复：
 *   runReminderOffsetEngineTests 开头新增环境检测，检测不到 Node 沙盒
 *   特征时给出可操作的报错，不是让它假装能在 GAS 里跑。
 * 50_SheetUtils_Tests.gs — 【新增，2026-07-15 第五轮审计】
 *   2_Runtime/21_SheetUtils.gs 此前完全没有专属测试文件（唯一间接覆盖
 *   它的路径是 25_ReminderEngine.gs/26_ReminderOffsetEngine.gs 的集成
 *   测试，且 mocks.js 对 QueryEngine 用简化 mock，实际根本没走到
 *   batchReadFieldsByKey_）。只覆盖这次改到的三个函数（parseDueDate_
 *   的 Date 对象兼容、batchReadFieldsByKey_ 的包络读取重写、新增的
 *   batchDeleteRowsByKey_），不是 SheetUtils 全量覆盖——
 *   upsertRowByKey_/batchUpsertRowsByKey_/batchUpdateFieldsByKey_/
 *   isOverdue_ 这次没有改动，不重复补单测。18个断言，只能通过 Node
 *   沙盒（run_sheetutils_tests.js）运行。
 * 50_EventBus_Tests.gs — 【新增，2026-07-15 第五轮审计】
 *   2_Runtime/20_EventBus.gs 此前完全没有专属测试文件。只验证
 *   publishBatch 从 getLastRow()+setValues() 改成 appendRow 循环之后
 *   基本正确性不受影响（HIGH RISK 2）——"并发场景真的不会丢数据"这件
 *   事本身不是单元测试能验证的，这里验证的是重写没有引入正确性回归，
 *   不是验证了并发安全性本身。单条 publish() 这次没有改动，不重复
 *   补测。12个断言，只能通过 Node 沙盒（run_eventbus_tests.js）运行。
 * 50_Output_Tests.gs — 【新增，2026-07-15 第五轮审计】
 *   4_Integration/40_Output.gs 此前完全没有专属测试文件。只覆盖这次
 *   GAS Console 实测发现的 bug——sendMessage 在 Telegram 业务级失败时
 *   补上 error 字段（问题C），顺手确认 missing_token/missing_chat_id
 *   两条既有分支没有被这次改动影响到。8个断言，只能通过 Node 沙盒
 *   （run_output_tests.js）运行。
 *
 * ⚠️ 上面几份 Node 沙盒测试文件依赖的 mocks.js/run_*.js 不是 .gs 文件，
 * 贴进 Apps Script 项目时不需要带这几个 .js 文件，只带 50_*.gs。
 * run_offset_tests.js 原来硬编码的4个文件路径是上一次会话沙盒的绝对
 * 路径（/home/claude/work/output/*.gs），换个环境就读不到文件，
 * 2026-07-15 顺手改成相对本文件自身所在目录动态拼接；同时新增
 * run_sheetutils_tests.js/run_eventbus_tests.js/run_output_tests.js
 * （分别对应上面三份新测试文件）+ run_all_tests.js（一次性跑完全部
 * 4个 Node 套件并汇总结果，各自用独立子进程跑，避免多份 eval 进同一
 * 进程时互相污染全局命名空间）。
 */

// ============================================================
// 二、模块关系（文件名已更新为新结构）
// ============================================================

/**
 * 2_Runtime/25_ReminderEngine.gs
 *   → QueryEngine.getPendingTasks()                 [2_Runtime/22_QueryEngine.gs]
 *   → SheetUtils.isOverdue_ / SheetUtils.parseDueDate_ /
 *     SheetUtils.batchUpdateFieldsByKey_               [2_Runtime/21_SheetUtils.gs]
 *   → Output.sendMessage                             [4_Integration/40_Output.gs]
 *   → EventBus.publishBatch                           [2_Runtime/20_EventBus.gs]
 *   （2026-07-06 第一轮起：批量落盘不再是逐任务 upsertRowByKey_，见
 *   ADR-002 第一轮 HIGH RISK 1；第二轮起 SheetUtils 调用改命名空间形式，
 *   见 ADR-002 第二轮 LOW RISK 1；2026-07-10 第四轮起，落盘目标函数从
 *   SheetUtils.batchUpsertRowsByKey_ 换成 SheetUtils.batchUpdateFieldsByKey_，
 *   Events 写入从循环内逐条 EventBus.publish 换成分批 EventBus.publishBatch，
 *   见 ADR-002 第四轮 MEDIUM RISK 1 / HIGH RISK 1）
 *
 * 2_Runtime/22_QueryEngine.gs
 *   → SheetUtils.getSheet_ / SheetUtils.getHeaderMap_ /
 *     SheetUtils.batchReadFieldsByKey_                  [2_Runtime/21_SheetUtils.gs]
 *   → 读 ActiveTasks 表（Productivity OS 拥有并维护，本项目只读）
 *   （2026-07-11 起：getPendingTasks() 候选列表来自 ActiveTasks，
 *   reminder_count/last_reminder_at 从 Tasks 定点补全，见 ADR-002
 *   「第三轮 HIGH RISK 2 后续解决」。getCompletedTasks()/getTaskById()
 *   仍然只读 Tasks，未跟着改，见 22_QueryEngine.gs 文件头）
 *
 * 2_Runtime/20_EventBus.gs
 *   → SecureConfig.getKey('SPREADSHEET_ID')           [1_Foundation/10_SecureConfig.gs]
 *
 * 2_Runtime/21_SheetUtils.gs
 *   → SecureConfig.getKey('SPREADSHEET_ID')           [1_Foundation/10_SecureConfig.gs]
 *
 * 1_Foundation/11_Setup.gs
 *   → QueryEngine.getPendingTasks()                   [2_Runtime/22_QueryEngine.gs]
 *   → Output.sendMessage                              [4_Integration/40_Output.gs]
 *   → SecureConfig.getKey(...)                        [1_Foundation/10_SecureConfig.gs]
 *   → SpreadsheetApp.openById(...).getSheetByName('Tasks')  [直接读，不经过 SheetUtils]
 *   → UrlFetchApp.fetch(...getWebhookInfo)            [Telegram Bot API，直接调用，
 *                                                       2026-07-06 新增，MEDIUM RISK 1
 *                                                       关联，见 ADR-002]
 *
 * 1_Foundation/12_TemporalEngine.gs
 *   → （无）——刻意零依赖，只用 JS/GAS 内建能力，见 ADR-004 Dependency
 *   Rule。目前没有任何文件调用它（Phase B/Reminder Scheduler 还没做，
 *   见 00_ADR_003），只有 5_Testing/50_TemporalEngine_Tests.gs 在用。
 *
 * 本项目不依赖 Personal AI Core / Productivity OS 的任何代码，只是读写
 * 同一张共享 Spreadsheet 里 Productivity OS 拥有的 Tasks 表（读全部字段+
 * 写 reminder_count/last_reminder_at 两个字段）和共享的 Events 表
 * （只追加，不读不改别人写的行）。这一点 blueprint 重组前后没有变化。
 *
 * ⚠️ 提醒：GAS 是扁平命名空间，没有 import/require——上面这些箭头描述的是
 * "谁在自己函数体里调用谁的全局函数/变量"，不是文件间的强依赖关系；把
 * 所有文件贴进同一个 Apps Script 项目后，调用顺序不受物理文件名/资料夹
 * 影响。资料夹结构（0_Governance ... 5_Testing）只是这份交付和以后看
 * repo 时用来对应 blueprint 的组织方式，贴进 Apps Script 编辑器时全部会
 * 变成一份扁平文件列表，只看文件名，不认目录，详见 README.md。
 *
 * 关于"Reminder OS V2"构想（7个新 Runtime 引擎等）：Phase A（Temporal
 * Engine）已完成 A0（Contract，00_ADR_004）+ A1（实现，
 * 1_Foundation/12_TemporalEngine.gs + 5_Testing/50_TemporalEngine_
 * Tests.gs，全部测试通过）。Phase B 及之后（Reminder Scheduler/Snooze/
 * Escalation/Dispatcher/Analytics）都还没有任何实现文件或占位——按
 * Progression Rule，不会因为 Phase A 做完就自动开始 Phase B，需要先有
 * 实际需求或使用经验支撑。范围和分阶段规划见
 * 00_ADR_003_Reminder_OS_V2_Vision_Evaluation.gs 和
 * 00_Project_State.gs「长期方向」。
 */
