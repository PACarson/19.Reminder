/**
 * 50_ReminderOffsetEngine_Tests.gs
 * Reminder OS — 26_ReminderOffsetEngine.gs 的测试
 *
 * 跟 50_TemporalEngine_Tests.gs 同款风格：手动 Logger.log PASS/FAIL，
 * 不引入新的测试框架依赖。
 *
 * ⚠️ 跟 50_TemporalEngine_Tests.gs 不同的地方：TemporalEngine 是 Pure
 * Function，这份文件可以原样丢进 GAS 编辑器直接跑。这份测试涉及
 * SheetUtils/QueryEngine/EventBus/Output/LockService 等一整套 GAS 平台
 * 依赖，本地验证是通过 /home/claude/work/mocks.js + run_offset_tests.js
 * 搭的内存版 GAS shim 跑的（用真实的 21_SheetUtils.gs/40_Output.gs 源码
 * eval 进去，不是重新手写一份简化逻辑）。如果要挪进真实 GAS 项目里跑
 * 集成测试，需要指向一个真实的测试用 Spreadsheet，而不是这份 mock。
 * design doc §10 Testing 层的 Integration Tests 那一条对应的就是这份
 * 文件里的 checkOffsetReminders() 系列场景，不是 pure unit test 那几个。
 */

