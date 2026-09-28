// 云函数 record：落库 / 查今日 / 删除
// 安全原则：金额与合法性由 engine.validateForSave 在服务端重算校验，绝不轻信客户端传来的 total。
'use strict';

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const engine = require('./engine');

const COLL = 'bills';
let ensured = false;

async function ensureCollection() {
  if (ensured) return;
  try {
    await db.createCollection(COLL);
  } catch (e) {
    // 集合已存在会报错，忽略即可
  }
  ensured = true;
}

// 去掉空值字段（云数据库不允许存 undefined）
function clean(o) {
  const r = {};
  Object.keys(o || {}).forEach(function (k) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== '') r[k] = o[k];
  });
  return r;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event && event.action;
  if (!OPENID) return { ok: false, error: '无法获取用户身份' };

  await ensureCollection();
  const col = db.collection(COLL);

  // 保存一笔（服务端二次校验 + 重算金额）
  if (action === 'save') {
    const v = engine.validateForSave((event && event.item) || {});
    if (!v.ok) return { ok: false, error: v.error };
    const it = v.item;
    const doc = clean(Object.assign({}, it, {
      _openid: OPENID,
      time: engine.timeHM(new Date())
    }));
    const addRes = await col.add({ data: doc });
    return { ok: true, doc: Object.assign({ _id: addRes._id }, doc) };
  }

  // 查某人某天的流水（倒序）
  if (action === 'today') {
    const date = (event && event.date) || engine.todayStr();
    const res = await col.where({ _openid: OPENID, date: date })
      .orderBy('createdAt', 'desc')
      .limit(100)
      .get();
    return { ok: true, list: res.data };
  }

  // 汇总：今日 / 本月 / 累计应收 / 参考毛利（全部由引擎算，口径与客户端一致）
  if (action === 'summary') {
    const date = (event && event.date) || engine.todayStr();
    const res = await col.where({ _openid: OPENID }).orderBy('createdAt', 'desc').limit(1000).get();
    const list = res.data || [];
    const monthFrom = engine.monthStart(date);
    return {
      ok: true,
      date: date,
      monthFrom: monthFrom,
      today: engine.rangeStats(list, date, date),
      month: engine.rangeStats(list, monthFrom, date),
      receivable: engine.receivableTotal(list),
      profitToday: engine.estimateProfit(list, date, date),
      profitMonth: engine.estimateProfit(list, monthFrom, date)
    };
  }

  // 删除（只能删自己的；"可撤销"）
  if (action === 'remove') {
    const id = event && event.id;
    if (!id) return { ok: false, error: '缺少记录 id' };
    const found = await col.where({ _id: id, _openid: OPENID }).get();
    if (!found.data.length) return { ok: false, error: '记录不存在或无权删除' };
    await col.doc(id).remove();
    return { ok: true };
  }

  return { ok: false, error: '未知 action' };
};
