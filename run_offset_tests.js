require('./mocks.js');

const fs = require('fs');
const sheetUtilsSrc = fs.readFileSync('/home/claude/work/Reminder-OS-main/21_SheetUtils.txt', 'utf8');
const outputSrc = fs.readFileSync('/home/claude/work/output/40_Output.gs', 'utf8');
const engineSrc = fs.readFileSync('/home/claude/work/output/26_ReminderOffsetEngine.gs', 'utf8');
const testSrc = fs.readFileSync('/home/claude/work/output/50_ReminderOffsetEngine_Tests.gs', 'utf8');

eval(sheetUtilsSrc);
eval(outputSrc);
eval(engineSrc);
eval(testSrc);

const result = runReminderOffsetEngineTests();
console.log('\n=== HARNESS RESULT: ' + JSON.stringify(result) + ' ===');
if (result.fail > 0) {
  console.log('FAILURES DETECTED');
  process.exit(1);
} else {
  console.log('ALL PASS');
  process.exit(0);
}
