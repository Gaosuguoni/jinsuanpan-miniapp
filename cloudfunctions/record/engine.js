'use strict';

/**
 * 商贩语音记账 · 确定性记账引擎 (P0 v4)
 * ---------------------------------------------------------------
 * 原则：钱与货永远由这套确定性代码计算，模型/用户只负责"填字段"。
 * 本文件为纯 JS、零依赖、CommonJS，小程序端与云函数端各放一份副本，
 * 两份内容必须保持完全一致（由 Codex 统一生成/更新）。
 *
 * 支持语料（P0 版，数量请用阿拉伯数字）：
 *   进苹果 50 斤 3.2 一斤       → 进货 苹果 50斤 × 3.2 = 160
 *   进了50斤苹果 3块2一斤        → 进货 苹果 50斤 × 3.2 = 160
 *   卖苹果 20 斤 5 一斤          → 卖货 苹果 20斤 × 5 = 100
 *   张三赊了苹果 10 斤 4 一斤     → 赊账 张三 苹果 10斤 × 4 = 40
 *   赊账 李四 猪肉 5 斤 12 一斤   → 赊账 李四 猪肉 5斤 × 12 = 60
 *   收到张三 64 / 张三还钱 64     → 收款 张三 64
 *   支出 买塑料袋 5 块            → 支出（买塑料袋）5
 *   损耗 苹果 2 斤 3.2 一斤       → 损耗 苹果 2斤 × 3.2 ≈ 6.4
 * ---------------------------------------------------------------
 */

var UNITS = ['公斤','千克','毫升','升','箱','件','个','袋','包','瓶','只','条','份','捆','把','筐','盒','桶','提','板','排','双','对','套','顶','台','张','本','支','颗','棵','头','根','串','扎','打','斤'];

var TYPE_META = {
  buy:     { label: '进货' },
  sell:    { label: '卖货' },
  credit:  { label: '赊账' },
  collect: { label: '收款' },
  expense: { label: '支出' },
  loss:    { label: '损耗' }
};

var EXAMPLES = [
  '进苹果 50 斤 3.2 一斤',
  '卖苹果 20 斤 5 一斤',
  '张三赊了苹果 10 斤 4 一斤',
  '收到张三 64',
  '支出 买塑料袋 5 块',
  '损耗 苹果 2 斤 3.2 一斤'
];

var NEED_QTY_PRICE = { buy: 1, sell: 1, credit: 1 };
var NAME_TYPES = { buy: 1, sell: 1, credit: 1, loss: 1 };

/* ---------- 基础工具 ---------- */

function trim(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }

function pad2(n) { return n < 10 ? '0' + n : '' + n; }

/** 今天日期 YYYY-MM-DD（本地时区，MVP 可接受） */
function todayStr(d) {
  var t = d || new Date();
  return t.getFullYear() + '-' + pad2(t.getMonth() + 1) + '-' + pad2(t.getDate());
}

function timeHM(d) {
  var t = d || new Date();
  return pad2(t.getHours()) + ':' + pad2(t.getMinutes());
}

function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function money(n) { return String(round2(n)); }

function buildUnitRe() {
  var sorted = UNITS.slice().sort(function (a, b) { return b.length - a.length; });
  return new RegExp('(' + sorted.join('|') + ')');
}
var UNIT_RE = buildUnitRe();

function removeSpan(text, start, end) {
  return text.slice(0, start) + ' ' + text.slice(end);
}

/* ---------- 金额扫描 ---------- */

