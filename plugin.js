/* 每日复盘与计划 —— 后台快照入口 */
(function () {
  'use strict';

  var KEY = 'daily-review-data-v1';
  var snapshotTimer = null;
  var snapshotRunning = false;
  var snapshotAgain = false;
  var dayOffsetMs = 0;

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function dateStr(d) {
    var x = d instanceof Date ? d : new Date(d);
    if (isNaN(x.getTime())) return null;
    return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
  }

  function logicalDateStr(value) {
    return dateStr(new Date(Number(value) - dayOffsetMs));
  }

  function parseDayOffset(misc) {
    if (!misc) return 0;
    var raw = misc.startOfNextDayTime;
    if (typeof raw === 'string') {
      var m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(raw);
      if (m) return (Number(m[1]) * 60 + Number(m[2])) * 60000;
      return 0;
    }
    if (typeof misc.startOfNextDay === 'number' && misc.startOfNextDay >= 0 && misc.startOfNextDay <= 23) {
      return Math.floor(misc.startOfNextDay) * 3600000;
    }
    return 0;
  }

  async function refreshDayOffset() {
    try {
      if (typeof PluginAPI.getAppState !== 'function') return;
      var appState = await PluginAPI.getAppState();
      dayOffsetMs = parseDayOffset(appState && appState.globalConfig && appState.globalConfig.misc);
    } catch (e) {
      console.warn('[每日复盘] 读取日期设置失败，按自然日统计', e);
    }
  }

  function plannedDay(task) {
    if (task && typeof task.dueWithTime === 'number') return logicalDateStr(task.dueWithTime);
    if (task && typeof task.dueDay === 'string' && task.dueDay) return task.dueDay;
    return null;
  }

  function normalize(raw) {
    var data = raw && typeof raw === 'object' ? raw : {};
    if (!data.version) data.version = 1;
    if (!data.days || typeof data.days !== 'object') data.days = {};
    if (!data.completions || typeof data.completions !== 'object') data.completions = {};
    if (!data.reasons || typeof data.reasons !== 'object') data.reasons = {};
    if (!data.imports || typeof data.imports !== 'object') data.imports = {};
    if (!data.closures || typeof data.closures !== 'object') data.closures = {};
    return data;
  }

  async function loadData() {
    try {
      var raw = await PluginAPI.loadSyncedData(KEY);
      return normalize(raw ? JSON.parse(raw) : null);
    } catch (e) {
      console.warn('[每日复盘] 读取数据失败', e);
      return normalize(null);
    }
  }

  async function saveData(data) {
    await PluginAPI.persistDataSynced(JSON.stringify(data), KEY);
  }

  function compactTask(task) {
    return {
      id: task.id,
      title: task.title || '(无标题)',
      projectId: task.projectId || null,
      parentId: task.parentId || null,
      timeEstimate: Number(task.timeEstimate || 0),
      timeSpent: Number(task.timeSpent || 0),
      isDone: !!task.isDone,
      doneOn: typeof task.doneOn === 'number' ? task.doneOn : null,
      dueDay: task.dueDay || null,
      dueWithTime: typeof task.dueWithTime === 'number' ? task.dueWithTime : null,
      notes: task.notes || '',
      tagIds: Array.isArray(task.tagIds) ? task.tagIds.slice() : [],
      updated: task.updated || task.modified || null,
    };
  }

  function prune(data, today) {
    var cutoff = new Date(today + 'T00:00:00');
    cutoff.setDate(cutoff.getDate() - 730);
    var cutoffStr = dateStr(cutoff);
    Object.keys(data.days).forEach(function (day) {
      if (day < cutoffStr) delete data.days[day];
    });
    Object.keys(data.completions).forEach(function (day) {
      if (day < cutoffStr) delete data.completions[day];
    });
    Object.keys(data.reasons).forEach(function (key) {
      var day = key.split('::')[1];
      if (day && day < cutoffStr) delete data.reasons[key];
    });
    Object.keys(data.closures).forEach(function (day) {
      if (day < cutoffStr) delete data.closures[day];
    });
  }

  async function takeSnapshot() {
    if (snapshotRunning) {
      snapshotAgain = true;
      return;
    }
    snapshotRunning = true;
    try {
      var results = await Promise.all([
        PluginAPI.getTasks(),
        typeof PluginAPI.getArchivedTasks === 'function'
          ? PluginAPI.getArchivedTasks()
          : Promise.resolve([]),
      ]);
      await refreshDayOffset();
      var activeTasks = results[0] || [];
      var archivedTasks = results[1] || [];
      var seen = Object.create(null);
      var tasks = [];
      activeTasks.concat(archivedTasks).forEach(function (task) {
        if (!task || !task.id || seen[task.id]) return;
        seen[task.id] = true;
        tasks.push(task);
      });

      var data = await loadData();
      var today = logicalDateStr(Date.now());

      // Deleted tasks must disappear from review data. Keep snapshots only for
      // task IDs that still exist in the live task store or archive.
      Object.keys(data.days).forEach(function (day) {
        var bucket = data.days[day] && data.days[day].tasks;
        if (!bucket) return;
        Object.keys(bucket).forEach(function (id) {
          if (!seen[id]) delete bucket[id];
        });
      });
      Object.keys(data.completions).forEach(function (day) {
        var bucket = data.completions[day];
        if (!bucket) return;
        Object.keys(bucket).forEach(function (id) {
          if (!seen[id]) delete bucket[id];
        });
      });

      // Current and future plans are live views: rebuild them from current tasks
      // so completed/deleted/rescheduled duplicates update immediately.
      Object.keys(data.days).forEach(function (day) {
        if (day >= today) data.days[day] = { tasks: {} };
      });
      Object.keys(data.completions).forEach(function (day) {
        if (day >= today) data.completions[day] = {};
      });

      activeTasks.forEach(function (task) {
        var item = compactTask(task);
        var day = plannedDay(task);
        if (!day) return;
        if (!data.days[day]) data.days[day] = { tasks: {} };
        if (!data.days[day].tasks) data.days[day].tasks = {};
        data.days[day].tasks[task.id] = item;
      });

      tasks.forEach(function (task) {
        var item = compactTask(task);
        if (typeof item.doneOn !== 'number') return;
        var doneDay = logicalDateStr(item.doneOn);
        if (!doneDay) return;
        if (!data.completions[doneDay]) data.completions[doneDay] = {};
        data.completions[doneDay][task.id] = item;
      });

      Object.keys(data.reasons).forEach(function (key) {
        var parts = key.split('::');
        var id = parts[0], day = parts[1];
        var stillPlanned = day && data.days[day] && data.days[day].tasks && data.days[day].tasks[id];
        var isClosedDay = !!(day && data.closures[day]);
        if (!seen[id] || (day >= today && !stillPlanned && !isClosedDay)) delete data.reasons[key];
      });

      prune(data, today);
      data.lastSnapshotAt = Date.now();
      await saveData(data);
    } catch (e) {
      console.warn('[每日复盘] 创建快照失败', e);
    } finally {
      snapshotRunning = false;
      if (snapshotAgain) {
        snapshotAgain = false;
        scheduleSnapshot(1200);
      }
    }
  }

  function scheduleSnapshot(delay) {
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(function () {
      snapshotTimer = null;
      takeSnapshot();
    }, typeof delay === 'number' ? delay : 1800);
  }

  try {
    PluginAPI.registerHeaderButton({
      label: '每日复盘',
      icon: 'insights',
      onClick: function () {
        PluginAPI.showIndexHtmlAsView();
      },
    });
  } catch (e) {
    console.warn('[每日复盘] 注册顶部按钮失败', e);
  }

  try {
    PluginAPI.registerMenuEntry({
      label: '每日复盘与计划',
      icon: 'insights',
      onClick: function () {
        PluginAPI.showIndexHtmlAsView();
      },
    });
  } catch (e) {
    console.warn('[每日复盘] 注册菜单失败', e);
  }

  try {
    PluginAPI.registerShortcut({
      id: 'open_daily_review',
      label: '打开每日复盘',
      onExec: function () {
        PluginAPI.showIndexHtmlAsView();
      },
    });
  } catch (e) {
    console.warn('[每日复盘] 注册快捷键失败', e);
  }

  ['taskCreated', 'taskUpdate', 'taskComplete', 'taskDelete', 'anyTaskUpdate', 'finishDay'].forEach(function (hook) {
    try {
      PluginAPI.registerHook(hook, function () {
        scheduleSnapshot();
      });
    } catch (e) {
      // 某些旧版本可能不支持某个 hook，不影响主界面。
    }
  });

  if (typeof PluginAPI.onReady === 'function') {
    PluginAPI.onReady(function () {
      scheduleSnapshot(400);
    });
  } else {
    setTimeout(function () {
      scheduleSnapshot(800);
    }, 1000);
  }

  if (typeof PluginAPI.onUnload === 'function') {
    PluginAPI.onUnload(function () {
      if (snapshotTimer) clearTimeout(snapshotTimer);
      snapshotTimer = null;
    });
  }
})();
