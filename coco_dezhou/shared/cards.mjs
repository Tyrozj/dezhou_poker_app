/**
 * 共享牌型引擎：服务端（权威裁决）与手机端（本地提示）使用同一份代码。
 * 牌用两字符字符串表示：点数 + 花色，例如 "As" "Th" "2c"。
 *   点数 2-9 T J Q K A      花色 s(黑桃) h(红心) d(方块) c(梅花)
 * 纯 ESM、无任何平台 API，可直接被浏览器 import。
 */

export const SUITS = ['s', 'h', 'd', 'c'];
export const RANK_CHARS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

export const RANK_VALUE = {
  2: 2, 3: 3, 4: 4, 5: 5, 6: 6, 7: 7, 8: 8, 9: 9,
  T: 10, J: 11, Q: 12, K: 13, A: 14,
};

export const SUIT_SYMBOL = { s: '♠', h: '♥', d: '♦', c: '♣' };
export const SUIT_NAME = { s: '黑桃', h: '红心', d: '方块', c: '梅花' };
export const RANK_NAME = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9',
  T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A',
};

export const CATEGORY_NAME = [
  '高牌', '一对', '两对', '三条', '顺子', '同花', '葫芦', '四条', '同花顺',
];

/** 生成一副 52 张的新牌（已洗牌）。 */
export function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANK_CHARS) deck.push(r + s);
  return deck;
}

/** 均匀随机整数 [0, max)，优先使用 crypto，退化到 Math.random。 */
export function randomInt(max) {
  if (max <= 0) return 0;
  const g = globalThis.crypto;
  if (g && typeof g.getRandomValues === 'function') {
    const limit = Math.floor(0x100000000 / max) * max;
    const buf = new Uint32Array(1);
    let v;
    do {
      g.getRandomValues(buf);
      v = buf[0];
    } while (v >= limit);
    return v % max;
  }
  return Math.floor(Math.random() * max);
}

/** 原地 Fisher-Yates 洗牌。 */
export function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function rankOf(card) {
  return RANK_VALUE[card[0]];
}

export function suitOf(card) {
  return card[1];
}

/** "As" -> "♠A"（用于日志/纯文本展示）。 */
export function cardText(card) {
  if (!card) return '?';
  return SUIT_SYMBOL[card[1]] + RANK_NAME[card[0]];
}

export function cardsText(cards) {
  return (cards || []).map(cardText).join(' ');
}

/** 对恰好 5 张牌求分值。返回 { cat, kickers }，cat 越大越好，kickers 依次比较。 */
export function rank5(cards) {
  const vals = cards.map(rankOf).sort((a, b) => b - a);
  const suit = suitOf(cards[0]);
  const flush = cards.every((c) => suitOf(c) === suit);

  const uniq = [];
  for (const v of vals) if (uniq[uniq.length - 1] !== v) uniq.push(v);

  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) straightHigh = uniq[0];
    else if (uniq[0] === 14 && uniq[1] === 5) straightHigh = 5; // A2345
  }

  if (flush && straightHigh) return { cat: 8, kickers: [straightHigh] };

  const counts = new Map();
  for (const v of vals) counts.set(v, (counts.get(v) || 0) + 1);
  // 先按张数降序，同张数按点数降序
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const pattern = groups.map((g) => g[1]).join('');

  if (pattern === '41') return { cat: 7, kickers: [groups[0][0], groups[1][0]] };
  if (pattern === '32') return { cat: 6, kickers: [groups[0][0], groups[1][0]] };
  if (flush) return { cat: 5, kickers: vals };
  if (straightHigh) return { cat: 4, kickers: [straightHigh] };
  if (pattern === '311') return { cat: 3, kickers: [groups[0][0], groups[1][0], groups[2][0]] };
  if (pattern === '221') return { cat: 2, kickers: [groups[0][0], groups[1][0], groups[2][0]] };
  if (pattern === '2111') return { cat: 1, kickers: [groups[0][0], groups[1][0], groups[2][0], groups[3][0]] };
  return { cat: 0, kickers: vals };
}

/** 比较两个 rank5 结果：>0 表示 a 大。 */
export function compareScore(a, b) {
  if (a.cat !== b.cat) return a.cat - b.cat;
  const n = Math.max(a.kickers.length, b.kickers.length);
  for (let i = 0; i < n; i++) {
    const x = a.kickers[i] || 0;
    const y = b.kickers[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

const COMBOS_5_OF_7 = (() => {
  const list = [];
  for (let a = 0; a < 3; a++)
    for (let b = a + 1; b < 4; b++)
      for (let c = b + 1; c < 5; c++)
        for (let d = c + 1; d < 6; d++)
          for (let e = d + 1; e < 7; e++) list.push([a, b, c, d, e]);
  return list;
})();

/**
 * 从 5~7 张牌中取最好的 5 张。
 * 返回 { cat, kickers, name, best5, score }，其中 name 形如 "同花，A 高"。
 */
export function evaluate(cards) {
  if (!cards || cards.length < 5) {
    return { cat: -1, kickers: [], name: '未成牌', best5: [], score: { cat: -1, kickers: [] } };
  }
  const n = cards.length;
  let best = null;
  let bestCards = null;

  if (n === 5) {
    best = rank5(cards);
    bestCards = cards.slice();
  } else {
    const combos = n === 7 ? COMBOS_5_OF_7 : allCombos(n, 5);
    for (const idx of combos) {
      const five = idx.map((i) => cards[i]);
      const s = rank5(five);
      if (!best || compareScore(s, best) > 0) {
        best = s;
        bestCards = five;
      }
    }
  }

  bestCards.sort((x, y) => rankOf(y) - rankOf(x));
  return {
    cat: best.cat,
    kickers: best.kickers,
    name: describe(best, bestCards),
    best5: bestCards,
    score: best,
  };
}

function allCombos(n, k) {
  const out = [];
  const cur = [];
  (function rec(start) {
    if (cur.length === k) {
      out.push(cur.slice());
      return;
    }
    for (let i = start; i < n; i++) {
      cur.push(i);
      rec(i + 1);
      cur.pop();
    }
  })(0);
  return out;
}

function describe(score, bestCards) {
  const base = CATEGORY_NAME[score.cat];
  const k = score.kickers;
  const rn = (v) => RANK_NAME[v] || String(v);
  switch (score.cat) {
    case 8:
      return k[0] === 14 ? '皇家同花顺' : `同花顺，${rn(k[0])} 高`;
    case 7:
      return `四条 ${rn(k[0])}`;
    case 6:
      return `葫芦 ${rn(k[0])} 带 ${rn(k[1])}`;
    case 5:
      return `同花，${rn(k[0])} 高`;
    case 4:
      return `顺子，${rn(k[0])} 高`;
    case 3:
      return `三条 ${rn(k[0])}`;
    case 2:
      return `两对 ${rn(k[0])} 与 ${rn(k[1])}`;
    case 1:
      return `一对 ${rn(k[0])}`;
    default:
      return `高牌 ${rn(k[0])}`;
  }
}

/** 计算两手牌谁大：>0 表示 a 大，0 表示平。 */
export function compareHands(aCards, bCards) {
  return compareScore(evaluate(aCards).score, evaluate(bCards).score);
}
