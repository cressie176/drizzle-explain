const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { analysePlan } = require('../lib/analyse-plan');

function node(overrides = {}) {
  return { type: 'Seq Scan', children: [], ...overrides };
}

describe('analysePlan', () => {
  describe('maxCost', () => {
    test('passes when the root cost is within the limit', () => {
      const root = node({ cost: 50 });
      const result = analysePlan(root, { maxCost: 100 });
      assert.equal(result.passed, true);
      assert.deepEqual(result.breaches, []);
    });

    test('breaches when the root cost exceeds the limit', () => {
      const root = node({ cost: 150 });
      const result = analysePlan(root, { maxCost: 100 });
      assert.equal(result.passed, false);
      assert.equal(result.breaches.length, 1);
      assert.deepEqual(result.breaches[0], { node: root, limit: 'maxCost', threshold: 100, observed: 150 });
    });

    test('checks only the root cost, never a child', () => {
      const child = node({ cost: 9999 });
      const root = node({ cost: 10, children: [child] });
      const result = analysePlan(root, { maxCost: 100 });
      assert.equal(result.passed, true);
    });

    test('is skipped when the root has no cost even though children do', () => {
      const child = node({ cost: 9999 });
      const root = node({ children: [child] });
      const result = analysePlan(root, { maxCost: 100 });
      assert.equal(result.passed, true);
      assert.deepEqual(result.breaches, []);
    });

    test('is skipped when the limit is not set', () => {
      const root = node({ cost: 9999 });
      const result = analysePlan(root, {});
      assert.equal(result.passed, true);
    });

    test('does not breach when cost equals the limit', () => {
      const root = node({ cost: 100 });
      const result = analysePlan(root, { maxCost: 100 });
      assert.equal(result.passed, true);
    });
  });

  describe('rowEstimateTolerance', () => {
    test('passes when every node is within tolerance', () => {
      const root = node({ estimatedRows: 100, actualRows: 120 });
      const result = analysePlan(root, { rowEstimateTolerance: 10 });
      assert.equal(result.passed, true);
    });

    test('breaches with the worst node ratio, not the root', () => {
      const worst = node({ type: 'Index Scan', estimatedRows: 1, actualRows: 10000 });
      const middle = node({ type: 'Hash Join', estimatedRows: 100, actualRows: 150, children: [worst] });
      const root = node({ type: 'Aggregate', estimatedRows: 10, actualRows: 12, children: [middle] });
      const result = analysePlan(root, { rowEstimateTolerance: 10 });
      assert.equal(result.passed, false);
      assert.equal(result.breaches.length, 1);
      assert.equal(result.breaches[0].node, worst);
      assert.equal(result.breaches[0].limit, 'rowEstimateTolerance');
      assert.equal(result.breaches[0].threshold, 10);
      assert.equal(result.breaches[0].observed, 10000);
    });

    test('ratio is symmetric whether estimate or actual is larger', () => {
      const overEstimate = node({ estimatedRows: 10000, actualRows: 1 });
      const result = analysePlan(overEstimate, { rowEstimateTolerance: 10 });
      assert.equal(result.passed, false);
      assert.equal(result.breaches[0].observed, 10000);
    });

    test('proportional scaling of estimate and actual leaves the ratio unchanged', () => {
      const small = node({ estimatedRows: 2, actualRows: 6 });
      const large = node({ estimatedRows: 2000, actualRows: 6000 });
      const smallRatio = analysePlan(small, { rowEstimateTolerance: 1 }).breaches[0].observed;
      const largeRatio = analysePlan(large, { rowEstimateTolerance: 1 }).breaches[0].observed;
      assert.equal(smallRatio, largeRatio);
      assert.equal(smallRatio, 3);
    });

    test('surfaces only a single worst breach, never one per node', () => {
      const a = node({ estimatedRows: 1, actualRows: 100 });
      const b = node({ estimatedRows: 1, actualRows: 500 });
      const root = node({ estimatedRows: 1, actualRows: 50, children: [a, b] });
      const result = analysePlan(root, { rowEstimateTolerance: 10 });
      assert.equal(result.breaches.length, 1);
      assert.equal(result.breaches[0].node, b);
    });

    test('is skipped when the limit is not set', () => {
      const root = node({ estimatedRows: 1, actualRows: 10000 });
      const result = analysePlan(root, {});
      assert.equal(result.passed, true);
    });

    test('skips nodes missing an estimated row count', () => {
      const root = node({ actualRows: 10000 });
      const result = analysePlan(root, { rowEstimateTolerance: 10 });
      assert.equal(result.passed, true);
    });

    test('skips nodes missing an actual row count', () => {
      const root = node({ estimatedRows: 10000 });
      const result = analysePlan(root, { rowEstimateTolerance: 10 });
      assert.equal(result.passed, true);
    });
  });

  describe('zero-row clamp', () => {
    test('a node with zero actual rows does not by itself fail the check', () => {
      const root = node({ estimatedRows: 1000, actualRows: 0 });
      const result = analysePlan(root, { rowEstimateTolerance: 10 });
      assert.equal(result.passed, true);
      assert.deepEqual(result.breaches, []);
    });

    test('a node with zero estimated rows does not by itself fail the check', () => {
      const root = node({ estimatedRows: 0, actualRows: 1000 });
      const result = analysePlan(root, { rowEstimateTolerance: 10 });
      assert.equal(result.passed, true);
    });

    test('a zero-row node is ignored while a real breach elsewhere still fails', () => {
      const empty = node({ estimatedRows: 5000, actualRows: 0 });
      const breaching = node({ estimatedRows: 1, actualRows: 50 });
      const root = node({ estimatedRows: 10, actualRows: 11, children: [empty, breaching] });
      const result = analysePlan(root, { rowEstimateTolerance: 10 });
      assert.equal(result.passed, false);
      assert.equal(result.breaches[0].node, breaching);
    });
  });

  describe('combined checks', () => {
    test('reports both a maxCost and a rowEstimateTolerance breach at once', () => {
      const root = node({ cost: 500, estimatedRows: 1, actualRows: 1000 });
      const result = analysePlan(root, { maxCost: 100, rowEstimateTolerance: 10 });
      assert.equal(result.passed, false);
      assert.equal(result.breaches.length, 2);
      const limits = result.breaches.map((breach) => breach.limit);
      assert.deepEqual(limits.sort(), ['maxCost', 'rowEstimateTolerance']);
    });

    test('passes with no limits set', () => {
      const root = node({ cost: 9999, estimatedRows: 1, actualRows: 9999 });
      const result = analysePlan(root, {});
      assert.equal(result.passed, true);
      assert.deepEqual(result.breaches, []);
    });
  });
});
