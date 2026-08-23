const { equal: eq, match, doesNotMatch } = require('node:assert/strict');
const { afterEach, describe, test } = require('node:test');
const { renderPlan } = require('../lib/render-plan');

const ESC = String.fromCharCode(27);
const stripAnsi = (text) => text.replace(new RegExp(`${ESC}\\[\\d+m`, 'g'), '');
const render = (root, analysis) => stripAnsi(renderPlan(root, analysis));

describe('renderPlan', () => {
  test('returns an empty string when the plan passes', () => {
    const root = { type: 'Seq Scan', cost: 5, estimatedRows: 10, actualRows: 10, children: [] };
    const analysis = { passed: true, breaches: [] };

    eq(render(root, analysis), '');
  });

  test('summarises a maxCost breach and annotates the responsible node', () => {
    const root = { type: 'Seq Scan', cost: 62431, estimatedRows: 10, actualRows: 10, children: [] };
    const analysis = {
      passed: false,
      breaches: [{ node: root, limit: 'maxCost', threshold: 100, observed: 62431 }],
    };

    const message = render(root, analysis);

    eq(
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

    const message = render(root, analysis);

    eq(
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

    const message = render(root, analysis);
    const summary = message.split('\n\n')[0];

    eq(summary, ['✘ cost 62431 exceeds limit 100', '✘ row estimate 340x off, limit 10'].join('\n'));
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

    const treeLine = render(root, analysis).split('\n\n')[1];

    eq(treeLine, 'Seq Scan  (cost=62431 rows=1 actual=340)  ✘ cost 62431 > 100  ✘ 340x off, limit 10');
  });

  test('indents children by depth and annotates the deep offending node', () => {
    const scan = { type: 'Seq Scan', cost: 62431, estimatedRows: 10, actualRows: 10, children: [] };
    const root = { type: 'Nested Loop', cost: 62450, estimatedRows: 10, actualRows: 10, children: [scan] };
    const analysis = {
      passed: false,
      breaches: [{ node: scan, limit: 'maxCost', threshold: 100, observed: 62431 }],
    };

    const message = render(root, analysis);

    eq(
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

    const treeLine = render(root, analysis).split('\n\n')[1];

    eq(treeLine, 'Result  ✘ 12x off, limit 10');
  });

  test('includes actual time when the node reports it', () => {
    const root = { type: 'Seq Scan', cost: 62431, estimatedRows: 10, actualRows: 10, actualTimeMs: 4.2, children: [] };
    const analysis = {
      passed: false,
      breaches: [{ node: root, limit: 'maxCost', threshold: 100, observed: 62431 }],
    };

    const treeLine = render(root, analysis).split('\n\n')[1];

    eq(treeLine, 'Seq Scan  (cost=62431 rows=10 actual=10 time=4.2ms)  ✘ cost 62431 > 100');
  });

  test('produces a multi-line message with a blank line between summary and tree', () => {
    const root = { type: 'Seq Scan', cost: 62431, estimatedRows: 10, actualRows: 10, children: [] };
    const analysis = {
      passed: false,
      breaches: [{ node: root, limit: 'maxCost', threshold: 100, observed: 62431 }],
    };

    const lines = render(root, analysis).split('\n');

    eq(lines.length, 3);
    eq(lines[1], '');
  });

  describe('colour', () => {
    const originalCI = process.env.CI;
    const originalIsTTY = process.stdout.isTTY;
    const ansi = new RegExp(`${ESC}\\[`);
    const redMarker = new RegExp(`${ESC}\\[31m✘ cost 62431 exceeds limit 100${ESC}\\[0m`);

    const breaching = () => {
      const root = { type: 'Seq Scan', cost: 62431, estimatedRows: 10, actualRows: 10, children: [] };
      return [root, { passed: false, breaches: [{ node: root, limit: 'maxCost', threshold: 100, observed: 62431 }] }];
    };

    const setCI = (value) => {
      process.env.CI = value;
    };

    const clearCI = () => {
      Reflect.deleteProperty(process.env, 'CI');
    };

    const restoreCI = () => {
      if (originalCI === undefined) return clearCI();
      process.env.CI = originalCI;
    };

    afterEach(() => {
      restoreCI();
      process.stdout.isTTY = originalIsTTY;
    });

    test('wraps breach markers in red on an interactive terminal', () => {
      clearCI();
      process.stdout.isTTY = true;

      match(renderPlan(...breaching()), redMarker);
    });

    test('emits no colour when CI is set', () => {
      setCI('true');
      process.stdout.isTTY = true;

      doesNotMatch(renderPlan(...breaching()), ansi);
    });

    test('emits no colour when stdout is not a TTY', () => {
      clearCI();
      process.stdout.isTTY = false;

      doesNotMatch(renderPlan(...breaching()), ansi);
    });
  });
});
