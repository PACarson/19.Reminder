// mocks.js — in-memory GAS shims for testing 26_ReminderOffsetEngine.gs
// against the REAL SheetUtils/EventBus/Output logic (eval'd from the real
// files), not hand-simplified re-implementations of them. Only the
// lowest-level GAS platform primitives (SpreadsheetApp/UrlFetchApp/
// LockService/PropertiesService/ScriptApp/Logger) are stubbed.

global.Logger = { log: function (msg) { /* silence for test output; flip to console.log to debug */ } };

// ---------- In-memory "spreadsheet" backing every sheet ----------
var __store = {}; // sheetName -> { headers: [...], rows: [ [...], ... ] }  (rows are raw arrays, header-ordered)

function __ensureSheet(name, headers) {
  if (!__store[name]) __store[name] = { headers: headers.slice(), rows: [] };
  return __store[name];
}

function __FakeRange(sheetName, row, col, numRows, numCols) {
  numRows = numRows || 1; // SheetUtils calls getRange(row, col) with no size for single-cell writes
  numCols = numCols || 1;
  return {
    getValues: function () {
      var t = __store[sheetName];
      var out = [];
      for (var r = 0; r < numRows; r++) {
        if (row === 1) {
          out.push(t.headers.slice(col - 1, col - 1 + numCols));
        } else {
          var dataIdx = (row - 2) + r;
          var src = t.rows[dataIdx] || [];
          var slice = [];
          for (var c = 0; c < numCols; c++) slice.push(src[col - 1 + c] !== undefined ? src[col - 1 + c] : '');
          out.push(slice);
        }
      }
      return out;
    },
    setValues: function (vals) {
      var t = __store[sheetName];
      for (var r = 0; r < vals.length; r++) {
        var dataIdx = (row - 2) + r;
        var existing = t.rows[dataIdx] || new Array(t.headers.length).fill('');
        for (var c = 0; c < vals[r].length; c++) existing[col - 1 + c] = vals[r][c];
        t.rows[dataIdx] = existing;
      }
    },
    setValue: function (val) {
      var t = __store[sheetName];
      var dataIdx = row - 2;
      var existing = t.rows[dataIdx] || new Array(t.headers.length).fill('');
      existing[col - 1] = val;
      t.rows[dataIdx] = existing;
    }
  };
}

function __FakeSheet(name) {
  return {
    getLastRow: function () { return __store[name].rows.length + 1; },
    getLastColumn: function () { return __store[name].headers.length; },
    getRange: function (row, col, numRows, numCols) { return __FakeRange(name, row, col, numRows, numCols); }, // numRows/numCols optional, see __FakeRange
    deleteRow: function (rowNum) { __store[name].rows.splice(rowNum - 2, 1); },
    appendRow: function (arr) { __store[name].rows.push(arr); }
  };
}

// ---------- SheetUtils: eval the REAL file against fake Sheet plumbing ----------
// getSheet_() in the real file uses SpreadsheetApp.openById(SPREADSHEET_ID)
// (standalone script, no container spreadsheet) — mock must match that
// exact call shape, not getActiveSpreadsheet().
global.SpreadsheetApp = {
  openById: function () {
    return {
      getSheetByName: function (name) {
        if (!__store[name]) return null;
        return __FakeSheet(name);
      }
    };
  }
};

// ---------- Helper the test file uses to seed/inspect fake tables ----------
global.__seedSheet = function (name, headers, rowObjects) {
  var t = __ensureSheet(name, headers);
  t.rows = rowObjects.map(function (obj) {
    return headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  });
};
global.__readSheetRows = function (name) {
  var t = __store[name];
  if (!t) return [];
  return t.rows.map(function (row) {
    var obj = {};
    t.headers.forEach(function (h, i) { obj[h] = row[i]; });
    return obj;
  });
};
global.__resetStore = function () { __store = {}; };

// ---------- QueryEngine: simple configurable mock (not the real file —
// the real getPendingTasks() itself reads Productivity OS's ActiveTasks/
// Tasks, which aren't part of this bundle; the CONTRACT (returns an array
// of flat task objects) is what matters here, and is mocked directly) ----------
global.__mockPendingTasks = [];
global.QueryEngine = {
  getPendingTasks: function () { return global.__mockPendingTasks; }
};

// ---------- EventBus: real publishBatch contract, recorded for assertions ----------
global.__publishedEvents = [];
global.EventBus = {
  publishBatch: function (events) {
    global.__publishedEvents = global.__publishedEvents.concat(events);
  }
};

// ---------- Output: eval the REAL 40_Output.gs against a stubbed
// UrlFetchApp/SecureConfig, so the real adapter-dispatch logic runs ----------
global.__telegramShouldSucceed = true;
global.UrlFetchApp = {
  fetch: function () {
    if (global.__telegramShouldSucceed) {
      return { getContentText: function () { return JSON.stringify({ ok: true, result: { message_id: 1 } }); } };
    }
    return { getContentText: function () { return JSON.stringify({ ok: false, description: 'mock failure' }); } };
  }
};
global.SecureConfig = {
  getKey: function (k) {
    if (k === 'TELEGRAM_TOKEN') return 'fake-token';
    if (k === 'SPREADSHEET_ID') return 'fake-spreadsheet-id';
    return null;
  }
};

// ---------- LockService / PropertiesService / ScriptApp ----------
global.LockService = {
  getScriptLock: function () {
    return { waitLock: function () {}, releaseLock: function () {} };
  }
};
var __props = {};
global.PropertiesService = {
  getScriptProperties: function () {
    return {
      getProperty: function (k) { return __props[k] !== undefined ? __props[k] : null; },
      setProperty: function (k, v) { __props[k] = v; },
      deleteProperty: function (k) { delete __props[k]; }
    };
  }
};
global.ScriptApp = {
  getProjectTriggers: function () { return []; },
  newTrigger: function () {
    return {
      timeBased: function () { return this; },
      after: function () { return this; },
      everyMinutes: function () { return this; },
      create: function () { return { getUniqueId: function () { return 'fake-trigger-id'; } }; }
    };
  },
  deleteTrigger: function () {}
};
global.Utilities = { sleep: function () {} };

module.exports = { __ensureSheet: __ensureSheet };
