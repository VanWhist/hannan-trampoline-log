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
                  landings (JSON文字列。1本ごとに1要素、未記録の本は null)
     - Favorites: id, athleteId, name, skillIds, createdAt
                  ※「今この名前のルーティーンはこの構成」という現行版のヘッド。
                    athleteId は所有者。空の行は「所有者なし」で、分析用の照会からは返さない。
     - RoutineVersions: versionId, routineId, athleteId, routineName, validFrom, validTo,
                        skillIds, createdAt, updatedAt
                  ※「いつからいつまで、どの構成だったか」の履歴台帳。
                    validTo が空なら現行版。routineId は Favorites の id。
                    athleteId は所有者。Favorites 側が削除されても引けるよう、版にも持たせる。
                    大会リザルトの1本目〜10本目がどの技だったかを後から復元するために使う。
                    編集では既存の行を書き換えず、期間を閉じて新しい行を足す。
   ヘッダー行は「名前」で参照するので、列順を変えても動くが名前は変えないこと。
   Webアプリとしてデプロイ(実行:自分 / アクセス:全員)。

   ★初回だけ、エディタから migrateRoutineVersions() を1回実行すること。
     既存の登録ルーティーンに validFrom=2000-01-01 の初期版を作る(何度実行しても安全)。
   ★2026-08-08 の所有者付与は migrateRoutineOwners() を1回実行すること。
     Favorites / RoutineVersions に athleteId 列を足し、既存3件に所有者を入れる。
   ===================================================================== */

var TZ = 'Asia/Tokyo';
var VERSION = 3;

/* 移行で作る初期版の開始日。「これより前は分からない」を表すだけの十分に古い日付 */
var MIN_VALID_FROM = '2000-01-01';
var VERSIONS_SHEET = 'RoutineVersions';
var VERSIONS_HEADERS = ['versionId', 'routineId', 'athleteId', 'routineName', 'validFrom', 'validTo', 'skillIds', 'createdAt', 'updatedAt'];
var FAVORITES_SHEET = 'Favorites';

/* 2026-08-08 の所有者付与。データからは所有者を復元できないので、ここに明示して1回だけ流す。
   自由1(DD8.6) は 2026-05-02 第38回大阪府年齢別 での瑛斗の2本目のDと一致することから城瑛斗と確定。
   自由2(DD9.0) はその次に上げる構成。検証用テストルーティーンは動作確認用。 */
var OWNER_ASSIGNMENT = {
  'f_msea35j7j039y5': 'ath_ms9qta3uyuxyzs',   /* 自由1 → 城瑛斗 */
  'f_msea9apn0ahahc': 'ath_ms9qta3uyuxyzs',   /* 自由2 → 城瑛斗 */
  'f_msjvufaf344ees': 'ath_msagy6o6efw06m'    /* 検証用テストルーティーン(改名) → テスト */
};


/* ---------- 技名マスタ（skillId → 技名） ----------
   別アプリ（瑛斗颯斗 選手カルテ）が skillId だけでは技名を出せないため、返り値に skillName を足す。
   正となる技の定義はアプリ本体（index.html の SKILLS）で、ここはそこから id と name だけを写した
   参照用。技を追加・改名したときは SKILLS と合わせてここも更新すること。
   未登録の id は skillName を null で返し、受け取り側で気づけるようにする。 */
