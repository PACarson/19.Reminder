/**
 * 22_QueryEngine.gs   [原 12_QueryEngine.gs — 2026-07-06 按 Domain OS
 * Blueprint 迁入 2_Runtime/（Query 子分类）。]
 *
 * Reminder OS v3.0 — Query Engine（Read Model 查询层，Task 部分）
 *
 * 架构铁律：
 *  - 所有 Telegram 查询必须经过本层
 *  - 绝对禁止读 Events 表 / 调 EventBus / 调 deriveTaskState_
 *  - O(n) on Read Model，不做 Event Replay
 *
 * ⚠️ 2026-07-03 拆分说明：这是 Personal AI Core 12_QueryEngine.gs 的 Task
 * 部分。Inventory 部分（getInventory/findInventoryByName/getLowStockItems/
 * getExpiringItems）留在 Core 项目自己的副本里，本项目不需要。
 *
 * 🐛 2026-07-11 解决第三轮外部审计遗留的 HIGH RISK 2（核实属实、但当时
 * 因为看不到 Productivity OS 代码、无法评估切换到 ActiveTasks 的可行性，
 * 记在了 00_Project_State.gs「已知问题」里，见
 * 00_ADR_002_ReminderEngine_Audit_Fixes.txt「第三轮 HIGH RISK 2 后续
 * 解决」的完整决策依据）：
 *
 * getPendingTasks() 原来是"只读 Tasks Sheet"——_readAllRows_(Tasks) 会把
 * 全部历史任务（包括所有 DONE/CANCELLED）读进内存再过滤，随着历史任务
 * 累积会越来越慢。拿到 Productivity OS 代码后确认：
 *   1. Productivity OS 自己维护一张 ActiveTasks 表，由
 *      10_ProjectionEngine.gs 在每次 TASK_CREATED/UPDATED/COMPLETED/
 *      CANCELLED 时同步（不是定时批处理）增删，永远只包含当前非终态任务，
 *      体量只随"当前有多少未完成任务"增长，不随历史任务数增长——完全符合
 *      getPendingTasks() 需要的语义。
 *   2. 但 ActiveTasks 不含 reminder_count 的实时数据（10_ProjectionEngine.gs
 *      明确写了"ActiveTasks 不需要 reminder_count，跳过"），也没有
 *      last_reminder_at 这一列（Productivity OS 的 15_Setup.gs schema
 *      定义里，Tasks/ActiveTasks/ArchiveTasks 都没有 last_reminder_at，
 *      但 11_ProjectionRebuilder.gs 的 deriveFromEvent 又确实会处理
 *      REMINDER_SENT 事件、写 last_reminder_at——这处 schema 定义和
 *      实际依赖之间的不一致不是本项目造成的，也不在本项目能修的范围，
 *      只在这里如实记录，不代表本项目对此有把握，完整说明见
 *      00_Project_State.gs「已知问题」）。
 *   3. 26_AnalyticsEngine.gs 的"平均提醒次数"统计是拿 Tasks【全量】任务
 *      算的，依赖 Tasks.reminder_count 对已完成任务也保持历史真实值——
 *      这意味着 reminder_count/last_reminder_at 不能只写 ActiveTasks
 *      （任务一完成 ActiveTasks 对应行就被删了，写在那里的历史会跟着
 *      消失，Productivity OS 这个统计功能会失真）。
 *
 * 权衡后的方案：getPendingTasks() 分两步——① 从 ActiveTasks 取候选任务
 * （便宜，体量小）；② 对这一小批候选任务的 task_id，去 Tasks 表用
 * SheetUtils.batchReadFieldsByKey_ 定点只读 reminder_count/
 * last_reminder_at 这两个字段（不读 Tasks 表其余列，也不读候选列表之外
 * 的历史行的任何数据）。这样：
 *   - 不违反"reminder_count/last_reminder_at 的权威数据在 Tasks"这个既有
 *     事实，不影响 Productivity OS 的统计功能；
 *   - 不需要改 Productivity OS 一行代码——ActiveTasks 是它已经在维护的
 *     只读依赖，本项目只是新增了一个读取来源，没有新增任何写入目标；
 *   - Tasks 表本身仍然会随历史增长（Productivity OS 自己的
 *     13_ActiveTasksEngine.gs 文件头写明"归档只打标记不物理删除"，这是
 *     Productivity OS 自己的既有决定，不是本项目能改的），但本项目不再
 *     因为 Tasks 表变大而变慢——步骤①的 ActiveTasks 读取量只取决于当前
 *     未完成任务数；步骤②对 Tasks 的访问只读1列定位行号（成本正比于
 *     Tasks 总行数，但只有1列宽，比原来"全部约18列"便宜一个数量级以上）
 *     + 对候选任务定点取2个字段（成本正比于候选任务数，不是 Tasks 总行数）。
 *
 * getCompletedTasks()/getTaskById() 【没有】跟着改——这两个函数在本项目
 * 里目前没有任何调用方（不在 checkReminders 的路径上，本项目也没有
 * Telegram 查询命令会用到），继续保留读 Tasks 的原始实现。O(N) 问题
 * 只在会被【定期、自动】触发的路径上才是真的风险（checkReminders 每小时
 * 跑一次），不会被调用的代码提前做同样的优化没有实际收益，反而多了一份
 * 需要维护、需要解释"为什么这两个函数处理方式不一样"的代码。如果以后
 * 真的接了会调用这两个函数的功能，到时候再照 getPendingTasks() 这个
 * 思路处理即可。
 *
 * 依赖：21_SheetUtils.gs（SheetUtils.getSheet_/getHeaderMap_/
 *   batchReadFieldsByKey_ —— 2026-07-06 第二轮审计后 SheetUtils 包进
 *   IIFE，调用方式从裸调用改成命名空间形式，见 21_SheetUtils.gs 自己的
 *   文件头说明）
 */

