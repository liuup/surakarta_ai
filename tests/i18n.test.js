'use strict';
/*
 * 文案表测试（node tests/i18n.test.js）
 *
 * 双语最容易出的两类问题都在这里拦住：
 *   1. 加了新文案只写了一种语言（键集合不一致）；
 *   2. 占位符写岔了（中文写 {n}、英文写 {count}，替换时就会漏出来）。
 * 另外还检查「英文文案里混进中文」这种复制粘贴事故，以及各个格式化函数。
 */
const assert = require('assert');
const I18N = require('../js/i18n.js');
const R = require('../js/rules.js');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('  通过：' + name);
}

const CODES = I18N.LOCALES.map(l => l.code);
const CJK = /[㐀-䶿一-鿿　-〿＀-￯]/;

/* 允许在英文文案里出现中文的例外：语言切换提示本来就该把两种语言的名字都写出来，
 * 否则中文界面的使用者看着一个纯英文的提示，认不出该按哪个键切回去。 */
const MAY_CONTAIN_CJK = new Set(['tui.help.langKeys']);

/** 取出一段文案里用到的占位符名字，排序后返回 */
function placeholders(text) {
  const names = [];
  String(text).replace(/\{(\w+)\}/g, (whole, name) => { names.push(name); return whole; });
  return names.sort();
}

console.log('文案表测试');

check('默认语言是英文，且提供了中英两种', () => {
  assert.strictEqual(I18N.DEFAULT_LOCALE, 'en', '默认语言应当是英文');
  assert.deepStrictEqual(CODES.sort(), ['en', 'zh']);
  assert.ok(I18N.LOCALES.every(l => l.label && l.label.length > 0), '每种语言都要有可显示的名字');
});

check('两种语言的词条集合完全一致', () => {
  const en = Object.keys(I18N.MESSAGES.en);
  const zh = Object.keys(I18N.MESSAGES.zh);
  const onlyEn = en.filter(k => !zh.includes(k));
  const onlyZh = zh.filter(k => !en.includes(k));
  assert.deepStrictEqual(onlyEn, [], '英文独有（中文漏翻）：' + onlyEn.join(', '));
  assert.deepStrictEqual(onlyZh, [], '中文独有（英文漏翻）：' + onlyZh.join(', '));
  assert.ok(en.length > 100, '词条数量看起来太少了：' + en.length);
  console.log(`      共 ${en.length} 条文案 × ${CODES.length} 种语言`);
});

check('没有空文案', () => {
  for (const code of CODES) {
    for (const [key, text] of Object.entries(I18N.MESSAGES[code])) {
      assert.strictEqual(typeof text, 'string', `${code}/${key} 不是字符串`);
      assert.ok(text.trim().length > 0, `${code}/${key} 是空的`);
    }
  }
});

check('同一条文案在两种语言里的占位符必须一致', () => {
  for (const key of Object.keys(I18N.MESSAGES.en)) {
    const a = placeholders(I18N.MESSAGES.en[key]);
    const b = placeholders(I18N.MESSAGES.zh[key]);
    assert.deepStrictEqual(a, b,
      `「${key}」的占位符不一致：en=[${a}] zh=[${b}]`);
  }
});

check('英文文案里不应混进中文', () => {
  for (const [key, text] of Object.entries(I18N.MESSAGES.en)) {
    if (MAY_CONTAIN_CJK.has(key)) continue;
    assert.ok(!CJK.test(text), `英文词条 ${key} 里混进了中文：${text}`);
  }
});

check('中文文案里不应出现未替换的占位符之外的花括号', () => {
  for (const code of CODES) {
    for (const [key, text] of Object.entries(I18N.MESSAGES[code])) {
      const stripped = text.replace(/\{\w+\}/g, '');
      assert.ok(stripped.indexOf('{') < 0 && stripped.indexOf('}') < 0,
        `${code}/${key} 里有写坏的占位符：${text}`);
    }
  }
});

check('normalize 认识各种写法，不认识就回落到默认语言', () => {
  assert.strictEqual(I18N.normalize('zh'), 'zh');
  assert.strictEqual(I18N.normalize('zh-CN'), 'zh');
  assert.strictEqual(I18N.normalize('ZH_cn'), 'zh');
  assert.strictEqual(I18N.normalize('en-US'), 'en');
  assert.strictEqual(I18N.normalize('fr'), 'en', '不支持的语言应当回落到默认语言');
  assert.strictEqual(I18N.normalize(''), 'en');
  assert.strictEqual(I18N.normalize(null), 'en');
  assert.strictEqual(I18N.normalize(undefined), 'en');
});

