/* =====================================================================
   【バックアップ】RoutineVersions 追加前の Apps Script（2026-08-08 時点・バージョン4）
   問題が起きたら、このファイルの中身を Apps Script に貼り戻して再デプロイすれば元に戻る。
   ※ Apps Script 側の「デプロイを管理」にもバージョン履歴が残っている。
   ===================================================================== */

/* =====================================================================
   阪南大学トランポリンクラブ 記録アプリ  —  Apps Script バックエンド
   -------------------------------------------------------------------
   スプレッドシート「阪南大学トランポリンクラブ記録」にバインドして使用。
   タブ構成:
     - Athletes : id, name, createdAt
     - Entries  : id, createdAt, timestamp, athleteId, date, platform, mode,
                  skillId, success, fail, kakari, kakariTarget, note, totalDD,
                  routineName, skills, airTime, airTimeReps, tScore, result,
                  videoSuccessName, videoSuccessUrl, videoFailName, videoFailUrl,
                    reps, repResults  (repsは総本数。repResultsは1本=1文字で ○成功/×失敗/-未選択)
     - Favorites: id, name, skillIds, createdAt
   ヘッダー行は「名前」で参照するので、列順を変えても動くが名前は変えないこと。
   Webアプリとしてデプロイ(実行:自分 / アクセス:全員)。
   ===================================================================== */

var TZ = 'Asia/Tokyo';
var VERSION = 1;

/* ---------- 共通ヘルパ ---------- */
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
function sheet_(name) {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
}
// ヘッダー行(トリム済み)を返す
function headers_(sheet) {
  var lastCol = sheet.getLastColumn();
  if (lastCol < 1) return [];
  return sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h).trim();
  });
}
// 日付っぽい列を安全に文字列へ戻す(Sheetsが勝手にDate化した場合の保険)
function fmtDate_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return v === null || v === undefined ? '' : String(v);
}
function fmtStamp_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm:ss');
  return v === null || v === undefined ? '' : String(v);
}
function numOrNull_(v) {
  if (v === '' || v === null || v === undefined) return null;
  var n = Number(v);
  return isNaN(n) ? null : n;
}

/* ---------- doGet:全データを返す ---------- */
/* ---------- 応答を速くするためのキャッシュ ----------
   doGet は毎回3つのシートを読むため1.3〜2.8秒かかる。内容が変わるのは書き込み(doPost)のときだけなので、
   組み立てたJSONを短時間キャッシュし、書き込みのたびに捨てる。
   CacheServiceの1キーの上限は100KBなので、それを超えるサイズになったらキャッシュしない
   (記録が増えても壊れず、単に従来どおりの速度に戻るだけ)。 */
var CACHE_KEY_ALL = 'allData_v1';
var CACHE_TTL_SEC = 300;      /* 書き込み時に必ず捨てるので、これは取りこぼし用の保険 */
var CACHE_MAX_BYTES = 90000;

function scriptCache_() {
  try { return CacheService.getScriptCache(); } catch (e) { return null; }
}
function dropCache_() {
  var c = scriptCache_();
  if (c) { try { c.remove(CACHE_KEY_ALL); } catch (e) {} }
}

function doGet(e) {
  try {
    var cache = scriptCache_();
    if (cache) {
      var hit = cache.get(CACHE_KEY_ALL);
      if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
    }
    var text = JSON.stringify({
      athletes: getAthletes_(),
      entries: getEntries_(),
      favorites: getFavorites_(),
      version: VERSION
    });
    if (cache && text.length < CACHE_MAX_BYTES) {
      try { cache.put(CACHE_KEY_ALL, text, CACHE_TTL_SEC); } catch (e2) {}
    }
    return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return json_({ status: 'error', message: String(err), version: VERSION });
  }
}

function getAthletes_() {
  var sh = sheet_('Athletes');
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var head = data.shift().map(function (h) { return String(h).trim(); });
  return data.filter(function (row) { return String(row[0]).trim() !== ''; }).map(function (row) {
    var o = {};
    head.forEach(function (h, i) { o[h] = row[i]; });
    return {
      id: String(o.id).trim(),
      name: o.name === null || o.name === undefined ? '' : String(o.name),
      createdAt: numOrNull_(o.createdAt) || 0
    };
  });
}

