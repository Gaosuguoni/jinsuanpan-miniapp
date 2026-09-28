// 云函数 asr：录音文件 → 腾讯云「一句话识别」→ 文字
// 版本：asr-2026-09-13-v7（返回值里带 version，方便确认云端跑的是哪一版）
// v6 修复：环境变量值做白名单校验，填错（如误粘表格文字）自动回退默认值，不再导致识别失败。
// 设计：
//   1) 优先用云存储临时 URL（SourceType=0）交给腾讯云拉取音频；
//   2) URL 方式失败时，退回 base64 直传（SourceType=1，作兜底）；
//   3) SourceType 必须是 uint64 数字，且语义为：0=语音URL，1=语音数据（v5 修复点，由真机报错互相印证）；
//   5) 每人每天限次（防刷量，默认 50 次/天，可用环境变量 ASR_DAILY_LIMIT 调整）。
//   4) 密钥只在服务端；识别完删除云存储录音。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

let localCfg = {};
try { localCfg = require('./config'); } catch (e) { localCfg = {}; }

const VERSION = 'asr-2026-09-13-v7';
const SECRET_ID = process.env.ASR_SECRET_ID || localCfg.secretId || '';
const SECRET_KEY = process.env.ASR_SECRET_KEY || localCfg.secretKey || '';    
// ---- 环境变量清洗：去掉引号/空白，并做白名单校验，填错自动回退（v6） ----
const ENGINE_WHITELIST = ['16k_zh', '16k_zh_dialect', '16k_zh_large', '16k_yue', '16k_en'];
const REGION_WHITELIST = ['ap-guangzhou', 'ap-shanghai', 'ap-beijing', 'ap-chengdu', 'ap-chongqing', 'ap-nanjing', 'ap-hongkong', 'ap-singapore'];