var QueryEngine = (function () {

  var TASKS_SHEET        = 'Tasks';
  var ACTIVE_TASKS_SHEET  = 'ActiveTasks'; // Productivity OS 拥有并维护，本项目只读，不写

  // ============ 内部：读整张 Sheet ============

  function _readAllRows_(sheetName) {
    try {
      var sheet = SheetUtils.getSheet_(sheetName);
      var lastRow = sheet.getLastRow();
      if (lastRow < 2) return [];

      var headerMap = SheetUtils.getHeaderMap_(sheet);
      var numCols   = sheet.getLastColumn();
      var rows      = sheet.getRange(2, 1, lastRow - 1, numCols).getValues();

      return rows.map(function (row) {
        var obj = {};
        for (var h in headerMap) {
          obj[h] = row[headerMap[h]];
        }
        return obj;
      }).filter(function (obj) {
        return Object.keys(obj).some(function (k) { return obj[k] !== ''; });
      });
    } catch (e) {
      Logger.log('[QueryEngine] _readAllRows_ error (' + sheetName + '): ' + e.message);
      return [];
    }
  }

  // ============ Task 查询 ============

  /**
   * 获取 PENDING 任务列表，供 checkReminders() 使用。
   *
   * 🐛 2026-07-11：候选列表来自 ActiveTasks（小、实时、不随历史增长），
   * reminder_count/last_reminder_at 两个字段单独从 Tasks 定点取——完整
   * 理由见本文件文件头。ActiveTasks 读不到/不存在时（比如 Productivity
   * OS 还没跑过 setupSheets()）会走 _readAllRows_ 已有的 try/catch，
   * 返回空数组，不会让 checkReminders 崩掉，但也意味着这种情况下提醒会
   * 完全停摆——这跟原来"Tasks 读不到就返回空"是同一种失败模式，不是
   * 这次改动新引入的风险。
   *
   * @param {string} [chatId]  不传则返回所有用户的任务
   * @returns {object[]}
   */
  function getPendingTasks(chatId) {
    var candidates = _readAllRows_(ACTIVE_TASKS_SHEET).filter(function (task) {
      if (!task.task_id) return false;
      if (String(task.status || '').toUpperCase() !== 'PENDING') return false;
      if (chatId && String(task.chat_id) !== String(chatId)) return false;
      return true;
    });

    if (candidates.length === 0) return candidates;

    var taskIds = candidates.map(function (t) { return t.task_id; });
    var reminderFieldsByTaskId = SheetUtils.batchReadFieldsByKey_(
      TASKS_SHEET, 'task_id', taskIds, ['reminder_count', 'last_reminder_at']
    );

    var notFoundCount = 0;
    candidates.forEach(function (task) {
      var extra = reminderFieldsByTaskId[String(task.task_id)];
      if (!extra) {
        // ActiveTasks 和 Tasks 由 Productivity OS 的同一次 Projection
        // 同步维护（见文件头），正常情况下 ActiveTasks 里有的 task_id，
        // Tasks 里一定也有——这里出现"找不到"说明两边数据出现了不一致，
        // 值得记一条日志，但不应该让这一条任务的提醒判断直接崩掉，按
        // "没有提醒历史"处理（reminder_count=0/last_reminder_at 空），
        // 是最保守、最不容易少发提醒的默认值。
        notFoundCount++;
        task.reminder_count = 0;
        task.last_reminder_at = '';
      } else {
        task.reminder_count = extra.reminder_count;
        task.last_reminder_at = extra.last_reminder_at;
      }
    });
    if (notFoundCount > 0) {
      Logger.log('[QueryEngine] ⚠️ ' + notFoundCount + ' 个 task_id 在 ActiveTasks 里有、但在 Tasks ' +
        '里定点查不到 reminder_count/last_reminder_at，ActiveTasks 和 Tasks 之间可能存在不一致，' +
        '已按"无提醒历史"处理');
    }

    return candidates;
  }

  /**
   * 获取已完成任务列表。
   *
   * ⚠️ 本项目目前没有任何调用方（不在 checkReminders 路径上），继续读
   * 全量 Tasks，没有跟着 getPendingTasks() 一起优化——理由见文件头。
   *
   * @param {string} [chatId]
   * @returns {object[]}
   */
  function getCompletedTasks(chatId) {
    return _readAllRows_(TASKS_SHEET).filter(function (task) {
      if (!task.task_id) return false;
      if (String(task.status || '').toUpperCase() !== 'DONE') return false;
      if (chatId && String(task.chat_id) !== String(chatId)) return false;
      return true;
    });
  }

  /**
   * 按 task_id 查单个任务。
   *
   * ⚠️ 本项目目前没有任何调用方，继续读全量 Tasks，理由同上。
   *
   * @returns {object|null}
   */
  function getTaskById(taskId) {
    var rows = _readAllRows_(TASKS_SHEET);
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].task_id) === String(taskId)) return rows[i];
    }
    return null;
  }

  return {
    getPendingTasks:   getPendingTasks,
    getCompletedTasks: getCompletedTasks,
    getTaskById:       getTaskById
  };
})();