function getFavorites_() {
  var sh = sheet_('Favorites');
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var head = data.shift().map(function (h) { return String(h).trim(); });
  return data.filter(function (row) { return String(row[0]).trim() !== ''; }).map(function (row) {
    var o = {};
    head.forEach(function (h, i) { o[h] = row[i]; });
    var ids = String(o.skillIds || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return {
      id: String(o.id).trim(),
      name: o.name === null || o.name === undefined ? '' : String(o.name),
      skillIds: ids,
      createdAt: numOrNull_(o.createdAt) || 0
    };
  });
}

function getEntries_() {
  var sh = sheet_('Entries');
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var head = data.shift().map(function (h) { return String(h).trim(); });
  return data.filter(function (row) { return String(row[0]).trim() !== ''; }).map(function (row) {
    var o = {};
    head.forEach(function (h, i) { o[h] = row[i]; });
    var skills = String(o.skills || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return {
      id: String(o.id).trim(),
      createdAt: numOrNull_(o.createdAt) || 0,
      timestamp: fmtStamp_(o.timestamp),
      athleteId: String(o.athleteId).trim(),
      date: fmtDate_(o.date),
      platform: o.platform === null || o.platform === undefined ? '' : String(o.platform),
      mode: String(o.mode).trim(),
      skillId: o.skillId ? String(o.skillId).trim() : null,
      success: numOrNull_(o.success),
      fail: numOrNull_(o.fail),
      reps: numOrNull_(o.reps),
      repResults: o.repResults == null ? '' : String(o.repResults),
      landings: o.landings === null || o.landings === undefined ? '' : String(o.landings),
      kakari: o.kakari === true || String(o.kakari).toLowerCase() === 'true',
      kakariTarget: o.kakariTarget ? String(o.kakariTarget).trim() : null,
      note: o.note === null || o.note === undefined ? '' : String(o.note),
      totalDD: numOrNull_(o.totalDD),
      routineName: o.routineName === null || o.routineName === undefined ? '' : String(o.routineName),
      skills: skills,
      airTime: numOrNull_(o.airTime),
      airTimeReps: numOrNull_(o.airTimeReps),
      tScore: numOrNull_(o.tScore),
      result: o.result ? String(o.result).trim() : null,
      videoSuccessName: o.videoSuccessName ? String(o.videoSuccessName) : null,
      videoSuccessUrl: o.videoSuccessUrl ? String(o.videoSuccessUrl) : null,
      videoFailName: o.videoFailName ? String(o.videoFailName) : null,
      videoFailUrl: o.videoFailUrl ? String(o.videoFailUrl) : null
    };
  });
}

/* ---------- doPost:type で分岐 ---------- */
function doPost(e) {
  try {
    var payload = JSON.parse(e.postData.contents);
    var type = payload.type;
    var out;
    if (type === 'addAthlete') out = addAthlete_(payload);
    else if (type === 'saveEntry') out = saveEntry_(payload);
    else if (type === 'deleteEntry') out = deleteEntry_(payload);
    else if (type === 'addFavorite') out = addFavorite_(payload);
    else if (type === 'deleteFavorite') out = deleteFavorite_(payload);
    else out = { status: 'error', message: 'unknown type: ' + type };
    dropCache_(); return json_(out);
  } catch (err) {
    dropCache_(); return json_({ status: 'error', message: String(err) });
  }
}

// エントリオブジェクトを、Entriesシートのヘッダー順に並べた1行に変換する。
// date は先頭アポストロフィで文字列固定、skills は配列→カンマ結合、timestamp はサーバ時刻。
function entryRowByHeaders_(head, entry, timestamp) {
  return head.map(function (h) {
    if (h === 'timestamp') return timestamp;
    if (h === 'date') return "'" + (entry.date || '');
    if (h === 'skills') return Array.isArray(entry.skills) ? entry.skills.join(',') : (entry.skills || '');
    if (h === 'kakari') return entry.kakari ? 'true' : 'false';
    var v = entry[h];
    return (v === null || v === undefined) ? '' : v;
  });
}

function addAthlete_(p) {
  var sh = sheet_('Athletes');
  sh.appendRow([p.id || '', p.name || '', p.createdAt || (new Date()).getTime()]);
  return { status: 'ok', id: p.id };
}

function saveEntry_(p) {
  var entry = p.entry || {};
  var sh = sheet_('Entries');
  var head = headers_(sh);
  sh.appendRow(entryRowByHeaders_(head, entry, new Date()));
  return { status: 'ok', id: entry.id };
}

function addFavorite_(p) {
  var sh = sheet_('Favorites');
  var ids = Array.isArray(p.skillIds) ? p.skillIds.join(',') : (p.skillIds || '');
  sh.appendRow([p.id || '', p.name || '', ids, p.createdAt || (new Date()).getTime()]);
  return { status: 'ok', id: p.id };
}

// id 一致行を削除する汎用関数(1列目=id 前提)
function deleteById_(sheetName, id) {
  var sh = sheet_(sheetName);
  var data = sh.getDataRange().getValues();
  var deleted = 0;
  // 下から走査して行番号ズレを防ぐ
  for (var r = data.length - 1; r >= 1; r--) {
    if (String(data[r][0]).trim() === String(id).trim()) {
      sh.deleteRow(r + 1);
      deleted++;
    }
  }
  return deleted;
}

function deleteEntry_(p) {
  var n = deleteById_('Entries', p.id);
  return { status: 'ok', id: p.id, deleted: n };
}

function deleteFavorite_(p) {
  var n = deleteById_('Favorites', p.id);
  return { status: 'ok', id: p.id, deleted: n };
}