function pickValid(raw, whitelist, fallback, label) {
  var s = String(raw == null ? '' : raw).trim().replace(/^[\"'\"]+|[\"'\"]+$/g, '');
  if (!s) return fallback;
  if (whitelist.indexOf(s) >= 0) return s;
  console.warn('[asr] %s 值不合法（已自动回退为 %s）：%s', label, fallback, s.slice(0, 60));
  return fallback;
}

const ENGINE = pickValid(process.env.ASR_ENGINE || localCfg.engine, ENGINE_WHITELIST, '16k_zh', 'ASR_ENGINE');
const REGION = pickValid(process.env.ASR_REGION || localCfg.region, REGION_WHITELIST, 'ap-guangzhou', 'ASR_REGION');

const tencentcloud = require('tencentcloud-sdk-nodejs');
const AsrClient = tencentcloud.asr.v20190614.Client;

function buildClient() {
  return new AsrClient({
    credential: { secretId: SECRET_ID, secretKey: SECRET_KEY },
    region: REGION,
    profile: { httpProfile: { endpoint: 'asr.tencentcloudapi.com', reqTimeout: 30 } }
  });
}

// 方式一：URL（腾讯云自己去拉音频）
function recognizeByUrl(client, url, format) {
  return client.SentenceRecognition({
    EngSerViceType: ENGINE,
    SourceType: 0, // 0 = 语音URL
    VoiceFormat: format,
    Url: url,
    ProjectId: 0,
    SubServiceType: 2
  });
}

// 方式二：base64 直传（兜底）
function recognizeByData(client, buffer, format) {
  return client.SentenceRecognition({
    EngSerViceType: ENGINE,
    SourceType: 1, // 1 = 语音数据(base64)
    VoiceFormat: format,
    Data: buffer.toString('base64'),
    DataLen: buffer.length,
    ProjectId: 0,
    SubServiceType: 2
  });
}

const USAGE_COLL = 'asr_usage';
const DAILY_LIMIT = parseInt(process.env.ASR_DAILY_LIMIT || '50', 10) || 50;

function todayStr() {
  var d = new Date();
  var p = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/** 每人每天限次：返回 { limited, used }；计数失败时放行（不因统计故障挡住记账） */
async function checkAndBumpUsage(openid, dateKey) {
  try {
    try { await db.createCollection(USAGE_COLL); } catch (e) { /* 已存在 */ }
    const col = db.collection(USAGE_COLL);
    const found = await col.where({ _openid: openid, date: dateKey }).limit(1).get();
    const row = found.data && found.data[0];
    const used = row ? (Number(row.count) || 0) : 0;
    if (used >= DAILY_LIMIT) return { limited: true, used: used };
    if (row) await col.doc(row._id).update({ data: { count: used + 1 } });
    else await col.add({ data: { _openid: openid, date: dateKey, count: 1 } });
    return { limited: false, used: used + 1 };
  } catch (e) {
    console.warn('[asr] 限次统计失败（本次放行）：%s', (e && e.message) || e);
    return { limited: false, used: 0, degraded: true };
  }
}

exports.main = async (event) => {
  const fileID = (event && event.fileID) || '';
  const format = ((event && event.format) || 'mp3').toLowerCase();

  if (!fileID) return { ok: false, error: '缺少录音文件', version: VERSION };
  if (!SECRET_ID || !SECRET_KEY) {
    return {
      ok: false,
      version: VERSION,
      error: '未配置语音识别密钥：请在云开发控制台 → 云函数 asr → 配置 → 环境变量里加 ASR_SECRET_ID / ASR_SECRET_KEY'
    };
  }

  // 每人每天限次（防刷量）
  const ctx = cloud.getWXContext() || {};
  const openid = ctx.OPENID || 'anonymous';
  const usage = await checkAndBumpUsage(openid, todayStr());
  if (usage.limited) {
    return { ok: false, version: VERSION, error: '今天的语音识别次数已用完（每天 ' + DAILY_LIMIT + ' 次），明天再试或先用打字记账', used: usage.used, limit: DAILY_LIMIT };
  }

  // 1) 读录音（兜底直传用 + 校验大小）
  let buffer;
  try {
    const dl = await cloud.downloadFile({ fileID: fileID });
    buffer = dl.fileContent;
  } catch (e) {
    return { ok: false, version: VERSION, error: '读取录音失败：' + ((e && e.message) || e) };
  }
  if (!buffer || !buffer.length) return { ok: false, version: VERSION, error: '录音文件为空' };
  if (buffer.length > 3 * 1024 * 1024) return { ok: false, version: VERSION, error: '录音太长了，请说短一点（3MB/约60秒以内）' };

  // 2) 取临时 URL（记录失败原因，便于排查）
  let tempUrl = '';
  let urlErr = '';
  try {
    const u = await cloud.getTempFileURL({ fileList: [fileID] });
    const item = (u && u.fileList && u.fileList[0]) || {};
    tempUrl = item.tempFileURL || '';
    if (!tempUrl) urlErr = item.errMsg || item.status || 'empty tempFileURL';
  } catch (e) {
    urlErr = (e && e.message) || String(e);
  }

  console.log('[asr] version=%s fileID=%s bytes=%d url=%s urlErr=%s engine=%s',
    VERSION, fileID, buffer.length, tempUrl ? 'yes' : 'no', urlErr || '-', ENGINE);

  const client = buildClient();
  let text = '';
  let mode = tempUrl ? 'url' : 'data';
  let lastErr = '';

  try {
    const resp = tempUrl
      ? await recognizeByUrl(client, tempUrl, format)
      : await recognizeByData(client, buffer, format);
    text = (resp && resp.Result) || '';
  } catch (e) {
    lastErr = (e && e.message) || String(e);
    // URL 方式失败 → 退回 base64 直传再试一次（两条错误都保留，便于排查）
    if (tempUrl) {
      const urlFailMsg = lastErr;
      try {
        mode = 'data(fallback)';
        const resp2 = await recognizeByData(client, buffer, format);
        text = (resp2 && resp2.Result) || '';
        lastErr = '';
      } catch (e2) {
        lastErr = 'URL方式: ' + urlFailMsg + '；数据方式: ' + ((e2 && e2.message) || String(e2));
      }
    }
  } finally {
    try { await cloud.deleteFile({ fileList: [fileID] }); } catch (e) { /* ignore */ }
  }

  if (!text) {
    return {
      ok: false,
      version: VERSION,
      mode: mode,
      urlGot: !!tempUrl,
      urlErr: urlErr || undefined,
      error: '语音识别失败：' + (lastErr || '未返回识别结果') + ' [v=' + VERSION + ' mode=' + mode + ' urlGot=' + (tempUrl ? '1' : '0') + ' urlErr=' + (urlErr || '-') + ']'
    };
  }
  return { ok: true, version: VERSION, mode: mode, urlGot: !!tempUrl, used: usage.used, limit: DAILY_LIMIT, urlErr: urlErr || undefined, text: text };
};
