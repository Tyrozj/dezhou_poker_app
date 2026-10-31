/**
 * 桌面特效：荷官发牌、筹码推入、摊牌翻牌、筹码汇给赢家。
 * 全部用 DOM + Web Animations，不依赖任何图片或第三方库。
 */

import { RANK_NAME, SUIT_SYMBOL } from '/shared/cards.mjs';

const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

const rect = (el) => (el ? el.getBoundingClientRect() : null);

export function dealerEl() {
  return document.getElementById('dealer');
}

/** 从荷官手里飞一张牌到目标位置 */
export function flyCard(toEl, { face = null, delay = 0, duration = 420 } = {}) {
  if (reduceMotion) return;
  const from = rect(dealerEl());
  const to = rect(toEl);
  if (!from || !to) return;

  const node = document.createElement('div');
  node.className = 'fly-card' + (face ? '' : ' is-back');
  if (face) {
    node.innerHTML = `<span class="rk">${RANK_NAME[face[0]]}</span><span class="st">${SUIT_SYMBOL[face[1]]}</span>`;
    if (face[1] === 'h' || face[1] === 'd') node.classList.add('is-red');
  }
  node.style.left = `${from.left + from.width * 0.72}px`;
  node.style.top = `${from.top + from.height * 0.42}px`;
  document.body.appendChild(node);

  const dx = to.left + to.width / 2 - (from.left + from.width * 0.72);
  const dy = to.top + to.height / 2 - (from.top + from.height * 0.42);

  const anim = node.animate(
    [
      { transform: 'translate(-50%, -50%) scale(0.5) rotate(-24deg)', opacity: 0 },
      { transform: 'translate(-50%, -50%) scale(1) rotate(-6deg)', opacity: 1, offset: 0.35 },
      {
        transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.72) rotate(6deg)`,
        opacity: 1,
      },
    ],
    { duration, delay, easing: 'cubic-bezier(.22,.68,.32,1)', fill: 'both' },
  );
  anim.onfinish = () => node.remove();
  setTimeout(() => node.remove(), delay + duration + 600);
}

/** 一串筹码从某个座位推到桌面中央（底池） */
export function pushChips(fromEl, toEl, amount, { delay = 0 } = {}) {
  if (reduceMotion || !fromEl || !toEl || amount <= 0) return;
  const count = amount >= 300 ? 6 : amount >= 100 ? 5 : amount >= 40 ? 4 : 3;
  for (let i = 0; i < count; i++) {
    spawnChip(fromEl, toEl, { delay: delay + i * 55, spread: 14, lift: -18 });
  }
  floatText(fromEl, `-${amount}`, 'out', delay + 60);
}

/** 摊牌后把底池筹码汇给赢家 */
export function collectChips(fromEl, toEl, amount, { delay = 0 } = {}) {
  if (reduceMotion || !fromEl || !toEl) return;
  const count = 9;
  for (let i = 0; i < count; i++) {
    spawnChip(fromEl, toEl, { delay: delay + i * 45, spread: 26, lift: -26, size: 15 });
  }
  floatText(toEl, `+${amount}`, 'in', delay + 260);
}

function spawnChip(fromEl, toEl, { delay = 0, spread = 12, lift = -16, size = 16 } = {}) {
  const from = rect(fromEl);
  const to = rect(toEl);
  if (!from || !to) return;
  const node = document.createElement('i');
  node.className = 'fly-chip';
  node.style.width = `${size}px`;
  node.style.height = `${size}px`;
  const x0 = from.left + from.width / 2 + (Math.random() * spread * 2 - spread);
  const y0 = from.top + from.height / 2 + (Math.random() * 8 - 4);
  node.style.left = `${x0}px`;
  node.style.top = `${y0}px`;
  document.body.appendChild(node);

  const dx = to.left + to.width / 2 - x0 + (Math.random() * 10 - 5);
  const dy = to.top + to.height / 2 - y0 + (Math.random() * 10 - 5);

  const anim = node.animate(
    [
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0 },
      { transform: `translate(calc(-50% + ${dx * 0.45}px), calc(-50% + ${dy * 0.45 + lift}px)) scale(1.12)`, opacity: 1, offset: 0.5 },
      { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.9)`, opacity: 0 },
    ],
    { duration: 520, delay, easing: 'cubic-bezier(.3,.7,.4,1)', fill: 'both' },
  );
  anim.onfinish = () => node.remove();
  setTimeout(() => node.remove(), delay + 1200);
}

function floatText(anchorEl, text, dir, delay = 0) {
  const r = rect(anchorEl);
  if (!r) return;
  const node = document.createElement('div');
  node.className = `fx-float ${dir}`;
  node.textContent = text;
  node.style.left = `${r.left + r.width / 2}px`;
  node.style.top = `${r.top + r.height / 2}px`;
  document.body.appendChild(node);
  const up = dir === 'in' ? -40 : -30;
  const anim = node.animate(
    [
      { transform: 'translate(-50%, -50%) scale(.8)', opacity: 0 },
      { transform: `translate(-50%, calc(-50% + ${up * 0.4}px)) scale(1.1)`, opacity: 1, offset: 0.25 },
      { transform: `translate(-50%, calc(-50% + ${up}px)) scale(1)`, opacity: 0 },
    ],
    { duration: 900, delay, easing: 'ease-out', fill: 'both' },
  );
  anim.onfinish = () => node.remove();
  setTimeout(() => node.remove(), delay + 1400);
}

/** 摊牌：给新翻开的底牌加翻牌动画 */
export function revealTableCards(next, prevPhase) {
  if (reduceMotion) return;
  const cards = document.querySelectorAll('.seat .hole .pcard');
  cards.forEach((card, i) => {
    card.classList.add('flip-in');
    card.style.animationDelay = `${i * 70}ms`;
  });
}

/** 发牌时让荷官动一下 */
export function dealerDeal() {
  const el = dealerEl();
  if (!el || reduceMotion) return;
  el.classList.remove('is-dealing');
  void el.offsetWidth;
  el.classList.add('is-dealing');
  clearTimeout(dealerDeal._timer);
  dealerDeal._timer = setTimeout(() => el.classList.remove('is-dealing'), 1500);
}
