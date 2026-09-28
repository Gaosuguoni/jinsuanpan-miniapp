// 金算盘记账工具首页：按住说话（Plan B：自带录音 + 云函数 ASR）/ 打字 → 引擎解析 → 复述确认 → 落库 → 日结/月结
var engine = require('../../utils/engine');
var store = require('../../utils/store');
var voice = require('../../utils/voice');
var config = require('../../config');

function friendly(err) {
  var m = (err && (err.errMsg || err.message)) || '';
  if (!m) return '未知错误';
  if (m.indexOf('FunctionName') >= 0) return '云函数未部署：右键 cloudfunctions/record（及 asr）→ 上传并部署（云端安装依赖）';
  if (m.indexOf('cloud function') >= 0 || m.indexOf('not found') >= 0 || m.indexOf('不存在') >= 0) return '云函数不存在：请先部署 record / asr';
  if (m.indexOf('env') >= 0 || m.indexOf('Environment') >= 0) return '云开发环境没开通或 config.js 里的 cloudEnv 不对';
  return m;
}

function rowDesc(r) {
  var parts = [];
  if (r.counterparty) parts.push(r.counterparty);
  if (r.name) {
    var s = r.name;
    if (r.qty != null) {
      s += ' ' + r.qty + (r.unit || '');
      if (r.price != null) s += ' ×' + engine.money(r.price);
    }
    parts.push(s);
  }
  if (r.note && r.type === 'expense') parts.push(r.note);
  if (!parts.length) parts.push(r.typeLabel);
  return parts.join(' ');
}

function toRow(r) {
  return {
    _id: r._id || r.id || '',
    type: r.type,
    typeLabel: r.typeLabel,
    desc: rowDesc(r),
    time: engine.timeHM(new Date(r.createdAt || Date.now())),
    total: engine.money(r.total)
  };
}

function fmtSummary(s) {
  s = s || {};
  return {
    count: s.count || 0,
    sell: engine.money(s.sell || 0),
    buy: engine.money(s.buy || 0),
    credit: engine.money(s.credit || 0),
    collect: engine.money(s.collect || 0),
    expense: engine.money(s.expense || 0),
    loss: engine.money(s.loss || 0)
  };
}

function fmtPeriod(s, p) {
  s = s || {};
  p = p || {};
  return {
    count: s.count || 0,
    turnover: engine.money(s.turnover || 0),
    cashIn: engine.money(s.cashIn || 0),
    cashOut: engine.money(s.cashOut || 0),
    netCash: engine.money(s.netCash || 0),
    profit: engine.money(p.profit || 0),
    uncovered: p.uncovered || 0
  };
}

