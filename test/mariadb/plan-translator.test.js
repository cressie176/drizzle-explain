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

    test('multiplies rows scanned by the number of times the node ran', () => {
      const node = accessNodeOf({
        table_name: 'widgets',
        access_type: 'ALL',
        rows: 2000,
        r_rows: 2000,
        r_loops: 200,
        r_filtered: 0.05,
      });

      equal(node.scanned, 400000);
      equal(node.loops, 200);
      equal(node.actualRows, 1);
    });

    test('assumes one execution where the plan reports no loop count', () => {
      const node = accessNodeOf({ table_name: 'widgets', access_type: 'ALL', rows: 40, r_rows: 40 });

      equal(node.scanned, 40);
      equal(node.loops, undefined);
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

  describe('nested access nodes', () => {
    const flatten = (node) => [node, ...node.children.flatMap(flatten)];
    const relationsOf = (root) =>
      flatten(root)
        .map((node) => node.relation)
        .filter(Boolean);
    const table = (name) => ({ table_name: name, access_type: 'ALL', rows: 1, r_rows: 1 });

    test('finds the inner table of a block nested loop join', () => {
      const plan = {
        query_block: {
          nested_loop: [{ table: table('lookups') }, { 'block-nl-join': { table: table('events') } }],
        },
      };

      deq(relationsOf(translatePlan(plan)), ['lookups', 'events']);
    });

    test('finds a table sorted to a file', () => {
      const plan = {
        query_block: { nested_loop: [{ read_sorted_file: { filesort: { table: table('events') } } }] },
      };

      deq(relationsOf(translatePlan(plan)), ['events']);
    });

    test('finds a table grouped through a temporary table', () => {
      const plan = {
        query_block: { filesort: { temporary_table: { nested_loop: [{ table: table('events') }] } } },
      };

      deq(relationsOf(translatePlan(plan)), ['events']);
    });

    test('finds the table of a scalar subquery', () => {
      const plan = {
        query_block: {
          nested_loop: [{ table: table('l_outer') }],
          subqueries: [{ query_block: { nested_loop: [{ table: table('l_inner') }] } }],
        },
      };

      deq(relationsOf(translatePlan(plan)), ['l_outer', 'l_inner']);
    });

    test('leaves the union result pseudo-table out while keeping its real tables', () => {
      const plan = {
        query_block: {
          union_result: {
            table_name: '<union1,2>',
            query_specifications: [
              { query_block: { nested_loop: [{ table: table('events') }] } },
              { query_block: { nested_loop: [{ table: table('lookups') }] } },
            ],
          },
        },
      };

      deq(relationsOf(translatePlan(plan)), ['events', 'lookups']);
    });
  });
});
