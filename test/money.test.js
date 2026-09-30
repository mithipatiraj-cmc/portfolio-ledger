'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Money = require('../src/renderer/money.js');

test('INR keeps lakh grouping and compact lakh/crore notation', () => {
  const inr = Money.createMoney('INR');
  assert.equal(inr.symbol, '₹');
  assert.equal(inr.format(1234567), '₹12,34,567');
  assert.equal(inr.format(4800, { decimals: 2 }), '₹4,800.00');
  assert.equal(inr.compact(625000), '₹6.25L');
  assert.equal(inr.number(100000), '1,00,000');
});

test('other currencies use their own symbol and international grouping', () => {
  const usd = Money.createMoney('USD');
  assert.equal(usd.format(1234567), '$1,234,567');
  assert.equal(usd.compact(625000), '$625K');
  assert.equal(usd.number(1234567.891, { maximumFractionDigits: 2 }), '1,234,567.89');
  assert.equal(Money.createMoney('EUR').format(99.5, { decimals: 2 }), '€99.50');
  assert.equal(Money.createMoney('GBP').symbol, '£');
});

test('every supported currency uses "." for decimals, so typed amounts parse the same way', () => {
  for (const { code } of Money.CURRENCIES) {
    assert.match(Money.createMoney(code).number(1234.5, { minimumFractionDigits: 1 }), /1,234\.5$/, code);
  }
});

test('unknown codes fall back to INR, and the current preference can be switched', () => {
  assert.equal(Money.createMoney('XYZ').code, 'INR');
  assert.equal(Money.isSupported('USD'), true);
  assert.equal(Money.isSupported('XYZ'), false);
  Money.setCurrency('USD');
  assert.equal(Money.format(100000), '$100,000');
  assert.equal(Money.symbol(), '$');
  Money.setCurrency('INR');
  assert.equal(Money.format(100000), '₹1,00,000');
});