Page({
  data: {
    mode: 'loading',
    cloudError: '',
    today: '',
    input: '',
    examples: [],
    preview: null,
    errMsg: '',
    list: [],
    sum: { count: 0 },
    saving: false,
    cloudConfigured: false,
    voiceAvailable: false,
    voiceReason: '',
    recording: false,
    recognizing: false,
    voiceError: '',
    // P2 日结/月结
    todayStats: {},
    monthStats: {},
    receivable: '0',
    profitNote: ''
  },

  onLoad: function () {
    this.setData({
      examples: engine.EXAMPLES,
      today: engine.todayStr(),
      cloudConfigured: !!config.cloudEnv
    });
    this.startup();
  },

  // 把 summary 结果转成展示用字符串
  applySummary: function (res) {
    if (!res || !res.ok) return;
    var t = res.today || {};
    var m = res.month || {};
    var pt = res.profitToday || {};
    var pm = res.profitMonth || {};
    var notes = [];
    if (pt.uncovered > 0) notes.push('今日有 ' + pt.uncovered + ' 笔卖货未匹配到进价');
    if (pm.uncovered > 0) notes.push('本月有 ' + pm.uncovered + ' 笔卖货未匹配到进价');
    this.setData({
      todayStats: fmtPeriod(t, pt),
      monthStats: fmtPeriod(m, pm),
      receivable: engine.money(res.receivable || 0),
      profitNote: notes.length ? notes.join('；') + '，毛利仅供参考。' : ''
    });
  },

  startup: function () {
    var self = this;
    var app = getApp();
    var wantCloud = app.getCloudOK ? app.getCloudOK() : false;
    var voiceOk = wantCloud && voice.isAvailable();
    var today = engine.todayStr();

    if (wantCloud) {
      store.cloudToday(today).then(function (list) {
        self.setData({
          mode: 'cloud', cloudError: '',
          list: list.map(toRow), sum: fmtSummary(engine.summarize(list)),
          voiceAvailable: voiceOk, voiceReason: voiceOk ? '' : voice.getReason()
        });
        // 汇总失败不影响流水展示
        return store.cloudSummary(today).catch(function () { return null; });
      }).then(function (res) {
        if (res) self.applySummary(res);
      }).catch(function (err) {
        self.setData({
          mode: 'cloud', cloudError: friendly(err), list: [], sum: fmtSummary(),
          voiceAvailable: false, voiceReason: '云开发暂时连不上，语音识别用不了；可先用打字记账'
        });
      });
    } else {
      var list = store.demoToday(today);
      self.setData({
        mode: 'demo', cloudError: '',
        list: list.map(toRow), sum: fmtSummary(engine.summarize(list)),
        voiceAvailable: false,
        voiceReason: '语音识别走云端（腾讯云 ASR）：请先在 config.js 填好 cloudEnv 并连接云开发'
      });
      store.demoSummary(today).then(function (res) { self.applySummary(res); });
    }
  },

  /* ---------- 语音入口（Plan B） ---------- */

  onRecordStart: function () {
    var self = this;
    if (this.data.recording || this.data.recognizing) return;
    if (!this.data.voiceAvailable) {
      wx.showToast({ title: this.data.voiceReason || '语音暂不可用，可先用打字', icon: 'none', duration: 2600 });
      return;
    }
    voice.ensureRecordAuth().then(function () {
      self.setData({ recording: true, recognizing: false, voiceError: '' });
      voice.startRecord({
        onStart: function () { self.setData({ recording: true }); },
        onStop: function (tempFilePath) {
          self.setData({ recording: false, recognizing: true });
          if (!tempFilePath) {
            self.setData({ recognizing: false, voiceError: '没录到声音，请重试' });
            return;
          }
          voice.recognize(tempFilePath).then(function (text) {
            self.setData({ recognizing: false, input: text });
            self.doParse(text);
          }).catch(function (err) {
            var msg = (err && err.message) || '语音识别失败';
            self.setData({ recognizing: false, voiceError: msg });
            wx.showToast({ title: msg, icon: 'none', duration: 2600 });
          });
        },
        onError: function (msg) {
          self.setData({ recording: false, recognizing: false, voiceError: msg });
          wx.showToast({ title: msg, icon: 'none', duration: 2600 });
        }
      });
    }).catch(function (err) {
      wx.showToast({ title: (err && err.message) || '需要麦克风权限', icon: 'none', duration: 2600 });
    });
  },

  onRecordEnd: function () {
    if (this.data.recording) voice.stopRecord();
  },

  /* ---------- 打字入口 ---------- */

  onInput: function (e) { this.setData({ input: e.detail.value }); },

  tapExample: function (e) {
    var t = e.currentTarget.dataset.txt;
    this.setData({ input: t });
    this.doParse(t);
  },

  onParse: function () { this.doParse(this.data.input); },

  doParse: function (text) {
    // 含分隔符/连接词 → 按"多笔"解析（忙时一口气说多笔）
    var isMulti = /[，,、；;。\n]|然后|还有|另外/.test(text || '');
    if (isMulti) {
      var m = engine.parseMany(text);
      if (!m.ok) {
        this.setData({ preview: null, errMsg: m.error + (m.hint ? '\n提示：' + m.hint : '') });
        return m;
      }
      if (m.count === 1) {
        this.setData({ preview: { item: m.items[0], sentence: m.sentences[0] }, errMsg: '' });
        return m;
      }
      var note = '';
      if (m.errors && m.errors.length) {
        var segs = m.errors.map(function (e) { return e.text; }).join(' / ');
        note = '有 ' + m.errors.length + ' 句没听懂：' + segs + '（可先记听懂的部分，稍后补记）';
      }
      this.setData({
        preview: { multi: true, items: m.items, sentences: m.sentences, count: m.count, total: engine.money(m.total) },
        errMsg: note
      });
      return m;
    }
    var r = engine.parse(text);
    if (!r.ok) {
      this.setData({ preview: null, errMsg: (r.error || '没听懂') + (r.hint ? '\n提示：' + r.hint : '') });
      return r;
    }
    this.setData({ preview: { item: r.item, sentence: r.sentence }, errMsg: '' });
    return r;
  },

  cancelPreview: function () { this.setData({ preview: null }); },

  confirmSave: function () {
    var pv = this.data.preview;
    if (!pv) return;
    var self = this;
    var useCloud = getApp().getCloudOK();
    this.setData({ saving: true });

    // 多笔：逐笔落库（中途失败会报告已记几笔）
    if (pv.multi) {
      var items = pv.items || [];
      var i = 0;
      var total = items.length;
      var step = function () {
        if (i >= total) {
          self.setData({ input: '', preview: null, errMsg: '', saving: false });
          wx.showToast({ title: '已记好 ' + total + ' 笔 ✓', icon: 'none' });
          self.startup();
          return;
        }
        var p = useCloud ? store.cloudSave(items[i]) : store.demoSave(items[i]);
        p.then(function () {
          i++;
          step();
        }).catch(function (err) {
          self.setData({ saving: false, errMsg: '已记 ' + i + ' 笔，第 ' + (i + 1) + ' 笔失败：' + friendly(err) });
        });
      };
      step();
      return;
    }

    var p2 = useCloud ? store.cloudSave(pv.item) : store.demoSave(pv.item);
    p2.then(function () {
      self.setData({ input: '', preview: null, errMsg: '' });
      wx.showToast({ title: '已记好 ✓', icon: 'none' });
      self.startup();
    }).catch(function (err) {
      wx.showToast({ title: '保存失败：' + friendly(err), icon: 'none', duration: 2500 });
    }).then(function () {
      self.setData({ saving: false });
    });
  },

  onDelete: function (e) {
    var id = e.currentTarget.dataset.id;
    if (!id) return;
    var self = this;
    wx.showModal({
      title: '撤销这笔？',
      content: '撤销后会从今日流水里删除。',
      confirmText: '撤销',
      confirmColor: '#c0392b',
      success: function (res) {
        if (!res.confirm) return;
        var app = getApp();
        var p = app.getCloudOK() ? store.cloudRemove(id) : store.demoRemove(id);
        p.then(function () {
          wx.showToast({ title: '已撤销', icon: 'none' });
          self.startup();
        }).catch(function (err) {
          wx.showToast({ title: '撤销失败：' + friendly(err), icon: 'none' });
        });
      }
    });
  },

  /* ---------- 模式 ---------- */

  switchCloud: function () {
    var app = getApp();
    wx.removeStorageSync('vp_force_demo');
    if (app.initCloud) app.initCloud();
    wx.showToast({ title: '正在连接云开发…', icon: 'none' });
    this.startup();
  },

  switchDemo: function () {
    wx.setStorageSync('vp_force_demo', 1);
    wx.showToast({ title: '已切到本地演示', icon: 'none' });
    this.startup();
  },

  clearDemo: function () {
    var self = this;
    wx.showModal({
      title: '清空演示数据？',
      content: '只清空本机演示数据，不影响云端。',
      success: function (res) {
        if (!res.confirm) return;
        store.demoClear().then(function () { self.startup(); });
      }
    });
  }
});