check('取词会替换占位符，缺词时逐级回退', () => {
  assert.strictEqual(I18N.t('en', 'side.black'), 'Black');
  assert.strictEqual(I18N.t('zh', 'side.black'), '黑方');
  assert.strictEqual(I18N.t('en', 'judge.blackWins', { a: 7, b: 3 }), 'Black wins 7–3');
  assert.strictEqual(I18N.t('zh', 'judge.blackWins', { a: 7, b: 3 }), '黑方以 7 比 3 获胜');
  // 不认识的词条直接返回词条名，漏翻会一眼看出来而不是显示空白
  assert.strictEqual(I18N.t('en', 'no.such.key'), 'no.such.key');
  // 不认识的语言回退到默认语言
  assert.strictEqual(I18N.t('fr', 'side.black'), 'Black');
});

check('着法渲染：两种语言都对', () => {
  const quiet = { side: 1, from: R.idx(1, 1), to: R.idx(2, 0), capture: false };
  const take = { side: 2, from: R.idx(1, 4), to: R.idx(0, 3), capture: true };
  assert.strictEqual(I18N.formatMove('en', quiet), 'B b2→a3');
  assert.strictEqual(I18N.formatMove('zh', quiet), '黑 b2→a3');
  assert.strictEqual(I18N.formatMove('en', take), 'R e2→d1 captures');
  assert.strictEqual(I18N.formatMove('zh', take), '红 e2→d1 吃子');
  assert.ok(!CJK.test(I18N.formatMove('en', take)), '英文着法里不应有中文');
});

check('终局渲染：四种结束方式、两种语言都对', () => {
  const cases = [
    { kind: 'wipeout', winner: 1, counts: { black: 3, red: 0 } },
    { kind: 'wipeout', winner: 2, counts: { black: 0, red: 5 } },
    { kind: 'agreed', counts: { black: 5, red: 7 }, judge: { winner: 2, black: 5, red: 7 } },
    { kind: 'stalemate', side: 1, counts: { black: 4, red: 9 }, judge: { winner: 2, black: 4, red: 9 } },
    { kind: 'agreed', counts: { black: 6, red: 6 }, judge: { winner: 0, black: 6, red: 6 } }
  ];
  for (const result of cases) {
    for (const code of CODES) {
      const text = I18N.formatResult(code, result);
      assert.ok(text.length > 0, `${code}/${result.kind} 渲染为空`);
      assert.ok(text.indexOf('{') < 0, `${code}/${result.kind} 有没替换掉的占位符：${text}`);
      if (code === 'en') assert.ok(!CJK.test(text), `英文终局里混进了中文：${text}`);
    }
  }
  assert.strictEqual(I18N.formatResult('en', null), '', '对局进行中不应有终局文案');
  console.log('      例：' + I18N.formatResult('en', cases[3]));
  console.log('      例：' + I18N.formatResult('zh', cases[4]));
});

check('档位名与双方名称都有两种语言', () => {
  for (let key = 1; key <= 4; key++) {
    for (const code of CODES) {
      const name = I18N.levelName(code, key);
      assert.ok(name && name !== 'level.' + key, `${code} 缺少第 ${key} 档的名字`);
      if (code === 'en') assert.ok(!CJK.test(name), `第 ${key} 档的英文名里混进了中文：${name}`);
    }
  }
  assert.strictEqual(I18N.levelName('en', 4), 'Master');
  assert.strictEqual(I18N.levelName('zh', 4), '大师');
  assert.strictEqual(I18N.sideName('en', 1), 'Black');
  assert.strictEqual(I18N.sideName('en', 1, true), 'B');
  assert.strictEqual(I18N.sideName('zh', 2), '红方');
  assert.strictEqual(I18N.sideName('zh', 2, true), '红');
});

check('交叉点名称与语言无关', () => {
  assert.strictEqual(I18N.cellName(R.idx(0, 0), 6), 'a1');
  assert.strictEqual(I18N.cellName(R.idx(5, 5), 6), 'f6');
  assert.strictEqual(I18N.cellName(R.idx(2, 3), 6), 'd3');
});

console.log(`全部 ${passed} 项文案表测试通过。`);