var SKILL_NAMES = {
  's1':'パイククワドロフィスアウト','s2':'パイクハーフインクワドロフィスアウト','s3':'タッククワドロフィスアウト','s4':'タックハーフインクワドロフィスアウト',
  's5':'タッククワドラプルバック ※参考掲載','s6':'タック(トリプル)フル(イン)フル(イン)フル(アウトバック)','s7':'パイクフルイントリフィスアウト',
  's8':'パイクワンアンドハーフイントリフィスアウト','s9':'パイクトリフィスルディー(アウト)','s10':'パイクハーフイントリフィスルディー(アウト)','s11':'タックフルイントリフィスアウト',
  's12':'タックワンアンドハーフイントリフィスアウト','s13':'タックトリフィスルディー(アウト)','s14':'タックハーフイントリフィスルディー(アウト)','s15':'パイクトリフィスアウト',
  's16':'パイクハーフイントリフィスアウト','s17':'タックトリフィスアウト','s18':'タックハーフイントリフィスアウト','s19':'パイクトリプルバック','s20':'タックトリプルバック',
  's21':'レイアウト 2-3/4フロント','s22':'レイアウト ハーフ 2-3/4バック','s23':'パイク 2-3/4フロント','s24':'パイク ハーフ 2-3/4バック',
  's25':'タック 2-3/4フロント','s26':'タック ハーフ 2-3/4バック','s27':'パイクベビーボールアウト','s28':'タックベビーボールアウト',
  's29':'(レイアウト)ダブルインフル(アウト)','s30':'パイクベビー','s31':'(レイアウト)フルインダブル(アウト)','s32':'タックベビー',
  's33':'レイアウトフルインランディー(アウト)','s34':'(レイアウト)ダブルインダブル(アウト)','s35':'パイクフルインランディー(アウト)',
  's36':'パイクワンアンドハーフインランディー(アウト)','s37':'タックフルインランディー(アウト)','s38':'タックワンアンドハーフインランディー(アウト)',
  's39':'レイアウトフルインルディー(アウト)','s40':'(レイアウト)ミラー','s41':'レイアウトランディー(アウト)','s42':'レイアウトハーフインランディー(アウト)',
  's43':'パイクランディー(アウト)','s44':'パイクハーフインランディー(アウト)','s45':'パイクフルインルディー(アウト)','s46':'パイクワンアンドハーフインルディー(アウト)',
  's47':'タックランディー(アウト)','s48':'タックハーフインランディー(アウト)','s49':'タックフルインルディー(アウト)','s50':'タックワンアンドハーフインルディー(アウト)',
  's51':'レイアウトワンアンドハーフインハーフ(アウト)','s52':'レイアウトフルインバラニー(アウト)','s53':'レイアウトフル(イン)フル(アウト)','s54':'レイアアウトルディー(アウト)',
  's55':'レイアウトハーフインルディー(アウト)','s56':'パイクワンアンドハーフインハーフ(アウト)','s57':'パイクフルインバラニー(アウト)',
  's58':'パイクフル(イン)フル(アウト) ※参考掲載','s59':'パイクルディー(アウト)','s60':'パイクハーフインルディー(アウト)','s61':'タックワンアンドハーフインハーフ(アウト)',
  's62':'タックフルインバラニー(アウト)','s63':'タックフル(イン)フル(アウト)','s64':'タックルディー(アウト)','s65':'タックハーフインルディー(アウト)',
  's66':'レイアウトバラニーインバック','s67':'レイアウトフルインバック','s68':'レイアウト(ダブル)アウト','s69':'レイアウトハーフインハーフ(アウト)',
  's70':'レイアウトフルアウト(バック)','s71':'パイクバラニーインバック','s72':'パイクフルインバック','s73':'パイク(ダブル)アウト','s74':'パイクハーフインハーフ(アウト)',
  's75':'パイクフルアウト(バック)','s76':'タックバラニーインバック','s77':'タックフルインバック','s78':'タック(ダブル)アウト','s79':'タックハーフインハーフ(アウト)',
  's80':'タックフルアウト(バック)','s81':'レイアウト 1-3/4フロント','s82':'レイアウトダブル(バック)','s83':'パイク 1-3/4フロント','s84':'パイクダブル(バック)',
  's85':'タック 1-3/4フロント','s86':'タックダブル(バック)','s87':'(レイアウト)ランディーボールアウト','s88':'レイアウト 1-3/4バック',
  's89':'(レイアウト)ルディーボールアウト(セロロット)','s90':'パイク 1-3/4バック','s91':'(パイク)ルディーボールアウト(セロロット)','s92':'タック 1-3/4バック',
  's93':'(タック)ルディーボールアウト(セロロット)','s94':'(レイアウト)バラニーボールアウト','s95':'レイアウトコディー&レイアウト 1-1/4バック',
  's96':'(パイク)バラニーボールアウト','s97':'パイクコディー & パイク 1-1/4バック','s98':'(タック)バラニーボールアウト','s99':'タックコディー & タック 1-1/4バック',
  's100':'クワドラプルツイスト','s101':'(レイアウト)ランドルフ','s102':'トリプルツイスト','s103':'(レイアウト)ルドルフ','s104':'ダブルツイスト',
  's105':'レイアウトバラニー','s106':'フルツイスト','s107':'パイクバラニー','s108':'タックバラニー','s109':'レイアウト前宙','s110':'レイアウトバック',
  's111':'パイク前宙','s112':'パイクバック','s113':'タック前宙','s114':'タックバック','s115':'パイク前宙-シート','s116':'タック前宙-シート',
  's117':'(レイアウト)3/4フロント','s118':'レイアウト3/4バック&レイアウトプルオーバー(バックオーバー)','s119':'タック四つんばい前宙-立つ',
  's120':'パイク4/3バック&パイクプルオーバー(バックオーバー)','s121':'タック四つんばい前宙-シート','s122':'タック4/3バック&タックプルオーバー(バックオーバー)',
  's123':'(レイアウト)フルフロント','s124':'(レイアウト)フルバック','s125':'(レイアウト)ハーフバック','s126':'(レイアウト)ハーフフロント',
  's127':'レイアウトフロントドロップ(腹落ち)','s128':'レイアウトバックドロップ(背落ち)','s129':'パイクフロントドロップ(腹落ち)','s130':'パイクバックドロップ(背落ち)',
  's131':'タックフロントドロップ(腹落ち)','s132':'タックバックドロップ(背落ち)','s133':'パイクバウンス(閉脚)','s134':'ピルエット フルシート ローラー 他',
  's135':'ストラドルバウンス(開脚)','s136':'ハーフシート スイブル ハーフスタンド 他','s137':'タックバウンス(抱え)','s138':'シート 他難度点が無かった技',
  's139':'ストレートジャンプ','s140':'手決めジャンプ','s141':'気を付けジャンプ','s142':'ストレートジャンプ','s143':'手決めジャンプ','s144':'気を付けジャンプ'
};

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
// カンマ結合の列を配列に戻す(Favorites.skillIds / Entries.skills と同じ持ち方)
function splitIds_(v) {
  return String(v || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}
// "YYYY-MM-DD" だけを通す。それ以外は空文字にして、期間判定が壊れないようにする
function dateStrOrEmpty_(v) {
  var s = fmtDate_(v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

/* ---------- doGet:全データを返す ---------- */
/* ---------- 応答を速くするためのキャッシュ ----------
   doGet は毎回シートを読むため1.3〜2.8秒かかる。内容が変わるのは書き込み(doPost)のときだけなので、
   組み立てたJSONを短時間キャッシュし、書き込みのたびに捨てる。
   CacheServiceの1キーの上限は100KBなので、それを超えるサイズになったらキャッシュしない
   (記録が増えても壊れず、単に従来どおりの速度に戻るだけ)。 */
/* キーに _v4 を付けているのは、返す中身に skillName を足したため（_v3 は athleteId 追加時）。
   デプロイ直後に古い形のキャッシュが最大5分ぶん残るのを避ける。
   ★今後もデータの形を変えたらこのキーを上げること。 */
var CACHE_KEY_ALL = 'allData_v4';
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
    /* 別アプリ向けの照会。パラメータが付いているときだけこちらに入るので、
       アプリ本体のパラメータなしGET(全データ取得)の挙動は今までどおり。 */
    var type = (e && e.parameter && e.parameter.type) ? String(e.parameter.type) : '';
    if (type === 'routineVersion' || type === 'routineVersions') return routineVersionQuery_(e.parameter);

    var cache = scriptCache_();
    if (cache) {
      var hit = cache.get(CACHE_KEY_ALL);
      if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
    }
    var text = JSON.stringify({
      athletes: getAthletes_(),
      entries: getEntries_(),
      favorites: getFavorites_(),
      routineVersions: getRoutineVersions_(),
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
    return {
      id: String(o.id).trim(),
      /* 列がまだ無い/空のときは ''。呼び出し側は「所有者なし」として扱う */
      athleteId: o.athleteId === null || o.athleteId === undefined ? '' : String(o.athleteId).trim(),
      name: o.name === null || o.name === undefined ? '' : String(o.name),
      skillIds: splitIds_(o.skillIds),
      createdAt: numOrNull_(o.createdAt) || 0
    };
  });
}

/* ルーティーンの版。タブがまだ無い間は空配列を返す(アプリ側は版が無くても動く)。
   読み出しでシートを作らないのは、単に見に来ただけで書き込みが走るのを避けるため。
   タブは migrateRoutineVersions() か、最初の書き込みのときに作られる。 */
function getRoutineVersions_() {
  var sh = sheet_(VERSIONS_SHEET);
  if (!sh) return [];
  var data = sh.getDataRange().getValues();
  if (data.length < 2) return [];
  var head = data.shift().map(function (h) { return String(h).trim(); });
  return data.filter(function (row) { return String(row[0]).trim() !== ''; }).map(function (row) {
    var o = {};
    head.forEach(function (h, i) { o[h] = row[i]; });
    return {
      versionId: String(o.versionId).trim(),
      routineId: String(o.routineId).trim(),
      athleteId: o.athleteId === null || o.athleteId === undefined ? '' : String(o.athleteId).trim(),
      routineName: o.routineName === null || o.routineName === undefined ? '' : String(o.routineName),
      validFrom: dateStrOrEmpty_(o.validFrom) || MIN_VALID_FROM,
      validTo: dateStrOrEmpty_(o.validTo),
      skillIds: splitIds_(o.skillIds),
      createdAt: numOrNull_(o.createdAt) || 0,
      updatedAt: numOrNull_(o.updatedAt) || 0
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
    var skills = splitIds_(o.skills);
    return {
      id: String(o.id).trim(),
      createdAt: numOrNull_(o.createdAt) || 0,
      timestamp: fmtStamp_(o.timestamp),
      athleteId: String(o.athleteId).trim(),
      date: fmtDate_(o.date),
      platform: o.platform === null || o.platform === undefined ? '' : String(o.platform),
      mode: String(o.mode).trim(),
      skillId: o.skillId ? String(o.skillId).trim() : null,
      /* 技名。別アプリが skillId から技名を引けるようにするために付ける（2026-08-18追加）。
         SKILL_NAMES に無い id のときは null。 */
      skillName: o.skillId ? (SKILL_NAMES[String(o.skillId).trim()] || null) : null,
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

/* ---------- 別アプリ向けの照会 ----------
   GET ?type=routineVersion&athleteId=<任意>&date=YYYY-MM-DD[&routineId=<任意>]
     → その日に有効だったルーティーンの構成を返す。
   GET ?type=routineVersions
     → 全ルーティーンの全版をそのまま返す(まとめて取り込みたいとき)。

   ★athleteId は必須。この照会の目的は「その選手が、その大会日に、どの構成だったか」なので、
     選手を指定しない呼び出しは答えようがない。省略はエラーにする。

   ★所有者が確定していない版(athleteId が空)は返さない。
     分析側は「その選手の構成」しか使えない。フラグを付けて返すと、下流で
     フラグを見落とした実装が必ず出る。答えられないものは返さない。
     アプリのUI側は doGet の全データを使うので、UIでの表示には影響しない。

   技名は返さない。技カタログ(s1〜s144の名前・難度点)はアプリのHTMLの中だけにあり、
   こちら側は持っていないため。技名つきが要る場合は、アプリの
   「版の履歴」→「この履歴をJSONで書き出す」で出したJSONを使う。 */
function routineVersionQuery_(params) {
  var athleteId = params.athleteId ? String(params.athleteId).trim() : '';
  if (!athleteId) {
    return json_({ status: 'error', message: 'athleteId is required', version: VERSION });
  }

  /* 版に athleteId が無い行は、routineId から Favorites 側の所有者を引いて補う
     (移行が途中でも、片方だけ入っていれば正しく絞れるようにする) */
  var favs = getFavorites_();
  var alive = {}, ownerOfRoutine = {};
  favs.forEach(function (f) {
    alive[f.id] = true;
    if (f.athleteId) ownerOfRoutine[f.id] = f.athleteId;
  });
  function ownerOf_(v) { return v.athleteId || ownerOfRoutine[v.routineId] || ''; }

  var all = getRoutineVersions_();
  var ownerless = 0;
  var mine = all.filter(function (v) {
    var own = ownerOf_(v);
    if (!own) { ownerless++; return false; }   /* 所有者不明は返さない */
    return own === athleteId;
  });

  if (String(params.type) === 'routineVersions') {
    return json_({
      status: 'ok', athleteId: athleteId,
      routineVersions: mine, ownerlessSkipped: ownerless, version: VERSION
    });
  }

  var date = dateStrOrEmpty_(params.date || '');
  if (!date) {
    return json_({ status: 'error', message: 'date is required as YYYY-MM-DD', version: VERSION });
  }
  var routineId = params.routineId ? String(params.routineId).trim() : '';

  /* 削除されたルーティーンの版も返す(過去の大会の構成を引けなくなると困るため)。
     ただし今も一覧にあるかどうかは active で分かるようにしておく。 */
  var hits = mine.filter(function (v) {
    if (routineId && v.routineId !== routineId) return false;
    /* その日に有効だった版 = validFrom <= date <= validTo(空なら無期限) */
    return v.validFrom <= date && (!v.validTo || date <= v.validTo);
  }).map(function (v) {
    return {
      routineId: v.routineId,
      athleteId: ownerOf_(v),
      routineName: v.routineName,
      versionId: v.versionId,
      validFrom: v.validFrom,
      validTo: v.validTo,
      skillIds: v.skillIds,
      active: !!alive[v.routineId]
    };
  });

  return json_({
    status: 'ok',
    date: date,
    athleteId: athleteId,
    routines: hits,
    ownerlessSkipped: ownerless,   /* 定常状態では常に0。0でなければ割り当て漏れ */
    version: VERSION
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
    else if (type === 'updateFavorite') out = updateFavorite_(payload);
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

/* ---------- ルーティーンの版の読み書き ---------- */

/* RoutineVersions タブが無ければ作る。書き込みのときだけ呼ぶ。 */
function ensureVersionsSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(VERSIONS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(VERSIONS_SHEET);
    sh.getRange(1, 1, 1, VERSIONS_HEADERS.length).setValues([VERSIONS_HEADERS]);
    sh.setFrozenRows(1);
  } else {
    /* 既存シートに athleteId 列が無ければ routineId の直後に足す */
    var head = headers_(sh);
    if (head.indexOf('athleteId') < 0) {
      var after = head.indexOf('routineId') + 1;   /* 1始まりの列番号 */
      if (after < 1) after = sh.getLastColumn();
      sh.insertColumnAfter(after);
      sh.getRange(1, after + 1).setValue('athleteId');
    }
  }
  /* validFrom / validTo は書式なしテキストにしておく。
     Sheetsが日付型に変えてしまうと、手で開いて直したときに表記が揺れるため。
     列位置は名前から引く(列を足しても壊れないように)。 */
  var h2 = headers_(sh);
  var cf = h2.indexOf('validFrom'), ct = h2.indexOf('validTo');
  if (cf >= 0 && sh.getMaxRows() > 1) sh.getRange(2, cf + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  if (ct >= 0 && sh.getMaxRows() > 1) sh.getRange(2, ct + 1, sh.getMaxRows() - 1, 1).setNumberFormat('@');
  return sh;
}

/* 版オブジェクトを、RoutineVersionsシートのヘッダー順に並べた1行に変換する。
   日付は先頭アポストロフィで文字列固定(Entriesのdateと同じやり方)。 */
function versionRowByHeaders_(head, v) {
  return head.map(function (h) {
    if (h === 'validFrom') return "'" + (v.validFrom || MIN_VALID_FROM);
    if (h === 'validTo') return v.validTo ? ("'" + v.validTo) : '';
    if (h === 'skillIds') return Array.isArray(v.skillIds) ? v.skillIds.join(',') : (v.skillIds || '');
    var x = v[h];
    return (x === null || x === undefined) ? '' : x;
  });
}

function appendVersion_(sh, head, v) {
  sh.appendRow(versionRowByHeaders_(head, v));
}

/* versionId → シートの行番号 の対応表。1回の読み出しで作る。 */
function versionRowIndex_(sh, head) {
  var idCol = head.indexOf('versionId');
  var map = {};
  if (idCol < 0) return map;
  var last = sh.getLastRow();
  if (last < 2) return map;
  var col = sh.getRange(2, idCol + 1, last - 1, 1).getValues();
  for (var i = 0; i < col.length; i++) {
    var id = String(col[i][0]).trim();
    if (id) map[id] = i + 2;   /* 見出し行のぶん +2 */
  }
  return map;
}

/* 1つのセルだけ書き換える小さなヘルパ。既存の行を丸ごと書き戻さないのは、
   他の列を意図せず上書きしないため。 */
function setVersionCell_(sh, head, rowNo, colName, value) {
  var c = head.indexOf(colName);
  if (c < 0) return;
  sh.getRange(rowNo, c + 1).setValue(value);
}

/* Favorites に athleteId 列が無ければ足す。書き込みのときだけ呼ぶ。 */
function ensureFavoritesAthleteColumn_() {
  var sh = sheet_(FAVORITES_SHEET);
  var head = headers_(sh);
  if (head.indexOf('athleteId') < 0) {
    sh.insertColumnAfter(1);
    sh.getRange(1, 2).setValue('athleteId');
    head = headers_(sh);
  }
  return sh;
}

/* ヘッダー名で並べた1行に変換する(列を足しても順序に依存しないようにするため) */
function favoriteRowByHeaders_(head, p) {
  return head.map(function (h) {
    if (h === 'skillIds') return Array.isArray(p.skillIds) ? p.skillIds.join(',') : (p.skillIds || '');
    var v = p[h];
    return (v === null || v === undefined) ? '' : v;
  });
}

function addFavorite_(p) {
  var sh = ensureFavoritesAthleteColumn_();
  var head = headers_(sh);
  sh.appendRow(favoriteRowByHeaders_(head, {
    id: p.id || '', athleteId: p.athleteId || '', name: p.name || '',
    skillIds: p.skillIds, createdAt: p.createdAt || (new Date()).getTime()
  }));
  /* 新規登録の時点で初期版を1つ作る。版を持たないルーティーンを増やさないため。
     古いアプリ(版を送ってこないHTML)から来た場合でも落ちないように、無ければ作らない。 */
  if (p.version) {
    var vsh = ensureVersionsSheet_();
    appendVersion_(vsh, headers_(vsh), p.version);
  }
  return { status: 'ok', id: p.id };
}

/* ルーティーンの更新。
   - Favorites の行(現行版のヘッド)を name / skillIds で更新する
   - renameAllVersions が true なら、その routineId の全版の routineName を更新する
     (名前だけの変更では版を増やさない、という決めのため)
   - versionOps を順に適用する
       { op:'close',  versionId, validTo, updatedAt }         … 期間を閉じる
       { op:'update', versionId, routineName, skillIds, updatedAt } … その日の版を書き換える
       { op:'add',    version:{...} }                          … 新しい版を足す
   既存の版の行を「技構成ごと」上書きするのは 'update'(同じ日に2回編集した場合)だけで、
   通常の編集では 'close' + 'add' になる。過去の構成は消さない。 */
function updateFavorite_(p) {
  var lock = LockService.getScriptLock();
  /* 版の台帳は読んで書く処理なので、同時に走ると期間がずれる。10秒だけ待つ。 */
  if (!lock.tryLock(10000)) {
    return { status: 'error', message: 'busy: could not acquire lock' };
  }
  try {
    var id = String(p.id || '').trim();
    if (!id) return { status: 'error', message: 'id is required' };

    /* --- Favorites のヘッドを更新 --- */
    var fsh = ensureFavoritesAthleteColumn_();
    var fhead = headers_(fsh);
    var fdata = fsh.getDataRange().getValues();
    var idCol = fhead.indexOf('id');
    var updatedHead = 0;
    for (var r = 1; r < fdata.length; r++) {
      if (String(fdata[r][idCol]).trim() !== id) continue;
      var nameCol = fhead.indexOf('name');
      var idsCol = fhead.indexOf('skillIds');
      var aidCol = fhead.indexOf('athleteId');
      if (nameCol >= 0) fsh.getRange(r + 1, nameCol + 1).setValue(p.name || '');
      if (idsCol >= 0) fsh.getRange(r + 1, idsCol + 1).setValue(Array.isArray(p.skillIds) ? p.skillIds.join(',') : (p.skillIds || ''));
      /* 所有者は編集で変えない。空のときだけ、送られてきた値で埋める(移行の取りこぼし対策) */
      if (aidCol >= 0 && p.athleteId && !String(fdata[r][aidCol]).trim()) {
        fsh.getRange(r + 1, aidCol + 1).setValue(p.athleteId);
      }
      updatedHead++;
    }

    /* --- 版の台帳を更新 --- */
    var vsh = ensureVersionsSheet_();
    var vhead = headers_(vsh);
    var rowOf = versionRowIndex_(vsh, vhead);

    if (p.renameAllVersions) {
      var ridCol = vhead.indexOf('routineId');
      var vlast = vsh.getLastRow();
      if (ridCol >= 0 && vlast >= 2) {
        var rids = vsh.getRange(2, ridCol + 1, vlast - 1, 1).getValues();
        for (var i = 0; i < rids.length; i++) {
          if (String(rids[i][0]).trim() === id) setVersionCell_(vsh, vhead, i + 2, 'routineName', p.name || '');
        }
      }
    }

    var ops = p.versionOps || [];
    var applied = 0;
    for (var k = 0; k < ops.length; k++) {
      var op = ops[k];
      if (op.op === 'add') {
        appendVersion_(vsh, vhead, op.version);
        if (op.version && op.version.versionId) rowOf[String(op.version.versionId)] = vsh.getLastRow();
        applied++;
      } else if (op.op === 'close') {
        var rc = rowOf[String(op.versionId)];
        if (rc) {
          setVersionCell_(vsh, vhead, rc, 'validTo', op.validTo ? ("'" + op.validTo) : '');
          if (op.updatedAt) setVersionCell_(vsh, vhead, rc, 'updatedAt', op.updatedAt);
          applied++;
        }
      } else if (op.op === 'update') {
        var ru = rowOf[String(op.versionId)];
        if (ru) {
          if (op.routineName !== undefined) setVersionCell_(vsh, vhead, ru, 'routineName', op.routineName || '');
          if (op.skillIds !== undefined) setVersionCell_(vsh, vhead, ru, 'skillIds', Array.isArray(op.skillIds) ? op.skillIds.join(',') : (op.skillIds || ''));
          if (op.updatedAt) setVersionCell_(vsh, vhead, ru, 'updatedAt', op.updatedAt);
          applied++;
        }
      }
    }
    return { status: 'ok', id: id, head: updatedHead, ops: applied };
  } finally {
    lock.releaseLock();
  }
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

/* ルーティーンを削除しても RoutineVersions は消さない。
   消すと、過去の大会がどの構成だったかを引けなくなるため。 */
function deleteFavorite_(p) {
  var n = deleteById_('Favorites', p.id);
  return { status: 'ok', id: p.id, deleted: n };
}

/* =====================================================================
   移行: 既存の登録ルーティーンに初期版を作る
   ---------------------------------------------------------------------
   エディタの実行メニューから1回だけ実行する。何度実行しても安全
   (すでに版を持っているルーティーンは飛ばす)。
   validFrom を十分に古い日付にするのは、過去の記録が版なしで孤立しないようにするため。
   ===================================================================== */
/* =====================================================================
   移行: 登録ルーティーンに所有者(athleteId)を入れる  ★2026-08-08 追加
   ---------------------------------------------------------------------
   エディタの実行メニューから1回だけ実行する。何度実行しても安全。
     1. Favorites / RoutineVersions に athleteId 列が無ければ足す
     2. OWNER_ASSIGNMENT に書いた routineId → athleteId を Favorites に入れる
     3. RoutineVersions の athleteId を、Favorites 側の所有者で埋める
        (版は routineId でルーティーンに属するので、所有者はヘッドから引ける)
   すでに値が入っている行は上書きしない。
   実行後、所有者が空のまま残った件数をログに出す。ここが0になるのが正しい状態。
   ===================================================================== */
function migrateRoutineOwners() {
  var fsh = ensureFavoritesAthleteColumn_();
  var fhead = headers_(fsh);
  var fdata = fsh.getDataRange().getValues();
  var fIdCol = fhead.indexOf('id'), fAidCol = fhead.indexOf('athleteId'), fNameCol = fhead.indexOf('name');

  var assigned = [], already = [], unknown = [];
  var ownerOf = {};
  for (var r = 1; r < fdata.length; r++) {
    var rid = String(fdata[r][fIdCol]).trim();
    if (!rid) continue;
    var cur = fAidCol >= 0 ? String(fdata[r][fAidCol]).trim() : '';
    var nm = fNameCol >= 0 ? String(fdata[r][fNameCol]) : rid;
    if (cur) { ownerOf[rid] = cur; already.push(nm + '(' + cur + ')'); continue; }
    var want = OWNER_ASSIGNMENT[rid] || '';
    if (!want) { unknown.push(nm + ' [' + rid + ']'); continue; }
    fsh.getRange(r + 1, fAidCol + 1).setValue(want);
    ownerOf[rid] = want;
    assigned.push(nm + ' → ' + want);
  }

  /* --- 版の台帳にも所有者を入れる --- */
  var vsh = ensureVersionsSheet_();
  var vhead = headers_(vsh);
  var vAidCol = vhead.indexOf('athleteId'), vRidCol = vhead.indexOf('routineId');
  var vlast = vsh.getLastRow();
  var vFilled = 0, vOwnerless = 0;
  if (vlast >= 2 && vAidCol >= 0 && vRidCol >= 0) {
    var vals = vsh.getRange(2, 1, vlast - 1, vsh.getLastColumn()).getValues();
    for (var i = 0; i < vals.length; i++) {
      var vr = String(vals[i][vRidCol]).trim();
      if (!vr) continue;
      var have = String(vals[i][vAidCol]).trim();
      if (have) continue;
      var own = ownerOf[vr] || OWNER_ASSIGNMENT[vr] || '';
      if (own) { vsh.getRange(i + 2, vAidCol + 1).setValue(own); vFilled++; }
      else { vOwnerless++; }
    }
  }

  dropCache_();
  var msg = '所有者を付与: ' + (assigned.length ? assigned.join(' / ') : 'なし') +
    '\nすでに所有者あり: ' + (already.length ? already.join(' / ') : 'なし') +
    '\n★割り当て先が未定義のルーティーン: ' + (unknown.length ? unknown.join(' / ') : 'なし') +
    '\n版に所有者を反映: ' + vFilled + '件 / 所有者不明のまま残った版: ' + vOwnerless + '件' +
    '\n(定常状態では「未定義」も「所有者不明のまま」も0件が正しい)';
  Logger.log(msg);
  return msg;
}

function migrateRoutineVersions() {
  var favs = getFavorites_();
  var vsh = ensureVersionsSheet_();
  var vhead = headers_(vsh);
  var existing = getRoutineVersions_();

  var has = {};
  existing.forEach(function (v) { has[v.routineId] = true; });

  var now = (new Date()).getTime();
  var created = [], skipped = [];
  favs.forEach(function (f) {
    if (has[f.id]) { skipped.push(f.name); return; }
    var v = {
      versionId: 'rv_mig_' + f.id,
      routineId: f.id,
      athleteId: f.athleteId || OWNER_ASSIGNMENT[f.id] || '',
      routineName: f.name,
      validFrom: MIN_VALID_FROM,
      validTo: '',
      skillIds: f.skillIds,
      createdAt: f.createdAt || now,
      updatedAt: now
    };
    appendVersion_(vsh, vhead, v);
    created.push(f.name);
  });

  dropCache_();
  var msg = '初期版を作成: ' + (created.length ? created.join(', ') : 'なし') +
    ' / すでに版あり(スキップ): ' + (skipped.length ? skipped.join(', ') : 'なし');
  Logger.log(msg);
  return msg;
}
