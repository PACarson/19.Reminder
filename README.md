Reminder OS
2026-07-03 从 Personal AI Core 拆出来的独立项目。定位：全平台共享的
时间与通知服务——不是 Productivity OS 专属，未来 Property/Finance/
Vehicle OS 的到期提醒也会用这一套（见 Personal AI Core 项目
`00_Project_Constitution.gs` 的 D2/D5）。
这个项目完全独立运作
不接 Telegram webhook，不被谁当 Library 调用——它靠自己的时间触发器
主动醒来、主动查、主动发消息。跟 Personal AI Core / Productivity OS
唯一的联系是"读写同一张共享 Google Sheet"。
部署步骤（在 Productivity OS 之后、Core 之前或之后都可以）
1. 新建 Apps Script 项目，把本 zip 里全部 `.gs` 文件粘贴进去
2. 设置 Script Properties
`SPREADSHEET_ID` —— 跟 Core / Productivity OS 项目【同一张】表的 ID
`TELEGRAM_TOKEN` —— 跟 Core 项目一样的 Bot Token（这个项目自己直接发
消息，不经过 Core，所以需要自己也配一份）
`TELEGRAM_CHAT_ID` —— 跟 Core 项目一样
3. 跑一次 `createTriggers()`
挂上 `checkReminders`（每小时）。不需要建任何新 Sheet——Tasks 表已经在
共享 Spreadsheet 里了（Productivity OS 建的）。
4. 跑一次 `runDiagnostics()` 验证
应该能看到"能读到 Tasks 表"和一条测试 Telegram 消息。
文件清单
文件	说明
`92_ReminderEngine.gs`	核心提醒逻辑，只改了 2 处（见下）
`01_SecureConfig.gs` / `03_Output.gs`	逐字未改
`02_EventBus.gs`	精简版：只发 `REMINDER_SENT`，不需要本地 ProjectionEngine（见文件内注释）
`05_SheetUtils.gs`	本地副本，`getSheet_` 改用 `openById`
`12_QueryEngine.gs`	只保留 `getPendingTasks`（本项目只需要这个）
`15_Setup.gs`	新文件：只挂一个触发器
92_ReminderEngine.gs 具体改了什么
`checkReminders()` 里 `getPendingTasks()` → `QueryEngine.getPendingTasks()`
（原来那个裸调用是 20_ProductivityModule.gs 的全局包装函数，现在没有
那个文件了，直接调 QueryEngine）
`_updateReminderCount()` 里 `_materializeTaskRow_(task.task_id, task)` →
`upsertRowByKey_('Tasks', 'task_id', task.task_id, task)`（原函数在
20_ProductivityModule.gs，这里改成直接调等价的 SheetUtils 函数，效果
完全一样）
没有改任何判断逻辑——`_shouldRemind`/`_isOverdue`/
`REMINDER_INTERVAL_HOURS` 逐字保留，包括已知的 HIGH RISK 2（缺 due_date
临近性判断）。这次是纯拆分，不夹带修复。那个 bug 还记在 Personal AI Core
项目的 `00_Project_State.gs`「已知Bug」里，随时可以单独排期修。
关于 Reminder OS 未来接入其他 Domain OS
目前 `checkReminders()` 只查 Tasks 表。如果以后 Property OS 也想用这个
服务提醒房租到期，做法是：Property OS 往共享 Spreadsheet 写自己的
`Property` 表，这个项目加一段"也查 Property 表里快到期的"逻辑——不需要
Property OS 反过来调用这个项目，也不需要这个项目反过来调用 Property OS，
只需要都读写同一张共享表，按各自的 Sheet 名分开就行。
