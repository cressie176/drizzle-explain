const { deepEqual: deq, equal } = require('node:assert/strict');
const { describe, test } = require('node:test');
const { translatePlan } = require('../../lib/mariadb/plan-translator');

const planOf = (table) => ({ query_block: { select_id: 1, table } });
const accessNodeOf = (table) => translatePlan(planOf(table)).children[0];

describe('mariadb plan translator', () => {
  describe('row counts', () => {
    test('derives the rows produced from the filtered percentages', () => {
      const node = accessNodeOf({
        table_name: 'widgets',
        access_type: 'ALL',
        rows: 200,
        filtered: 50,
        r_rows: 300,
        r_filtered: 10,
      });

      equal(node.estimatedRows, 100);
      equal(node.actualRows, 30);
      equal(node.scanned, 300);
    });

    test('rounds a fractional count to whole rows', () => {
      const node = accessNodeOf({
        table_name: 'widgets',
        access_type: 'ALL',
        rows: 3,
        filtered: 100,
        r_rows: 3,
        r_filtered: 33.33333333,
      });

      equal(node.actualRows, 1);
    });

    test('keeps the raw counts when the plan reports no filtered percentages', () => {
      const node = accessNodeOf({ table_name: 'widgets', access_type: 'ALL', rows: 200, r_rows: 300 });

      equal(node.estimatedRows, 200);
      equal(node.actualRows, 300);
      equal(node.scanned, 300);
    });

    test('leaves the counts unset when the plan reports neither', () => {
      const node = accessNodeOf({ table_name: 'widgets', access_type: 'const', rows: null, r_rows: null });

      equal(node.estimatedRows, undefined);
      equal(node.actualRows, undefined);
      equal(node.scanned, undefined);
    });

    test('reports no rows produced when the filter discarded everything', () => {
      const node = accessNodeOf({ table_name: 'widgets', access_type: 'ALL', rows: 200, r_rows: 300, r_filtered: 0 });

      equal(node.actualRows, 0);
      equal(node.scanned, 300);
    });

    test('carries the table name and access type separately', () => {
      const node = accessNodeOf({ table_name: 'widgets', access_type: 'ALL', rows: 1, r_rows: 1 });

      equal(node.type, 'ALL');
      equal(node.relation, 'widgets');
      deq(node.children, []);
    });
  });
});
