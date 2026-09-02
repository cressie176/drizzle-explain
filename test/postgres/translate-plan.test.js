const { equal } = require('node:assert/strict');
const { describe, test } = require('node:test');
const { translatePlan } = require('../../lib/postgres/translate-plan');

const planOf = (node) => [{ Plan: { 'Node Type': 'Seq Scan', ...node } }];
const nodeOf = (node) => translatePlan(planOf(node));

describe('postgres plan translator', () => {
  describe('rows scanned', () => {
    test('counts the rows a filter discarded alongside those it kept', () => {
      const node = nodeOf({ 'Relation Name': 'widgets', 'Actual Rows': 1, 'Rows Removed by Filter': 19999 });

      equal(node.scanned, 20000);
      equal(node.actualRows, 1);
    });

    test('treats a plan reporting no discarded rows as having discarded none', () => {
      const node = nodeOf({ 'Relation Name': 'widgets', 'Actual Rows': 40 });

      equal(node.scanned, 40);
    });

    test('multiplies by the number of times the node ran', () => {
      const node = nodeOf({
        'Relation Name': 'widgets',
        'Actual Rows': 1,
        'Rows Removed by Filter': 1999,
        'Actual Loops': 200,
      });

      equal(node.scanned, 400000);
      equal(node.loops, 200);
    });

    test('leaves the per-execution counts alone', () => {
      const node = nodeOf({ 'Relation Name': 'widgets', 'Plan Rows': 3, 'Actual Rows': 1, 'Actual Loops': 200 });

      equal(node.estimatedRows, 3);
      equal(node.actualRows, 1);
    });

    test('assumes one execution where the plan reports no loop count', () => {
      const node = nodeOf({ 'Relation Name': 'widgets', 'Actual Rows': 40, 'Rows Removed by Filter': 10 });

      equal(node.scanned, 50);
      equal(node.loops, undefined);
    });

    test('leaves a node that reads no relation without a scanned count', () => {
      const node = nodeOf({ 'Node Type': 'Hash Join', 'Actual Rows': 40, 'Actual Loops': 2 });

      equal(node.scanned, undefined);
      equal(node.loops, 2);
    });
  });
});