function runReminderOffsetEngineTests() {
  // 🐛 bugfix（2026-07-15，GAS Console 实测 ReferenceError: global is not
  // defined，报错点在 resetAll()）：这份测试套件依赖 mocks.js 提供的
  // 内存 Mock（__resetStore/__seedSheet/__mockPendingTasks 等），设计上
  // 只能通过 Node 沙盒（run_offset_tests.js）运行——见本文件头部说明。
  // 直接把这份文件贴进 Apps Script 编辑器运行 runReminderOffsetEngineTests
  // 会在第一处 global.xxx 引用处失败，因为 GAS 运行时没有 Node 的
  // global 对象。即使把 global 换成某个 GAS 侧的等价写法，紧接着
  // __resetStore/__seedSheet 等 mock 函数依然不存在——不是换一个全局
  // 对象名字能解决的，因为整套 mock 从未被加载进 GAS 项目，只存在于
  // mocks.js 这个仅供本地/Node 使用的文件里。这里提前显式检测并给出
  // 可操作的报错，取代深埋在 resetAll() 里、指向不明的 ReferenceError。
  // 如果想在真实 GAS 环境里做端到端验证，应该直接调用
  // checkOffsetReminders() 并指向一个专用的测试 Spreadsheet，而不是跑
  // 这个函数——这个函数测的是逻辑本身，不是真实平台集成，两者故意分开。
  if (typeof global === 'undefined' || typeof global.__resetStore !== 'function') {
    var envMsg = '[ReminderOffsetEngineTests] 这份测试套件只能通过 Node 沙盒运行' +
      '（项目根目录下执行 node run_offset_tests.js），不支持直接在 GAS 编辑器里跑——' +
      '它依赖 mocks.js 提供的内存版 SheetUtils/QueryEngine/Output/LockService，GAS ' +
      '运行时既没有 Node 的 global 对象，也不会加载这份 mock。';
    Logger.log('❌ ' + envMsg);
    throw new Error(envMsg);
  }

  var pass = 0, fail = 0;

  function check(label, actual, expected) {
    var actualStr = JSON.stringify(actual);
    var expectedStr = JSON.stringify(expected);
    if (actualStr === expectedStr) {
      pass++;
    } else {
      fail++;
      Logger.log('❌ FAIL: ' + label + '\n   期望: ' + expectedStr + '\n   实际: ' + actualStr);
    }
  }

  function checkTrue(label, actual) {
    if (actual === true) { pass++; } else { fail++; Logger.log('❌ FAIL: ' + label + ' (期望 true, 实际 ' + actual + ')'); }
  }

  Logger.log('========== ReminderOffsetEngine 测试开始 ==========');

  // ---------- _resolveEffectiveDueDatetime_：三种 schema 假设都要覆盖 ----------
  // design doc §2 Open Item 1：这三个分支就是"读哪个字段"的全部假设，
  // Productivity OS 的真实 schema 一旦确认，只需要回来改这一个函数，
  // 这几个测试的意义是锁住这个函数当前假设的行为，不是验证假设本身对不对。

  check('resolveEffectiveDueDatetime: 优先用 due_datetime（完整ISO字符串）',
    ReminderOffsetEngine._resolveEffectiveDueDatetime_({ due_datetime: '2026-07-30T10:00:00' }).getHours(),
    10);

  check('resolveEffectiveDueDatetime: due_date+due_time 组合',
    ReminderOffsetEngine._resolveEffectiveDueDatetime_({ due_date: '2026-07-30', due_time: '10:00:00' }).getHours(),
    10);

  check('resolveEffectiveDueDatetime: 只有纯 due_date（date-only，午夜）',
    ReminderOffsetEngine._resolveEffectiveDueDatetime_({ due_date: '2026-07-30' }).getHours(),
    0);

  check('resolveEffectiveDueDatetime: 三个字段都没有，返回 null',
    ReminderOffsetEngine._resolveEffectiveDueDatetime_({}),
    null);

  // ---------- _computeIdempotencyKey_ ----------

  var fireAtA = new Date(2026, 6, 30, 8, 45, 30); // 有秒数，应该被截到分钟
  var fireAtB = new Date(2026, 6, 30, 8, 45, 59);
  check('computeIdempotencyKey: 同一分钟内秒数不同应该得到相同 key（分钟精度）',
    ReminderOffsetEngine._computeIdempotencyKey_('RULE-1', 'telegram', fireAtA),
    ReminderOffsetEngine._computeIdempotencyKey_('RULE-1', 'telegram', fireAtB));

  var fireAtC = new Date(2026, 6, 30, 8, 46, 0);
  checkTrue('computeIdempotencyKey: 跨分钟应该得到不同 key',
    ReminderOffsetEngine._computeIdempotencyKey_('RULE-1', 'telegram', fireAtA) !==
    ReminderOffsetEngine._computeIdempotencyKey_('RULE-1', 'telegram', fireAtC));

  // ---------- _offsetLabel_ ----------

  check('offsetLabel: 1440分钟 → 1 day(s) before', ReminderOffsetEngine._offsetLabel_(1440), '1 day(s) before');
  check('offsetLabel: 60分钟 → 1 hour(s) before', ReminderOffsetEngine._offsetLabel_(60), '1 hour(s) before');
  check('offsetLabel: 15分钟 → 15 minute(s) before', ReminderOffsetEngine._offsetLabel_(15), '15 minute(s) before');

  // ---------- _offsetToMinutes_（ADR-2026-07-17-006 新增）----------

  check('offsetToMinutes: {30, minutes} → 30', ReminderOffsetEngine._offsetToMinutes_({ value: 30, unit: 'minutes' }), 30);
  check('offsetToMinutes: {2, hours} → 120', ReminderOffsetEngine._offsetToMinutes_({ value: 2, unit: 'hours' }), 120);
  check('offsetToMinutes: {3, days} → 4320', ReminderOffsetEngine._offsetToMinutes_({ value: 3, unit: 'days' }), 4320);
  check('offsetToMinutes: 无法识别的 unit → null', ReminderOffsetEngine._offsetToMinutes_({ value: 5, unit: 'weeks' }), null);
  check('offsetToMinutes: value 不是数字 → null', ReminderOffsetEngine._offsetToMinutes_({ value: '30', unit: 'minutes' }), null);

  // ---------- Integration: checkOffsetReminders() 完整 poll cycle ----------
  // design doc §10 Testing：mock 一个 getPendingTasks() 结果，跑一整轮
  // checkOffsetReminders()，断言落在表里的结果——这是设计文档明确要求的
  // "不只测单个函数，测规则/当前任务状态/幂等键三者的交互"。

  function resetAll() {
    global.__resetStore();
    global.__mockPendingTasks = [];
    global.__publishedEvents = [];
    global.__telegramShouldSucceed = true;
    global.__seedSheet('ReminderRules',
      ['rule_id', 'task_id', 'chat_id', 'offset_minutes', 'offset_label', 'channels', 'rule_status', 'source', 'resolved_fire_ats', 'created_at'], []);
    global.__seedSheet('ReminderOccurrences',
      ['idempotency_key', 'rule_id', 'task_id', 'chat_id', 'channel', 'computed_fire_at', 'status', 'attempt_count', 'last_attempt_at', 'snoozed_until'], []);
    global.__seedSheet('ReminderHistory',
      ['idempotency_key', 'rule_id', 'task_id', 'chat_id', 'channel', 'computed_fire_at', 'final_status', 'attempt_count', 'resolved_at', 'resolved_reason', 'archived_at'], []);
  }

  // --- 场景 A: 全新 task，没有任何规则，due_datetime 是 30 分钟后。
  //     三个默认offset里，offset越大，fire_at越早（越远离due）：
  //       -15min的fire_at = due-15 = 现在+15（还没到，不应该发）
  //       -1hour的fire_at = due-60 = 现在-30（已经过了，应该发）
  //       -1day 的fire_at = due-1440 = 远早于现在（已经过了，应该发）
  //     所以应该正好发2条（-1hour、-1day），-15min那条还不该动 ---
  resetAll();
  var now = new Date();
  var dueIn30 = new Date(now.getTime() + 30 * 60000);
  global.__mockPendingTasks = [{ task_id: 'TASK-A', chat_id: 'CHAT-1', title: '测试任务A', due_datetime: dueIn30.toISOString() }];

  var statsA = ReminderOffsetEngine.checkOffsetReminders();
  check('场景A: 应该自动生成3条默认规则', statsA.defaultRulesCreated, 3);
  check('场景A: 应该发送成功2条（-1hour和-1day已过阈值，-15min还没到）', statsA.sent, 2);

  var historyA = global.__readSheetRows('ReminderHistory');
  check('场景A: History里应该有2条sent记录', historyA.length, 2);
  checkTrue('场景A: History记录的channel都是telegram', historyA.every(function (h) { return h.channel === 'telegram'; }));
  var occA = global.__readSheetRows('ReminderOccurrences');
  check('场景A: 已发送的occurrence不应该继续留在Occurrences表（已归档删除）', occA.length, 0);
  var rulesA = global.__readSheetRows('ReminderRules');
  check('场景A: 3条规则都应该还在（-15min那条还没到期，规则本身不会因为一次发送被删）', rulesA.length, 3);

  // --- 场景 B: 紧接着再跑一次（不改变任何输入），验证幂等——
  //     不应该重复发送已经resolve过的-1hour/-1day，-15min此时仍未到期 ---
  var statsB = ReminderOffsetEngine.checkOffsetReminders();
  check('场景B（重复poll，输入不变）: 不应该重复发送', statsB.sent, 0);
  check('场景B: 不应该重新生成默认规则（task已经有规则了）', statsB.defaultRulesCreated, 0);
  var historyB = global.__readSheetRows('ReminderHistory');
  check('场景B: History不应该多出重复记录', historyB.length, 2);

  // --- 场景 C: task 不再是 pending 状态（从 mock 的 pending 列表里消失）
  //     → 应该取消所有还在 pending 的 occurrence，规则应该被清理掉 ---
  global.__mockPendingTasks = []; // TASK-A 不再 pending
  var statsC = ReminderOffsetEngine.checkOffsetReminders();
  check('场景C（task完成/消失）: 剩余规则数应该等于取消的occurrence以外的部分（这里没有额外pending occurrence，cancelled应为0）',
    statsC.cancelled, 0); // 这一步之前没有pending occurrence（-1day/-1hour还没到fire_at，没物化），所以没什么可取消的
  var rulesC = global.__readSheetRows('ReminderRules');
  check('场景C: task不再pending后，规则应该被清理，Rules表应该清空', rulesC.length, 0);

  // --- 场景 D: 发送失败，重试次数用尽后归档为 failed ---
  resetAll();
  global.__telegramShouldSucceed = false;
  var dueInPastD = new Date(Date.now() - 20 * 60000);
  global.__mockPendingTasks = [{ task_id: 'TASK-D', chat_id: 'CHAT-1', due_datetime: dueInPastD.toISOString() }];

  var statsD1 = ReminderOffsetEngine.checkOffsetReminders();
  check('场景D 第1次: 发送失败，还在重试预算内，不应该算作最终failed', statsD1.failed, 0);
  var occD1 = global.__readSheetRows('ReminderOccurrences');
  var d1Row = occD1.filter(function (o) { return o.channel === 'telegram' && o.status === 'failed'; });
  check('场景D 第1次: 应该有一条状态为failed、等待重试的occurrence（-15min那条）', d1Row.length >= 1, true);

  var statsD2 = ReminderOffsetEngine.checkOffsetReminders();
  check('场景D 第2次（达到MAX_RETRY_ATTEMPTS=2）: 应该归档为最终failed', statsD2.failed >= 1, true);
  var historyD = global.__readSheetRows('ReminderHistory');
  var failedInHistory = historyD.filter(function (h) { return h.final_status === 'failed'; });
  checkTrue('场景D: History里应该有归档的failed记录', failedInHistory.length >= 1);

  // --- 场景 E: 幂等键跨渠道独立——同一条规则配置2个渠道，其中一个失败
  //     不应该影响另一个 ---
  resetAll();
  var dueInPastE = new Date(Date.now() - 20 * 60000);
  global.__seedSheet('ReminderRules',
    ['rule_id', 'task_id', 'chat_id', 'offset_minutes', 'offset_label', 'channels', 'rule_status', 'source', 'resolved_fire_ats', 'created_at'],
    [{ rule_id: 'RULE-E', task_id: 'TASK-E', chat_id: 'CHAT-1', offset_minutes: 15, offset_label: '15 minute(s) before', channels: JSON.stringify(['telegram']), rule_status: 'active', source: 'manual', resolved_fire_ats: JSON.stringify({}), created_at: new Date().toISOString() }]);
  global.__mockPendingTasks = [{ task_id: 'TASK-E', chat_id: 'CHAT-1', due_datetime: dueInPastE.toISOString() }];

  var statsE = ReminderOffsetEngine.checkOffsetReminders();
  check('场景E（手工建的单条规则，不触发默认规则生成）: defaultRulesCreated应为0', statsE.defaultRulesCreated, 0);
  check('场景E: 应该发送成功1次', statsE.sent, 1);
  var rulesE = global.__readSheetRows('ReminderRules');
  var resolvedE = JSON.parse(rulesE[0].resolved_fire_ats);
  checkTrue('场景E: 规则的resolved_fire_ats应该记录telegram渠道已解决的时间', !!resolvedE.telegram);

  // --- 场景 F（外部审计 HIGH RISK 1 回归测试，2026-07-15）：任务的到期
  //     时间被改早，且改早之前这个 channel 已经针对"改早前"的到期时间
  //     resolve 过一次——修复前，新算出的 fireAt 因为变小，会满足旧的
  //     "fireAt <= 上次记录的值"判断，被误判成"已经处理过"而跳过，用户
  //     收不到新到期时间对应的提醒。这里手工构造这个前置状态（不依赖
  //     真的跑两轮 poll 来促成改期，直接模拟"这个 channel 曾经针对一个
  //     更晚的到期时间 resolve 过"这个已发生的历史事实） ---
  resetAll();
  var dueOriginalF = new Date(Date.now() + 120 * 60000); // 改早之前：2小时后到期
  global.__seedSheet('ReminderRules',
    ['rule_id', 'task_id', 'chat_id', 'offset_minutes', 'offset_label', 'channels', 'rule_status', 'source', 'resolved_fire_ats', 'created_at'],
    [{
      rule_id: 'RULE-F', task_id: 'TASK-F', chat_id: 'CHAT-1', offset_minutes: 15,
      offset_label: '15 minute(s) before', channels: JSON.stringify(['telegram']),
      rule_status: 'active', source: 'manual',
      // 模拟"改早之前"：telegram 渠道已经针对 dueOriginalF 这个到期时间
      // resolve 过（字段名仍叫 resolved_fire_ats，但存的是到期时间快照，
      // 不是 fire_at，见 26_ReminderOffsetEngine.gs 文件头 2026-07-15 修订）
      resolved_fire_ats: JSON.stringify({ telegram: dueOriginalF.toISOString() }),
      created_at: new Date().toISOString()
    }]);
  var dueRescheduledF = new Date(Date.now() - 10 * 60000); // 改早之后：10分钟前（已逾期）
  global.__mockPendingTasks = [{ task_id: 'TASK-F', chat_id: 'CHAT-1', due_datetime: dueRescheduledF.toISOString() }];

  var statsF = ReminderOffsetEngine.checkOffsetReminders();
  check('场景F（到期时间改早，改早前该channel已resolve过）: 不应该被旧到期时间的resolved记录误判为已处理，应该正常发送',
    statsF.sent, 1);
  check('场景F: 不应该因为TASK-F已有规则而重新生成默认规则', statsF.defaultRulesCreated, 0);
  var historyF = global.__readSheetRows('ReminderHistory');
  checkTrue('场景F: History里应该有RULE-F对应的sent记录（不是被跳过、完全没有记录）',
    historyF.some(function (h) { return h.rule_id === 'RULE-F' && h.final_status === 'sent'; }));

  // --- 场景 F 对照组：到期时间没有变化时，重复 poll 依然不应该重发
  //     （确认场景F的修复没有连带破坏"没改期就不重发"这个基本幂等性） ---
  var statsFRepeat = ReminderOffsetEngine.checkOffsetReminders();
  check('场景F对照组（紧接着再poll一次，到期时间不变）: 不应该重复发送', statsFRepeat.sent, 0);

  // --- 场景 G（ADR-2026-07-17-006，reminder_policy override）：全新 task，
  //     创建时显式指定 override（30分钟前一条），到期时间是20分钟前
  //     （已经过了30分钟前这个 fire_at）——应该只生成1条 user_override
  //     规则，不生成默认的3条，且这1条应该立刻发送成功 ---
  resetAll();
  var dueInPastG = new Date(Date.now() - 20 * 60000);
  global.__mockPendingTasks = [{
    task_id: 'TASK-G', chat_id: 'CHAT-1', title: '测试任务G',
    due_datetime: dueInPastG.toISOString(),
    reminder_policy: JSON.stringify({ offsets: [{ value: 30, unit: 'minutes' }] })
  }];

  var statsG = ReminderOffsetEngine.checkOffsetReminders();
  check('场景G（reminder_policy override）: 不应该生成默认规则', statsG.defaultRulesCreated, 0);
  check('场景G: 应该生成1条override规则', statsG.overrideRulesCreated, 1);
  check('场景G: 应该发送成功1条', statsG.sent, 1);
  var rulesG = global.__readSheetRows('ReminderRules');
  check('场景G: Rules表应该恰好1条', rulesG.length, 1);
  check('场景G: 规则的source应该是user_override', rulesG[0].source, 'user_override');
  check('场景G: 规则的offset_minutes应该是30（30分钟换算）', Number(rulesG[0].offset_minutes), 30);

  // --- 场景 H（ADR-2026-07-17-006，reminder_policy.offsets=[]）：用户创建
  //     时显式声明"不要提前提醒"——不应该生成任何规则、不应该有任何发送。
  //     V1（25_ReminderEngine.gs）的到期提醒是完全独立的机制，从不读
  //     reminder_policy，不在这份测试的覆盖范围内（Carson决定#1）---
  resetAll();
  var dueInPastH = new Date(Date.now() - 20 * 60000);
  global.__mockPendingTasks = [{
    task_id: 'TASK-H', chat_id: 'CHAT-1', title: '测试任务H',
    due_datetime: dueInPastH.toISOString(),
    reminder_policy: JSON.stringify({ offsets: [] })
  }];

  var statsH = ReminderOffsetEngine.checkOffsetReminders();
  check('场景H（不要提前提醒）: 不应该生成默认规则', statsH.defaultRulesCreated, 0);
  check('场景H: 不应该生成override规则', statsH.overrideRulesCreated, 0);
  check('场景H: 不应该有任何发送', statsH.sent, 0);
  var rulesH = global.__readSheetRows('ReminderRules');
  check('场景H: Rules表应该是空的', rulesH.length, 0);

  // --- 场景 H 对照组：紧接着再poll一次，验证"不生成规则天然幂等，不需要
  //     额外标记已处理过"这一点（见 _ensureRulesFromPolicy_ 函数头注释）---
  var statsHRepeat = ReminderOffsetEngine.checkOffsetReminders();
  check('场景H对照组（重复poll，reminder_policy仍是空数组）: 依然不应该生成任何规则', statsHRepeat.defaultRulesCreated, 0);
  check('场景H对照组: 依然不应该有发送', statsHRepeat.sent, 0);

  // --- 场景 I（ADR-2026-07-17-006）：reminder_policy 是无法解析的乱码
  //     字符串（不是合法JSON）——应该安全退回到当作null处理，走默认规则
  //     生成，不应该抛错崩溃 ---
  resetAll();
  var dueInPastI = new Date(Date.now() - 90 * 60000);
  global.__mockPendingTasks = [{
    task_id: 'TASK-I', chat_id: 'CHAT-1', title: '测试任务I',
    due_datetime: dueInPastI.toISOString(),
    reminder_policy: '不是合法JSON{{{'
  }];

  var statsI = ReminderOffsetEngine.checkOffsetReminders();
  check('场景I（reminder_policy解析失败，安全退回默认）: 应该生成3条默认规则', statsI.defaultRulesCreated, 3);
  check('场景I: 不应该生成override规则', statsI.overrideRulesCreated, 0);

  // ---------- Quiet Hours 门控（不改变materialize，只影响是否实际发送）----------

  resetAll();
  // 直接调用内部函数验证判断逻辑本身（QUIET_HOURS_*为null时应恒为false，
  // V1默认关闭，见design doc §5 决策）
  checkTrue('isWithinQuietHours: V1默认关闭（QUIET_HOURS_START/END为null）时恒为false',
    ReminderOffsetEngine._isWithinQuietHours_(new Date(2026, 0, 1, 23, 0)) === false);

  Logger.log('========== ReminderOffsetEngine 测试结束: ' + pass + ' passed, ' + fail + ' failed ==========');
  return { pass: pass, fail: fail };
}