/** 文本里最后一个金额数字（纯数字与"块/毛/分"都认）；找不到返回 null */
function lastMoney(text) {
  var t = String(text);
  var found = null;
  var spans = [];
  var re1 = /(\d+(?:\.\d+)?)\s*块\s*(?:(\d+)\s*毛)?\s*(?:(\d+)\s*分)?/g;
  var mm;
  while ((mm = re1.exec(t)) !== null) {
    var v = parseFloat(mm[1]);
    if (mm[2]) v += parseInt(mm[2], 10) * 0.1;
    if (mm[3]) v += parseInt(mm[3], 10) * 0.01;
    found = round2(v);
    spans.push({ start: mm.index, end: mm.index + mm[0].length });
  }
  var re2 = /(\d+(?:\.\d+)?)\s*(?:元|块钱)?/g;
  var mm2;
  while ((mm2 = re2.exec(t)) !== null) {
    var overlap = false;
    for (var i = 0; i < spans.length; i++) {
      if (mm2.index < spans[i].end && mm2.index + mm2[0].length > spans[i].start) { overlap = true; break; }
    }
    if (!overlap) found = parseFloat(mm2[1]);
  }
  return found;
}

/** 显式"一共/总共/合计 XXX" */
function explicitTotalClause(text) {
  var m = text.match(/(?:一共|总共|合计)\s*(\d+(?:\.\d+)?)\s*(?:块|元|块钱)?/);
  if (!m) return null;
  return { total: parseFloat(m[1]), start: m.index, end: m.index + m[0].length };
}

/** 数量：第一个"数字+单位"（50斤 / 3.5公斤） */
function extractQty(text) {
  var re = new RegExp('(\\d+(?:\\.\\d+)?)\\s*' + UNIT_RE.source, 'g');
  var m = re.exec(text);
  if (!m) return null;
  return { qty: parseFloat(m[1]), unit: m[2], start: m.index, end: m.index + m[0].length };
}

/** 块毛分数字（3块2、3块2毛5、12块5）→ 数字 */
function kuaiToNum(m) {
  var v = parseFloat(m[1]);
  if (m[2]) v += parseInt(m[2], 10) * 0.1;
  if (m[3]) v += parseInt(m[3], 10) * 0.01;
  else if (m[4]) v += parseInt(m[4], 10) * 0.01;
  else if (m[5]) {
    var b = parseInt(m[5], 10);
    v += String(b).length === 1 ? b * 0.1 : b * 0.01;
  }
  return round2(v);
}

var K = '(\\d+(?:\\.\\d+)?)';
var MAO = '(?:(\\d{1,2})\\s*毛\\s*(?:(\\d{1,2})\\s*分)?|(\\d{1,2})\\s*分|(\\d{1,2}))?';

/** 单价提取；返回 {price, unit, start, end} 或 null（start/end 用于从原文剔除，避免污染品名） */
function extractUnitPrice(text) {
  var t = String(text);

  // 1) 块形式：3块2一斤 / 3块2 / 每斤3块2 / 3块2毛5
  var re1 = new RegExp('(?:每)?' + K + '\\s*块' + MAO + '\\s*(?:元)?\\s*(?:[\\/每])?\\s*(?:一)?(' + UNIT_RE.source + ')?');
  var m1 = t.match(re1);
  if (m1) {
    return { price: kuaiToNum(m1), unit: m1[6] || null, start: m1.index, end: m1.index + m1[0].length };
  }

  // 2) 小数+单位：3.2元一斤 / 3.2一斤 / 3.2/斤 / 每斤3.2元 / 一斤3.2
  var m2 = t.match(new RegExp(K + '\\s*元?\\s*(?:[\\/每])?\\s*(?:一)?(' + UNIT_RE.source + ')'));
  if (m2) {
    return { price: parseFloat(m2[1]), unit: m2[2], start: m2.index, end: m2.index + m2[0].length };
  }
  var m3 = t.match(new RegExp('(?:每|一)(' + UNIT_RE.source + ')\\s*' + K + '\\s*元?'));
  if (m3) {
    return { price: parseFloat(m3[2]), unit: m3[1], start: m3.index, end: m3.index + m3[0].length };
  }

  // 3) 只剩一个孤立数字 → 当作单价（进苹果50斤 3.2）
  var nums = [];
  var reN = /(\d+(?:\.\d+)?)/g;
  var mm;
  while ((mm = reN.exec(t)) !== null) {
    nums.push({ v: parseFloat(mm[1]), start: mm.index, end: mm.index + mm[0].length });
  }
  if (nums.length === 1) {
    return { price: nums[0].v, unit: null, start: nums[0].start, end: nums[0].end };
  }
  return null;
}

