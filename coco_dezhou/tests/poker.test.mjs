import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, compareHands, makeDeck, shuffle, rank5, CATEGORY_NAME } from '../shared/cards.mjs';

const ev = (cards) => evaluate(cards);

test('牌堆是 52 张且互不重复', () => {
  const deck = makeDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck).size, 52);
  shuffle(deck);
  assert.equal(new Set(deck).size, 52);
});

test('牌型分类正确', () => {
  assert.equal(ev(['As', 'Ks', 'Qs', 'Js', 'Ts', '2c', '3d']).cat, 8); // 皇家同花顺
  assert.equal(ev(['5h', '4h', '3h', '2h', 'Ah', 'Kc', 'Qd']).cat, 8); // 5 高同花顺
  assert.equal(ev(['9c', '9d', '9h', '9s', 'Ah', '2c', '3d']).cat, 7); // 四条
  assert.equal(ev(['9c', '9d', '9h', '4s', '4h', '2c', '3d']).cat, 6); // 葫芦
  assert.equal(ev(['Ah', 'Kh', '9h', '5h', '2h', '3c', '4d']).cat, 5); // 同花
  assert.equal(ev(['9c', '8d', '7h', '6s', '5h', '2c', '3d']).cat, 4); // 顺子
  assert.equal(ev(['9c', '9d', '9h', 'Ks', 'Ah', '2c', '3d']).cat, 3); // 三条
  assert.equal(ev(['9c', '9d', 'Kh', 'Ks', 'Ah', '2c', '3d']).cat, 2); // 两对
  assert.equal(ev(['9c', '9d', 'Kh', 'Qs', 'Ah', '2c', '3d']).cat, 1); // 一对
  assert.equal(ev(['9c', '8d', 'Kh', 'Qs', 'Ah', '2c', '3d']).cat, 0); // 高牌
});

test('A2345 是最小的顺子', () => {
  const wheel = ev(['Ah', '2c', '3d', '4s', '5h', 'Kc', 'Qd']);
  const six = ev(['2c', '3d', '4s', '5h', '6c', 'Kc', 'Qd']);
  assert.equal(wheel.cat, 4);
  assert.ok(compareHands(six.best5, wheel.best5) > 0);
});

test('踢脚比较', () => {
  assert.ok(compareHands(['As', 'Ah', 'Kd', '7c', '2s', '5h', '9d'], ['Ac', 'Ad', 'Qd', '7h', '2c', '5s', '9h']) > 0);
  assert.equal(compareHands(['As', 'Ah', 'Kd', '7c', '2s', '5h', '9d'], ['Ac', 'Ad', 'Kd', '7h', '2c', '5s', '9h']), 0);
});

test('葫芦大于同花', () => {
  assert.ok(compareHands(['9c', '9d', '9h', '4s', '4h', '2c', '3d'], ['Ah', 'Kh', '9h', '5h', '2h', '3c', '4d']) > 0);
});

test('7 张牌会挑出最大的 5 张', () => {
  const r = ev(['As', 'Ks', 'Qs', 'Js', 'Ts', '2c', '3d']);
  assert.equal(r.best5.length, 5);
  assert.equal(r.cat, 8);
  assert.match(r.name, /同花顺/);
  assert.equal(r.best5.includes('2c'), false);
});

test('排名表与牌型一一对应', () => {
  assert.equal(CATEGORY_NAME.length, 9);
  const r = rank5(['2c', '3d', '4h', '5s', '7c']);
  assert.equal(r.cat, 0);
});
