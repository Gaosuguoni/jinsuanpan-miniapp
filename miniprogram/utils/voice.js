// Plan B 语音层：小程序自带录音（wx.getRecorderManager）+ 云函数 ASR（腾讯云语音识别）
// 为什么不用插件：同声传译插件对服务类目/主体有要求，加不上；自带录音无任何插件依赖。
// 链路：按住说话 → 录音(mp3) → 上传云存储 → 调云函数 asr → 返回文字 → 走记账引擎。
var engine = require('./engine');

var RECORD_FORMAT = 'mp3';
var RECORD_OPTIONS = {
  duration: 60000,          // 最长 60 秒
  sampleRate: 16000,        // 16k，语音识别标准采样率
  numberOfChannels: 1,      // 单声道
  encodeBitRate: 48000,
  format: RECORD_FORMAT
};

var recorder = null;
var cbs = null;

function isAvailable() {
  return !!(typeof wx !== 'undefined' && wx.getRecorderManager);
}

function getReason() {
  return '语音识别走云端：请先在 config.js 填好 cloudEnv，并部署 asr 云函数（腾讯云语音识别密钥配在云函数里）';
}

// 隐私协议 + 麦克风授权（真机必需）
function ensurePrivacy() {
  return new Promise(function (resolve, reject) {
    if (typeof wx.requirePrivacyAuthorize !== 'function') return resolve(true);
    wx.requirePrivacyAuthorize({
      success: function () { resolve(true); },
      fail: function () { reject(new Error('需先在小程序后台配置《用户隐私保护指引》并声明麦克风用途')); }
    });
  });
}

function ensureRecordAuth() {
  return ensurePrivacy().then(function () {
    return new Promise(function (resolve, reject) {
      wx.getSetting({
        success: function (res) {
          var auth = res.authSetting && res.authSetting['scope.record'];
          if (auth === true) return resolve(true);
          if (auth === false) return reject(new Error('麦克风权限被拒绝：点右上角"…"→ 设置 → 打开"麦克风"'));
          wx.authorize({
            scope: 'scope.record',
            success: function () { resolve(true); },
            fail: function () { reject(new Error('需要麦克风权限才能语音记账，请允许"录音"权限')); }
          });
        },
        fail: function () { resolve(true); }
      });
    });
  });
}

function initRecorder() {
  if (recorder || !isAvailable()) return recorder;
  recorder = wx.getRecorderManager();
  recorder.onStart(function () { if (cbs && cbs.onStart) cbs.onStart(); });
  recorder.onStop(function (res) {
    if (cbs && cbs.onStop) cbs.onStop((res && res.tempFilePath) || '', res || {});
  });
  recorder.onError(function (err) {
    if (cbs && cbs.onError) cbs.onError((err && err.errMsg) || '录音失败', err || {});
  });
  return recorder;
}

function startRecord(cb) {
  cbs = cb || {};
  if (!isAvailable()) { if (cb && cb.onError) cb.onError('当前环境不支持录音'); return false; }
  if (!initRecorder()) { if (cb && cb.onError) cb.onError('录音器初始化失败'); return false; }
  try {
    recorder.start(RECORD_OPTIONS);
    return true;
  } catch (e) {
    if (cb && cb.onError) cb.onError('启动录音失败：' + ((e && e.message) || e));
    return false;
  }
}

function stopRecord() {
  if (recorder) {
    try { recorder.stop(); } catch (e) { /* ignore */ }
  }
}

// 录音文件 → 云存储 → 云函数 asr → 文字
function recognize(filePath) {
  return new Promise(function (resolve, reject) {
    if (!filePath) return reject(new Error('没录到声音，请重试'));
    if (typeof wx === 'undefined' || !wx.cloud || !wx.cloud.uploadFile) return reject(new Error('语音识别需要云开发：请先连接云开发（config.js 的 cloudEnv）'));
    var ext = (filePath.split('.').pop() || RECORD_FORMAT).toLowerCase();
    var cloudPath = 'voice/' + Date.now() + '_' + Math.floor(Math.random() * 10000) + '.' + ext;

    wx.cloud.uploadFile({ cloudPath: cloudPath, filePath: filePath })
      .then(function (up) {
        return wx.cloud.callFunction({ name: 'asr', data: { fileID: up.fileID, format: RECORD_FORMAT } });
      })
      .then(function (res) {
        var r = (res && res.result) || {};
        if (!r.ok) throw new Error(r.error || '语音识别失败');
        var text = (r.text || '').replace(/^\s+|\s+$/g, '');
        if (!text) throw new Error('没听清，靠近手机再说一次？');
        resolve(text);
      })
      .catch(function (err) {
        reject(new Error((err && (err.errMsg || err.message)) || '语音识别失败'));
      });
  });
}

// 纯函数：识别文本 → 记账解析（便于单测）
function parseRecognized(text) {
  return engine.parse(text);
}

module.exports = {
  isAvailable: isAvailable,
  getReason: getReason,
  ensureRecordAuth: ensureRecordAuth,
  startRecord: startRecord,
  stopRecord: stopRecord,
  recognize: recognize,
  parseRecognized: parseRecognized,
  FORMAT: RECORD_FORMAT
};