/* ---------- 类型识别 ---------- */

var TYPE_RULES = [
  { key: 'credit',  re: /(赊账|赊给|赊了|赊|欠账|先欠|挂账)/ },
  { key: 'collect', re: /(收款|收到|还钱|还款|收回|到账|结清)/ },
  { key: 'loss',    re: /(损耗|坏掉|坏了|烂了|扔了|扔掉|报废|丢掉)/ },
  { key: 'expense', re: /(支出|花费|花销|花了|开销|付了|缴费|房租|水电费)/ },
  { key: 'sell',    re: /(卖出|卖了|卖货|销售|售出|卖掉|卖)/ },
  { key: 'buy',     re: /(进货|进了|进|采购|补货|买进|上货|买了|买)/ }
];

function detectType(text) {
  for (var i = 0; i < TYPE_RULES.length; i++) {
    var m = text.match(TYPE_RULES[i].re);
    if (m) return { key: TYPE_RULES[i].key, keyword: m[0] };
  }
  return null;
}

/* ---------- 客户名（赊账/收款） ---------- */

/**
 * @param typeKey 类型
 * @param raw     原始文本（credit 用它，因为需要"赊"动词做锚点）
 * @param rest    去掉类型关键词后的文本（collect 用它，避免把"收款"的"款"当人名）
 */
function extractCounterparty(typeKey, raw, rest) {
  if (typeKey === 'credit') {
    // 张三赊了…（名字在动词前）
    var m1 = raw.match(/^([\u4e00-\u9fa5A-Za-z]{1,6}?)\s*(?:赊账|赊给|赊了|赊|欠账|先欠|挂账)/);
    if (m1 && m1[1]) return m1[1];
    // 赊给李四…
    var m2 = raw.match(/(?:赊给)\s*([\u4e00-\u9fa5A-Za-z]{1,6})/);
    if (m2 && m2[1]) return m2[1];
    // 赊账 李四 猪肉 5 斤…（客户后还跟着货品+数量，才认为第一个是客户）
    var m3 = raw.match(/(?:赊账|赊了)\s+([\u4e00-\u9fa5A-Za-z]{1,6}?)\s+([\u4e00-\u9fa5A-Za-z]{1,10})(?=\s*\d)/);
    if (m3 && m3[1]) return m3[1];
    return null;
  }
  if (typeKey === 'collect') {
    // 收款/收到/还钱 等关键词已去掉：取剩下文本开头的第一段中文当人名
    var m = trim(rest).match(/^([\u4e00-\u9fa5A-Za-z]{1,6})/);
    if (m && m[1]) return m[1];
    return null;
  }
  return null;
}

/* ---------- 主解析 ---------- */

