// 数据访问层：云开发 or 本地演示（wx storage）。页面不直接碰数据库。
var engine = require('./engine');

var DEMO_KEY = 'vp_bills_demo';

function genId() {
  return 'local_' + Date.now() + '_' + Math.floor(Math.random() * 100000);
}

function demoAll() {
  return wx.getStorageSync(DEMO_KEY) || [];
}

function demoToday(date) {
  return demoAll().filter(function (r) { return r.date === date; })
    .sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
}

function demoSave(item) {
  var rec = Object.assign({}, item, { _id: genId(), time: engine.timeHM(new Date()) });
  var all = demoAll();
  all.push(rec);
  wx.setStorageSync(DEMO_KEY, all);
  return Promise.resolve({ ok: true, doc: rec });
}

function demoRemove(id) {
  wx.setStorageSync(DEMO_KEY, demoAll().filter(function (r) { return r._id !== id; }));
  return Promise.resolve({ ok: true });
}

function demoClear() {
  wx.setStorageSync(DEMO_KEY, []);
  return Promise.resolve({ ok: true });
}

function cloudCall(data) {
  return wx.cloud.callFunction({ name: 'record', data: data }).then(function (res) {
    var r = res && res.result ? res.result : {};
    if (!r.ok) {
      var e = new Error(r.error || '云函数返回异常');
      e.biz = true;
      throw e;
    }
    return r;
  });
}

function cloudSave(item) {
  return cloudCall({ action: 'save', item: item }).then(function (r) { return r; });
}

function cloudToday(date) {
  return cloudCall({ action: 'today', date: date }).then(function (r) { return r.list || []; });
}

function cloudRemove(id) {
  return cloudCall({ action: 'remove', id: id });
}

// P2 汇总：今日/本月/应收/参考毛利（本地模式与云端同源，都用 engine 计算）
function demoSummary(date) {
  var list = demoAll();
  var monthFrom = engine.monthStart(date);
  return Promise.resolve({
    ok: true,
    date: date,
    monthFrom: monthFrom,
    today: engine.rangeStats(list, date, date),
    month: engine.rangeStats(list, monthFrom, date),
    receivable: engine.receivableTotal(list),
    profitToday: engine.estimateProfit(list, date, date),
    profitMonth: engine.estimateProfit(list, monthFrom, date)
  });
}

function cloudSummary(date) {
  return cloudCall({ action: 'summary', date: date });
}

module.exports = {
  demoSave: demoSave,
  demoToday: demoToday,
  demoRemove: demoRemove,
  demoClear: demoClear,
  demoAll: demoAll,
  cloudSave: cloudSave,
  cloudToday: cloudToday,
  cloudRemove: cloudRemove,
  cloudSummary: cloudSummary,
  demoSummary: demoSummary,
  cloudCall: cloudCall
};
