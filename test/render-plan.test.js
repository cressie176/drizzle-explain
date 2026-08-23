const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { renderPlan } = require('../lib/render-plan');

describe('renderPlan', () => {
  test('returns an empty string when the plan passes', () => {
    const root = { type: 'Seq Scan', cost: 5, estimatedRows: 10, actualRows: 10, children: [] };
    const analysis = { passed: true, breaches: [] };

    assert.equal(renderPlan(root, analysis), '');
  });

  test('summarises a maxCost breach and annotates the responsible node', () => {
    const root = { type: 'Seq Scan', cost: 62431, estimatedRows: 10, actualRows: 10, children: [] };
    const analysis = {
      passed: false,
      breaches: [{ node: root, limit: 'maxCost', threshold: 100, observed: 62431 }],
    };

    const message = renderPlan(root, analysis);

    assert.equal(
      message,
      ['✘ cost 62431 exceeds limit 100', '', 'Seq Scan  (cost=62431 rows=10 actual=10)  ✘ cost 62431 > 100'].join('\n'),
    );
  });

  test('summarises a rowEstimateTolerance breach and annotates the responsible node', () => {
    const root = { type: 'Index Scan', cost: 8, estimatedRows: 1, actualRows: 340, children: [] };
    const analysis = {
      passed: false,
      breaches: [{ node: root, limit: 'rowEstimateTolerance', threshold: 10, observed: 340 }],
    };

    const message = renderPlan(root, analysis);

    assert.equal(
      message,
      ['✘ row estimate 340x off, limit 10', '', 'Index Scan  (cost=8 rows=1 actual=340)  ✘ 340x off, limit 10'].join(
        '\n',
      ),
    );
  });

  test('names every breached limit in the summary', () => {
    const root = { type: 'Seq Scan', cost: 62431, estimatedRows: 1, actualRows: 340, children: [] };
    const analysis = {
      passed: false,
      breaches: [
        { node: root, limit: 'maxCost', threshold: 100, observed: 62431 },
        { node: root, limit: 'rowEstimateTolerance', threshold: 10, observed: 340 },
      ],
    };

    const message = renderPlan(root, analysis);
    const summary = message.split('\n\n')[0];

    assert.equal(summary, ['✘ cost 62431 exceeds limit 100', '✘ row estimate 340x off, limit 10'].join('\n'));
  });

  test('appends multiple annotations to a node breaching several limits', () => {
    const root = { type: 'Seq Scan', cost: 62431, estimatedRows: 1, actualRows: 340, children: [] };
    const analysis = {
      passed: false,
      breaches: [
        { node: root, limit: 'maxCost', threshold: 100, observed: 62431 },
        { node: root, limit: 'rowEstimateTolerance', threshold: 10, observed: 340 },
      ],
    };

    const treeLine = renderPlan(root, analysis).split('\n\n')[1];

    assert.equal(treeLine, 'Seq Scan  (cost=62431 rows=1 actual=340)  ✘ cost 62431 > 100  ✘ 340x off, limit 10');
  });

  test('indents children by depth and annotates the deep offending node', () => {
    const scan = { type: 'Seq Scan', cost: 62431, estimatedRows: 10, actualRows: 10, children: [] };
    const root = { type: 'Nested Loop', cost: 62450, estimatedRows: 10, actualRows: 10, children: [scan] };
    const analysis = {
      passed: false,
      breaches: [{ node: scan, limit: 'maxCost', threshold: 100, observed: 62431 }],
    };

    const message = renderPlan(root, analysis);

    assert.equal(
      message,
      [
        '✘ cost 62431 exceeds limit 100',
        '',
        'Nested Loop  (cost=62450 rows=10 actual=10)',
        '  Seq Scan  (cost=62431 rows=10 actual=10)  ✘ cost 62431 > 100',
      ].join('\n'),
    );
  });

  test('omits absent metric fields rather than printing undefined', () => {
    const root = { type: 'Result', children: [] };
    const analysis = {
      passed: false,
      breaches: [{ node: root, limit: 'rowEstimateTolerance', threshold: 10, observed: 12 }],
    };

    const treeLine = renderPlan(root, analysis).split('\n\n')[1];

    assert.equal(treeLine, 'Result  ✘ 12x off, limit 10');
  });

  test('includes actual time when the node reports it', () => {
    const root = { type: 'Seq Scan', cost: 62431, estimatedRows: 10, actualRows: 10, actualTimeMs: 4.2, children: [] };
    const analysis = {
      passed: false,
      breaches: [{ node: root, limit: 'maxCost', threshold: 100, observed: 62431 }],
    };

    const treeLine = renderPlan(root, analysis).split('\n\n')[1];

    assert.equal(treeLine, 'Seq Scan  (cost=62431 rows=10 actual=10 time=4.2ms)  ✘ cost 62431 > 100');
  });

  test('produces a multi-line message with a blank line between summary and tree', () => {
    const root = { type: 'Seq Scan', cost: 62431, estimatedRows: 10, actualRows: 10, children: [] };
    const analysis = {
      passed: false,
      breaches: [{ node: root, limit: 'maxCost', threshold: 100, observed: 62431 }],
    };

    const lines = renderPlan(root, analysis).split('\n');

    assert.equal(lines.length, 3);
    assert.equal(lines[1], '');
  });
});