function parse(text) {
  var raw = trim(text);
  if (raw === '') return { ok: false, error: '还没有输入内容', hint: '示例：' + EXAMPLES.join('；') };

  var type = detectType(raw);
  if (!type) {
    return { ok: false, error: '没认出这是「进货/卖货/赊账/收款/支出/损耗」里的哪一种', hint: '示例：' + EXAMPLES.join('；') };
  }

  var item = {
    type: type.key,
    typeLabel: TYPE_META[type.key].label,
    name: null,
    qty: null,
    unit: null,
    price: null,
    total: null,
    counterparty: null,
    note: null,
    raw: raw,
    createdAt: new Date().toISOString(),
    date: todayStr()
  };

  // 去掉类型关键词（第一次出现）
  var idx = raw.indexOf(type.keyword);
  var rest = idx >= 0 ? removeSpan(raw, idx, idx + type.keyword.length) : raw;

  // 客户名
  item.counterparty = extractCounterparty(type.key, raw, rest);
  if (item.counterparty) {
    var ci = rest.indexOf(item.counterparty);
    if (ci >= 0) rest = removeSpan(rest, ci, ci + item.counterparty.length);
  }

  // 显式总额
  var ec = explicitTotalClause(rest);
  if (ec) { item.total = ec.total; rest = removeSpan(rest, ec.start, ec.end); }

  // 数量
  var q = extractQty(rest);
  if (q) {
    item.qty = q.qty; item.unit = q.unit;
    rest = removeSpan(rest, q.start, q.end);
  }

  // 单价（只对可能"数量×单价"的类型去猜；损耗只有带数量时才猜）
  var priceType = (item.type === 'buy' || item.type === 'sell' || item.type === 'credit' || (item.type === 'loss' && q));
  if (priceType) {
    var up = extractUnitPrice(rest);
    if (up && up.price != null) {
      item.price = up.price;
      if (up.unit && !item.unit) item.unit = up.unit;
      rest = removeSpan(rest, up.start, up.end);
    }
  }

  // 品名：单价片段已剔除，取剩余第一段中文
  var name = null;
  var nameRe = rest.match(/([\u4e00-\u9fa5]{1,10})/);
  if (nameRe) name = nameRe[1];
  if (name === '元' || name === '块钱' || name === '块') name = null;

  // 金额：永远由引擎算
  if (item.qty != null && item.price != null) {
    item.total = round2(item.qty * item.price);
  }
  if (item.total == null) {
    var amountOnly = !NEED_QTY_PRICE[item.type] || item.qty == null;
    if (amountOnly) {
      var lm = lastMoney(raw);
      if (lm != null) item.total = lm;
    }
  }
  if (item.total == null) {
    return {
      ok: false,
      error: '没算出来金额：请说清「数量×单价」（如 50 斤 3.2 一斤），或直接说总金额（如 一共 160）',
      hint: '示例：' + EXAMPLES.join('；'),
      partial: item
    };
  }
  if (!(item.total > 0)) {
    return { ok: false, error: '金额要大于 0，再试一次？', hint: '示例：' + EXAMPLES.join('；') };
  }

  // 字段补充与校验
  if (name && NAME_TYPES[item.type]) item.name = name;
  if (item.type === 'expense') {
    var note = raw.replace(/(支出|花费|花销|花了|开销|付了|缴费|房租|水电费)/, ' ')
                  .replace(/\d+(?:\.\d+)?\s*(?:块|元|块钱)?/g, ' ')
                  .replace(/\s+/g, ' ');
    item.note = trim(note) || '支出';
  }
  if (item.type === 'collect' && !item.counterparty) item.note = '收款';
  if (item.type === 'credit' && !item.counterparty) {
    return { ok: false, error: '赊账要说是赊给谁（如：张三赊了苹果 10 斤 4 一斤）', hint: '示例：张三赊了苹果 10 斤 4 一斤' };
  }
  if ((item.type === 'buy' || item.type === 'sell') && !item.name) {
    return { ok: false, error: '没听清是什么货/东西', hint: '示例：进苹果 50 斤 3.2 一斤' };
  }

  return { ok: true, item: item, sentence: buildSentence(item) };
}

/* ---------- 复述确认句 ---------- */

function buildSentence(it) {
  var L = TYPE_META[it.type].label;
  var who = it.counterparty ? ' ' + it.counterparty : '';
  var totalTxt = money(it.total);
  var s;
  if (it.qty != null && it.price != null) {
    var nm = it.name ? it.name + ' ' : '';
    s = '记：' + L + who + ' ' + nm + it.qty + (it.unit || '') + ' × ' + money(it.price) + ' = ' + totalTxt + ' 元';
  } else {
    var desc = it.name || it.note || '';
    s = '记：' + L + who + (desc ? ' ' + desc + '，' : '，') + totalTxt + ' 元';
  }
  if (it.type === 'credit') s += '（赊账未收款）';
  s += '，对吗？';
  return s;
}

/* ---------- 服务端二次校验 + 重算（云函数落库前必调） ---------- */

