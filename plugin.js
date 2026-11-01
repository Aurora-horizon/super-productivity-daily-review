/* 每日复盘与计划 —— 后台快照入口 */
(function () {
  'use strict';

  var KEY = 'daily-review-data-v1';
  var STORAGE_LIMIT_BYTES = 262144;
  var STORAGE_TARGET_BYTES = 150 * 1024;
  var DETAIL_RETENTION_DAYS = 16;
  var SUMMARY_RETENTION_DAYS = 730;
  var ARCHIVE_SCHEMA = 'super-productivity.daily-review.half-month';
  var ARCHIVE_ARG_CHUNK_CHARS = 12000;
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

  function todayStr() {
    return dateStr(new Date(Date.now() - dayOffsetMs));
  }

  function parseDay(s) {
    return new Date(s + 'T00:00:00');
  }

  function addDays(s, n) {
    var d = parseDay(s);
    d.setDate(d.getDate() + n);
    return dateStr(d);
  }

  function pct(n, d) {
    return d ? Math.round((n / d) * 100) : 0;
  }

  function reasonKey(id, day) {
    return id + '::' + day;
  }

  function byteSize(text) {
    try {
      return new Blob([text]).size;
    } catch (e) {
      return unescape(encodeURIComponent(text)).length;
    }
  }

  function hashString(s) {
    var h = 2166136261;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
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
    if (!data.version) data.version = 2;
    if (!data.days || typeof data.days !== 'object') data.days = {};
    if (!data.completions || typeof data.completions !== 'object') data.completions = {};
    if (!data.reasons || typeof data.reasons !== 'object') data.reasons = {};
    if (!data.imports || typeof data.imports !== 'object') data.imports = {};
    if (!data.closures || typeof data.closures !== 'object') data.closures = {};
    if (!data.skips || typeof data.skips !== 'object') data.skips = {};
    if (!Array.isArray(data.scheduleHistory)) data.scheduleHistory = [];
    if (!data.taskTypes || typeof data.taskTypes !== 'object') data.taskTypes = {};
    if (!data.dropped || typeof data.dropped !== 'object') data.dropped = {};
    if (!data.daySummaries || typeof data.daySummaries !== 'object') data.daySummaries = {};
    if (!data.archives || typeof data.archives !== 'object') data.archives = {};
    if (!data.fileArchives || typeof data.fileArchives !== 'object') data.fileArchives = {};
    if (!data.storage || typeof data.storage !== 'object') data.storage = { version: 1, automatic: true };
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


  function daySnapshot(task) {
    var out = { id: task.id, title: task.title || '(无标题)' };
    if (task.projectId) out.projectId = task.projectId;
    if (Number(task.timeEstimate || 0)) out.timeEstimate = Number(task.timeEstimate || 0);
    if (Number(task.timeSpent || 0)) out.timeSpent = Number(task.timeSpent || 0);
    if (task.isDone) out.isDone = true;
    if (typeof task.doneOn === 'number') out.doneOn = task.doneOn;
    if (typeof task.dueWithTime === 'number') out.dueWithTime = task.dueWithTime;
    if (task.notes) out.notes = String(task.notes);
    if (Array.isArray(task.tagIds) && task.tagIds.length) out.tagIds = task.tagIds.slice();
    if (task.repeatCfgId) out.repeatCfgId = task.repeatCfgId;
    return out;
  }

  function completionSnapshot(task) {
    var out = { id: task.id, title: task.title || '(无标题)' };
    if (task.projectId) out.projectId = task.projectId;
    if (Number(task.timeEstimate || 0)) out.timeEstimate = Number(task.timeEstimate || 0);
    if (task.isDone) out.isDone = true;
    if (typeof task.doneOn === 'number') out.doneOn = task.doneOn;
    if (task.dueDay) out.dueDay = task.dueDay;
    if (typeof task.dueWithTime === 'number') out.dueWithTime = task.dueWithTime;
    return out;
  }

  function compactStoredBuckets(data) {
    var changed = false;
    function compactBucket(bucket, mapper) {
      Object.keys(bucket || {}).forEach(function (id) {
        var current = bucket[id] || {};
        var next = mapper(current);
        if (JSON.stringify(current) !== JSON.stringify(next)) {
          bucket[id] = next;
          changed = true;
        }
      });
    }
    Object.keys(data.days || {}).forEach(function (day) {
      var item = data.days[day];
      if (!item || !item.tasks) return;
      compactBucket(item.tasks, daySnapshot);
      if (!Object.keys(item.tasks).length) { delete data.days[day]; changed = true; }
    });
    Object.keys(data.completions || {}).forEach(function (day) {
      compactBucket(data.completions[day], completionSnapshot);
      if (!Object.keys(data.completions[day] || {}).length) { delete data.completions[day]; changed = true; }
    });
    return changed;
  }

  function monthStart(s){var d=parseDay(s);d.setDate(1);return dateStr(d);}
  function nextMonth(s){var d=parseDay(monthStart(s));d.setMonth(d.getMonth()+1);return dateStr(d);}
  function monthEnd(s){var d=parseDay(monthStart(s));d.setMonth(d.getMonth()+1);d.setDate(0);return dateStr(d);}
  function summarizeDayFromData(data,day){
  var plannedBucket=data.days[day]&&data.days[day].tasks?data.days[day].tasks:{},compBucket=data.completions[day]||{},ids=Object.create(null),cids=Object.create(null),onTime=0,caughtUp=0,open=0,pending=0,missed=0,dropped=0;
  Object.keys(plannedBucket).forEach(function(id){ids[id]=true;});Object.keys(compBucket).forEach(function(id){ids[id]=true;cids[id]=true;});
  Object.keys(ids).forEach(function(id){var rec=plannedBucket[id]||compBucket[id]||{},doneRec=compBucket[id]||(rec.isDone?rec:null);if(doneRec){var done=typeof doneRec.doneOn==='number'?logicalDateStr(doneRec.doneOn):null;if(done&&done>day)caughtUp++;else onTime++;return;}if(data.dropped[reasonKey(id,day)]){open++;dropped++;return;}if(data.skips[reasonKey(id,day)]){open++;missed++;return;}if(day>=todayStr())pending++;else open++;});
  var done=onTime+caughtUp,reasonCounts=Object.create(null),reasonTotal=0;Object.keys(data.reasons).forEach(function(key){var parts=key.split('::'),reasonDay=parts[1];if(reasonDay!==day)return;var item=data.reasons[key];if(item&&item.code){reasonCounts[item.code]=(reasonCounts[item.code]||0)+1;reasonTotal++;}});
  var out={planned:Object.keys(plannedBucket).length,done:done,onTime:onTime,caughtUp:caughtUp,late:caughtUp,completed:done,doneOnDay:Object.keys(cids).length,extra:Object.keys(cids).filter(function(id){return !plannedBucket[id];}).length,open:open,pending:pending,missed:missed,dropped:dropped,unfinished:open,rate:pct(done,Object.keys(plannedBucket).length),reasonTotal:reasonTotal};if(reasonTotal)out.reasonCounts=reasonCounts;return out;
  }
  function captureHistorySummaries(data,today){
  var changed=false,days=Object.create(null);Object.keys(data.days).forEach(function(d){if(d<today)days[d]=true;});Object.keys(data.completions).forEach(function(d){if(d<today)days[d]=true;});Object.keys(data.reasons).forEach(function(k){var d=k.split('::')[1];if(d&&d<today)days[d]=true;});
  Object.keys(days).forEach(function(day){if(!data.days[day]&&!data.completions[day])return;var m=summarizeDayFromData(data,day),old=data.daySummaries[day];if(!old||JSON.stringify(old)!==JSON.stringify(m)){data.daySummaries[day]=m;changed=true;}});
  var cutoff=addDays(today,-SUMMARY_RETENTION_DAYS);Object.keys(data.daySummaries).forEach(function(day){if(day<cutoff){delete data.daySummaries[day];changed=true;}});return changed;
  }
  function periodLabel(from,to,type){var a=parseDay(from),b=parseDay(to),base=a.getFullYear()+' 年 '+(a.getMonth()+1)+' 月';if(type==='half')return base+(a.getDate()<15?'上半月':'下半月');return base;}
  function buildPeriodArchive(data,key,type,from,to){
  var cursor=from,activeDays=0,planned=0,done=0,onTime=0,caughtUp=0,extra=0,open=0,pending=0,missed=0,dropped=0,reasonCounts=Object.create(null),reasonTotal=0;
  while(cursor<=to){var m=data.daySummaries[cursor];if(m){if(m.planned||m.doneOnDay||m.reasonTotal)activeDays++;planned+=Number(m.planned||0);done+=Number(m.done||0);onTime+=Number(m.onTime||0);caughtUp+=Number(m.caughtUp||0);extra+=Number(m.extra||0);open+=Number(m.open||0);pending+=Number(m.pending||0);missed+=Number(m.missed||0);dropped+=Number(m.dropped||0);reasonTotal+=Number(m.reasonTotal||0);Object.keys(m.reasonCounts||{}).forEach(function(code){reasonCounts[code]=(reasonCounts[code]||0)+Number(m.reasonCounts[code]||0);});}cursor=addDays(cursor,1);}
  var out={key:key,type:type,label:periodLabel(from,to,type),from:from,to:to,days:activeDays,planned:planned,done:done,onTime:onTime,caughtUp:caughtUp,extra:extra,open:open,pending:pending,missed:missed,dropped:dropped,reasonTotal:reasonTotal,rate:pct(done,planned),generatedAt:Date.now()};if(reasonTotal)out.reasonCounts=reasonCounts;return out;
  }
  function periodHasDetail(data,from,to){return Object.keys(data.days).some(function(d){return d>=from&&d<=to;})||Object.keys(data.completions).some(function(d){return d>=from&&d<=to;});}
  function ensureArchive(data,key,type,from,to,today){if(to>=today)return false;var old=data.archives[key];if(old&&!periodHasDetail(data,from,to))return false;var next=buildPeriodArchive(data,key,type,from,to);if(old){var a=Object.assign({},old),b=Object.assign({},next);delete a.generatedAt;delete b.generatedAt;if(JSON.stringify(a)===JSON.stringify(b))return false;next.generatedAt=old.generatedAt||Date.now();}if(JSON.stringify(old||{})===JSON.stringify(next))return false;data.archives[key]=next;return true;}
  function ensureScheduledArchives(data,today){
  var changed=false,currentMonth=monthStart(today),earliest=Object.keys(data.daySummaries).sort()[0]||currentMonth,cursor=monthStart(earliest);
  while(cursor<currentMonth){var me=monthEnd(cursor),ym=cursor.slice(0,7),h1=addDays(cursor,14),h2=addDays(cursor,15);changed=ensureArchive(data,ym+'-M','month',cursor,me,today)||changed;changed=ensureArchive(data,ym+'-H1','half',cursor,h1,today)||changed;changed=ensureArchive(data,ym+'-H2','half',h2,me,today)||changed;cursor=nextMonth(cursor);}
  if(Number(today.slice(8,10))>=15)changed=ensureArchive(data,today.slice(0,7)+'-H1','half',currentMonth,addDays(currentMonth,14),today)||changed;
  return changed;
  }
  function removeDetailDay(data,day){
  var changed=false;if(data.days[day]){delete data.days[day];changed=true;}if(data.completions[day]){delete data.completions[day];changed=true;}if(data.closures[day]){delete data.closures[day];changed=true;}
  [data.reasons,data.skips,data.dropped].forEach(function(bucket){Object.keys(bucket).forEach(function(key){if(key.split('::')[1]===day){delete bucket[key];changed=true;}});});return changed;
  }
  function shrinkSnapshotNotes(data,maxLen){var changed=false;function trim(bucket){Object.keys(bucket||{}).forEach(function(id){var rec=bucket[id];if(rec&&typeof rec.notes==='string'&&rec.notes.length>maxLen){rec.notes=rec.notes.slice(0,maxLen);changed=true;}});}Object.keys(data.days).forEach(function(d){trim(data.days[d]&&data.days[d].tasks);});Object.keys(data.completions).forEach(function(d){trim(data.completions[d]);});return changed;}
  function compactForStorage(data,today){
  data.daySummaries=data.daySummaries&&typeof data.daySummaries==='object'?data.daySummaries:{};data.archives=data.archives&&typeof data.archives==='object'?data.archives:{};data.storage=data.storage&&typeof data.storage==='object'?data.storage:{version:1,automatic:true};
  var changed=captureHistorySummaries(data,today);changed=ensureScheduledArchives(data,today)||changed;changed=compactStoredBuckets(data)||changed;
  var cutoff=addDays(today,-DETAIL_RETENTION_DAYS),oldDays=Object.create(null);Object.keys(data.days).forEach(function(d){if(d<cutoff)oldDays[d]=true;});Object.keys(data.completions).forEach(function(d){if(d<cutoff)oldDays[d]=true;});Object.keys(data.reasons).forEach(function(k){var d=k.split('::')[1];if(d&&d<cutoff)oldDays[d]=true;});Object.keys(data.skips).forEach(function(k){var d=k.split('::')[1];if(d&&d<cutoff)oldDays[d]=true;});Object.keys(data.dropped).forEach(function(k){var d=k.split('::')[1];if(d&&d<cutoff)oldDays[d]=true;});Object.keys(oldDays).forEach(function(d){changed=removeDetailDay(data,d)||changed;});
  data.scheduleHistory=data.scheduleHistory.slice(0,50);
  function pastDetailDays(){var out=Object.create(null),todayValue=todayStr();Object.keys(data.days).forEach(function(d){if(d<todayValue)out[d]=true;});Object.keys(data.completions).forEach(function(d){if(d<todayValue)out[d]=true;});return Object.keys(out).sort();}
  var past=pastDetailDays(),removed=0;while(byteSize(JSON.stringify(data))>STORAGE_TARGET_BYTES&&past.length){var d=past.shift();if(removeDetailDay(data,d)){changed=true;removed++;}}
  if(byteSize(JSON.stringify(data))>STORAGE_TARGET_BYTES){changed=shrinkSnapshotNotes(data,600)||changed;}
  if(byteSize(JSON.stringify(data))>STORAGE_TARGET_BYTES){changed=shrinkSnapshotNotes(data,200)||changed;}
  if(byteSize(JSON.stringify(data))>STORAGE_TARGET_BYTES){changed=shrinkSnapshotNotes(data,0)||changed;}
  if(byteSize(JSON.stringify(data))>STORAGE_TARGET_BYTES&&data.taskTypes&&Object.keys(data.taskTypes).length){delete data.taskTypes;changed=true;}
  if(byteSize(JSON.stringify(data))>STORAGE_TARGET_BYTES){Object.keys(data.imports).slice(0,Math.max(0,Object.keys(data.imports).length-100)).forEach(function(k){delete data.imports[k];changed=true;});}
  var finalText=JSON.stringify(data),finalBytes=byteSize(finalText);data.storage=Object.assign({},data.storage,{version:1,automatic:true,detailRetentionDays:DETAIL_RETENTION_DAYS,summaryRetentionDays:SUMMARY_RETENTION_DAYS,targetBytes:STORAGE_TARGET_BYTES,limitBytes:STORAGE_LIMIT_BYTES,estimatedBytes:finalBytes});if(changed||removed)data.storage.lastCompactedAt=Date.now();finalText=JSON.stringify(data);data.storage.estimatedBytes=byteSize(finalText);return{changed:changed||removed>0,bytes:data.storage.estimatedBytes,removedDetails:removed,archives:Object.keys(data.archives).length};
  }

  function halfMonthPeriods(data,today){
  var dates=Object.keys(data.daySummaries||{}).concat(Object.keys(data.days||{})).filter(function(d){return d<=today;}).sort(),earliest=dates[0]||monthStart(today),limit=addDays(today,-SUMMARY_RETENTION_DAYS);if(earliest<limit)earliest=limit;var cursor=monthStart(earliest),currentMonth=monthStart(today),out=[];
  while(cursor<=currentMonth){var isCurrent=cursor===currentMonth,me=monthEnd(cursor),h1End=addDays(cursor,14),h2Start=addDays(cursor,15),ym=cursor.slice(0,7);if(!isCurrent||today>=h1End)out.push({id:ym+'-H1',from:cursor,to:h1End,label:periodLabel(cursor,h1End,'half'),final:h1End<today});if(!isCurrent||today>=me)out.push({id:ym+'-H2',from:h2Start,to:me,label:periodLabel(h2Start,me,'half'),final:me<today});cursor=nextMonth(cursor);}return out;
  }
  function archiveItemsForDay(data,day){var planned=data.days[day]&&data.days[day].tasks?data.days[day].tasks:{},comp=data.completions[day]||{},ids=Object.create(null),items=[];Object.keys(planned).forEach(function(id){ids[id]=true;});Object.keys(comp).forEach(function(id){ids[id]=true;});Object.keys(ids).forEach(function(id){var rec=planned[id]||comp[id]||{},doneRec=comp[id]||(rec.isDone?rec:null),status='open',extra=!planned[id];if(doneRec){var done=typeof doneRec.doneOn==='number'?logicalDateStr(doneRec.doneOn):null;status=done&&done>day?'late':'done';}else if(data.dropped[reasonKey(id,day)])status='dropped';else if(data.skips[reasonKey(id,day)])status='missed';var reason=data.reasons[reasonKey(id,day)]||{};items.push({id:id,title:rec.title||'(无标题)',status:status,extra:extra,timeEstimate:Number(rec.timeEstimate||0),dueWithTime:typeof rec.dueWithTime==='number'?rec.dueWithTime:null,notes:rec.notes||'',reasonCode:reason.code||'',reasonNote:reason.note||''});});return items;
  }
  function buildHalfMonthPayload(data,period,today){var days=[],cursor=period.from;while(cursor<=period.to){var summary=data.daySummaries[cursor]||summarizeDayFromData(data,cursor);days.push({day:cursor,summary:summary,items:archiveItemsForDay(data,cursor)});cursor=addDays(cursor,1);}var summary=buildPeriodArchive(data,period.id,'half',period.from,period.to);delete summary.key;delete summary.generatedAt;return{schema:ARCHIVE_SCHEMA,version:1,pluginVersion:'2.11.0',period:{id:period.id,from:period.from,to:period.to,label:period.label,final:!!period.final},summary:summary,days:days,exportedAt:new Date().toISOString()};}
  function utf8ToBase64(value) {
    if (typeof TextEncoder !== 'undefined' && typeof btoa === 'function') {
      var bytes = new TextEncoder().encode(String(value)), binary = '', step = 8192;
      for (var i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
      }
      return btoa(binary);
    }
    return btoa(unescape(encodeURIComponent(String(value))));
  }

  async function writeHalfMonthArchive(relativePath,content){
  if(typeof PluginAPI==='undefined'||typeof PluginAPI.executeNodeScript!=='function')throw new Error('当前版本不支持自动写入应用文件夹，请在设置中启用插件的 Node 文件权限');
  var script=[
  "const fs = require('fs');",
  "const path = require('path');",
  "try {",
  "  const appDir = process.resourcesPath ? path.dirname(process.resourcesPath) : path.dirname(process.execPath);",
  "  const root = path.join(appDir, 'daily-review-plugin', 'archives');",
  "  const target = path.resolve(root, args[0]);",
  "  const tmp = path.resolve(root, args[1]);",
  "  const targetRel = path.relative(root, target);",
  "  const tmpRel = path.relative(root, tmp);",
  "  if (targetRel.startsWith('..') || path.isAbsolute(targetRel) || tmpRel.startsWith('..') || path.isAbsolute(tmpRel)) return { success: false, error: 'invalid archive path' };",
  "  if (args[2] === 'abort') { try { fs.unlinkSync(tmp); } catch (_) {} return { success: true, path: target, folder: root }; }",
  "  const chunk = Buffer.from(args[3] || '', 'base64');",
  "  fs.mkdirSync(path.dirname(tmp), { recursive: true });",
  "  if (args[2] === 'start') fs.writeFileSync(tmp, chunk);",
  "  else if (args[2] === 'append') fs.appendFileSync(tmp, chunk);",
  "  else return { success: false, error: 'invalid archive action' };",
  "  if (args[4] === '1') { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(tmp, target); fs.unlinkSync(tmp); }",
  "  return { success: true, path: target, folder: root };",
  "} catch (error) { try { fs.unlinkSync(tmp); } catch (_) {} return { success: false, error: error.message }; }"
  ].join('\n');
  var encoded=utf8ToBase64(content),offset=0,tmpRelative=relativePath+'.tmp-'+Date.now()+'-'+Math.random().toString(16).slice(2),result=null,first=true;
  try{
  while(offset<encoded.length){var chunk=encoded.slice(offset,offset+ARCHIVE_ARG_CHUNK_CHARS);offset+=chunk.length;var action=first?'start':'append',last=offset>=encoded.length;first=false;var response=await PluginAPI.executeNodeScript({script:script,args:[relativePath,tmpRelative,action,chunk,last?'1':'0'],timeout:8000});result=response&&response.result;if(!response||!response.success||!result||!result.success)throw new Error((result&&result.error)||(response&&response.error)||'归档文件写入失败');}
  return result;
  }catch(e){try{await PluginAPI.executeNodeScript({script:script,args:[relativePath,tmpRelative,'abort','','0'],timeout:3000});}catch(_){}throw e;}
  }

  async function exportHalfMonthArchives(data,today,force){
  var result={written:0,skipped:0,errors:[]};if(typeof PluginAPI==='undefined'||typeof PluginAPI.executeNodeScript!=='function'){result.errors.push('未启用自动文件写入权限');return result;}
  data.fileArchives=data.fileArchives&&typeof data.fileArchives==='object'?data.fileArchives:{};var periods=halfMonthPeriods(data,today),detailCutoff=addDays(today,-DETAIL_RETENTION_DAYS);
  for(var i=0;i<periods.length;i++){var period=periods[i],old=data.fileArchives[period.id];if(old&&old.final&&old.hash&&!force){result.skipped++;continue;}try{var payload=buildHalfMonthPayload(data,period,today),stable=Object.assign({},payload);stable.exportedAt='';var hash=hashString(JSON.stringify(stable));if(old&&old.hash===hash&&old.final===payload.period.final){result.skipped++;continue;}var relative=period.from.slice(0,4)+'/'+period.from+'_'+period.to+'.json',written=await writeHalfMonthArchive(relative,JSON.stringify(payload,null,2));data.fileArchives[period.id]={id:period.id,from:period.from,to:period.to,label:period.label,path:written.path,hash:hash,final:payload.period.final,lastExportedAt:Date.now()};data.storage.archiveFolder=written.folder;result.written++;}catch(e){result.errors.push(period.label+'：'+(e&&e.message?e.message:e));}}
  if(result.errors.length)data.storage.lastArchiveError=result.errors[0];else delete data.storage.lastArchiveError;return result;
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

      tasks.forEach(function (task) {
        var day = plannedDay(task);
        if (day && day <= today) {
          if (!data.days[day]) data.days[day] = { tasks: {} };
          if (!data.days[day].tasks) data.days[day].tasks = {};
          data.days[day].tasks[task.id] = daySnapshot(task);
        }
        if (typeof task.doneOn !== 'number') return;
        var doneDay = logicalDateStr(task.doneOn);
        if (!doneDay) return;
        if (!data.completions[doneDay]) data.completions[doneDay] = {};
        data.completions[doneDay][task.id] = completionSnapshot(task);
      });

      Object.keys(data.reasons).forEach(function (key) {
        var parts = key.split('::');
        var id = parts[0], day = parts[1];
        var stillPlanned = day && data.days[day] && data.days[day].tasks && data.days[day].tasks[id];
        var isClosedDay = !!(day && data.closures[day]);
        if (!seen[id] || (day >= today && !stillPlanned && !isClosedDay)) delete data.reasons[key];
      });

      captureHistorySummaries(data, today);
      await exportHalfMonthArchives(data, today, false);
      compactForStorage(data, today);
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
    }, typeof delay === 'number' ? delay : 2600);
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