function validateForSave(input) {
  var t = (input && input.type) || '';
  if (!TYPE_META[t]) return { ok: false, error: '类型不合法' };
  var it = {
    type: t,
    typeLabel: TYPE_META[t].label,
    name: input.name || null,
    qty: input.qty != null ? Number(input.qty) : null,
    unit: input.unit || null,
    price: input.price != null ? Number(input.price) : null,
    total: null,
    counterparty: input.counterparty || null,
    note: input.note || null,
    raw: input.raw || '',
    createdAt: input.createdAt || new Date().toISOString(),
    date: input.date || todayStr()
  };
  if (it.qty != null && (!isFinite(it.qty) || it.qty <= 0)) return { ok: false, error: '数量不合法' };
  if (it.price != null && (!isFinite(it.price) || it.price <= 0)) return { ok: false, error: '单价不合法' };

  if (it.qty != null && it.price != null) {
    it.total = round2(it.qty * it.price);
  } else {
    var ext = Number(input.total);
    if (isFinite(ext) && ext > 0) it.total = round2(ext);
    else return { ok: false, error: '金额缺失或不合法' };
  }
  if (!(it.total > 0)) return { ok: false, error: '金额必须大于 0' };

  if ((t === 'buy' || t === 'sell') && !it.name) return { ok: false, error: '缺少货品信息' };
  if (t === 'credit' && !it.counterparty) return { ok: false, error: '缺少客户信息' };
  return { ok: true, item: it };
}

/* ---------- 汇总 ---------- */

function summarize(list) {
  var s = { count: 0, buy: 0, sell: 0, credit: 0, collect: 0, expense: 0, loss: 0, byType: {} };
  (list || []).forEach(function (r) {
    var v = Number(r.total) || 0;
    s.count += 1;
    if (!s.byType[r.type]) s.byType[r.type] = 0;
    s.byType[r.type] = round2(s.byType[r.type] + v);
  });
  s.buy = s.byType.buy || 0;
  s.sell = s.byType.sell || 0;
  s.credit = s.byType.credit || 0;
  s.collect = s.byType.collect || 0;
  s.expense = s.byType.expense || 0;
  s.loss = s.byType.loss || 0;
  return s;
}

/* ---------- 统计：日结 / 月结 / 应收 / 参考毛利（P2） ---------- */

function inRange(r, from, to) {
  var d = (r && r.date) || '';
  return d >= from && d <= to;
}

function filterRange(list, from, to) {
  return (list || []).filter(function (r) { return inRange(r, from, to); });
}

function monthStart(dateStr) {
  var s = dateStr || todayStr();
  return s.slice(0, 7) + '-01';
}

/** 期间统计（现金口径，数字全部由引擎算） */
function rangeStats(list, from, to) {
  var rows = filterRange(list, from, to);
  var s = { count: rows.length, buy: 0, sell: 0, credit: 0, collect: 0, expense: 0, loss: 0, turnover: 0, cashIn: 0, cashOut: 0, netCash: 0 };
  rows.forEach(function (r) {
    if (s[r.type] === undefined) return;
    s[r.type] = round2(s[r.type] + (Number(r.total) || 0));
  });
  s.turnover = round2(s.sell + s.credit);       // 营业额：卖货 + 赊账（生意做了多少）
  s.cashIn = round2(s.sell + s.collect);        // 现金收入：卖货收款 + 收回欠款
  s.cashOut = round2(s.buy + s.expense);        // 现金支出：进货 + 其他支出
  s.netCash = round2(s.cashIn - s.cashOut);     // 净现金
  return s;
}

/** 累计应收（赊账 − 收款），全量数据 */
function receivableTotal(list) {
  var credit = 0;
  var collect = 0;
  (list || []).forEach(function (r) {
    if (r.type === 'credit') credit += Number(r.total) || 0;
    if (r.type === 'collect') collect += Number(r.total) || 0;
  });
  return round2(credit - collect);
}

/**
 * 参考毛利（最近进价法）：
 *   期间卖出收入（卖货+赊账） − 按"该笔卖出之前、同品名最近一次进价"估算的销售成本 − 期间损耗
 * 说明：进价波动时这是估算值；uncovered 表示有几笔没匹配到进价（此时毛利会偏高，UI 需提示）。
 */
function estimateProfit(list, from, to) {
  var all = (list || []).slice().sort(function (a, b) {
    return String(a.createdAt || '') < String(b.createdAt || '') ? -1 : 1;
  });
  var buysByName = {};
  all.forEach(function (r) {
    if (r.type === 'buy' && r.name && r.price != null) {
      if (!buysByName[r.name]) buysByName[r.name] = [];
      buysByName[r.name].push(r);
    }
  });
  var rows = filterRange(all, from, to);
  var revenue = 0, cost = 0, loss = 0, covered = 0, uncovered = 0;
  rows.forEach(function (r) {
    var v = Number(r.total) || 0;
    if (r.type === 'sell' || r.type === 'credit') {
      revenue += v;
      var hist = buysByName[r.name] || [];
      var basis = null;
      for (var i = hist.length - 1; i >= 0; i--) {
        if (String(hist[i].createdAt || '') <= String(r.createdAt || '')) { basis = hist[i]; break; }
      }
      if (basis && basis.price != null && r.qty != null) {
        cost += Number(r.qty) * Number(basis.price);
        covered++;
      } else {
        uncovered++;
      }
    }
    if (r.type === 'loss') loss += v;
  });
  return {
    revenue: round2(revenue),
    cost: round2(cost),
    loss: round2(loss),
    profit: round2(revenue - cost - loss),
    covered: covered,
    uncovered: uncovered,
    basis: '最近进价'
  };
}

/* ---------- 一句话多笔（忙时连续说，P2 忙时三件套） ---------- */

var TYPE_KEYWORD = { buy: '进', sell: '卖', credit: '赊账', collect: '收款', expense: '支出', loss: '损耗' };
var SPLIT_RE = /\s*(?:[，,、；;。\n]+|然后|还有|另外|再有|再者)\s*/;

/**
 * 把一段话拆成多笔：
 *   "卖白菜20斤3块、卖苹果10斤5块、张三赊了苹果10斤4块" → 3 笔
 *   "卖白菜20斤3块、苹果10斤5块" → 第二句没类型词时，继承上一句类型（卖货）
 * 返回 { ok, items, sentences, errors, count, total }；部分失败时 items 仍有值，errors 记录哪句没听懂。
 */
function parseMany(text) {
  var raw = trim(text);
  if (raw === '') return { ok: false, error: '还没有输入内容', hint: '示例：' + EXAMPLES.join('；') };
  var parts = raw.split(SPLIT_RE);
  var items = [], sentences = [], errors = [], lastType = null;
  for (var i = 0; i < parts.length; i++) {
    var seg = trim(parts[i]);
    if (seg === '') continue;
    var r = parse(seg);
    if (!r.ok && lastType) {
      var carried = parse(TYPE_KEYWORD[lastType] + ' ' + seg);
      if (carried.ok) r = carried;
    }
    if (r.ok) {
      items.push(r.item);
      sentences.push(r.sentence);
      lastType = r.item.type;
    } else {
      errors.push({ index: i, text: seg, error: r.error || '没听懂' });
    }
  }
  if (!items.length) {
    return { ok: false, error: errors.length ? errors[0].error : '没听懂', hint: '示例：' + EXAMPLES.join('；'), errors: errors };
  }
  var total = 0;
  items.forEach(function (it) { total += Number(it.total) || 0; });
  return { ok: true, items: items, sentences: sentences, errors: errors, count: items.length, total: round2(total) };
}
module.exports = {
  parse: parse,
  parseMany: parseMany,
  TYPE_KEYWORD: TYPE_KEYWORD,
  validateForSave: validateForSave,
  buildSentence: buildSentence,
  summarize: summarize,
  rangeStats: rangeStats,
  receivableTotal: receivableTotal,
  estimateProfit: estimateProfit,
  monthStart: monthStart,
  inRange: inRange,
  todayStr: todayStr,
  timeHM: timeHM,
  money: money,
  TYPES: TYPE_META,
  EXAMPLES: EXAMPLES,
  lastMoney: lastMoney
};
