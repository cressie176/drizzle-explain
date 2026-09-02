const { equal: eq, match, doesNotMatch } = require('node:assert/strict');
const { afterEach, beforeEach, describe, test } = require('node:test');
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
      ['✘ cost 62431 exceeds limit 100', '', 'Seq Scan  (cost=62431 estimated=10 actual=10)  ✘ cost 62431 > 100'].join(
        '\n',
      ),
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
      [
        '✘ row estimate 340x off, limit 10',
        '',
        'Index Scan  (cost=8 estimated=1 actual=340)  ✘ 340x off, limit 10',
      ].join('\n'),
    );
  });

  test('summarises a disallowOperations breach and annotates the offending node with its vendor type', () => {
    const root = { type: 'Seq Scan', cost: 62431, estimatedRows: 10, actualRows: 10, children: [] };
    const analysis = {
      passed: false,
      breaches: [{ node: root, limit: 'disallowOperations', threshold: ['SEQ_SCAN'], observed: 'SEQ_SCAN' }],
    };

    const message = render(root, analysis);

    eq(
      message,
      [
        '✘ disallowed operation: Seq Scan',
        '',
        'Seq Scan  (cost=62431 estimated=10 actual=10)  ✘ Seq Scan not allowed',
      ].join('\n'),
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

    eq(treeLine, 'Seq Scan  (cost=62431 estimated=1 actual=340)  ✘ cost 62431 > 100  ✘ 340x off, limit 10');
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
        'Nested Loop  (cost=62450 estimated=10 actual=10)',
        '  Seq Scan  (cost=62431 estimated=10 actual=10)  ✘ cost 62431 > 100',
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

    eq(treeLine, 'Seq Scan  (cost=62431 estimated=10 actual=10 time=4.2ms)  ✘ cost 62431 > 100');
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

  describe('scanned relations', () => {
    test('names the table on the node line', () => {
      const root = { type: 'Seq Scan', relation: 'widgets', cost: 5, estimatedRows: 10, actualRows: 10, children: [] };
      const analysis = { passed: false, breaches: [{ node: root, limit: 'maxCost', threshold: 1, observed: 5 }] };

      match(render(root, analysis), /^Seq Scan on widgets {2}\(cost=5/m);
    });

    test('names the alias alongside the table when they differ', () => {
      const root = { type: 'Seq Scan', relation: 'widgets', alias: 'w', cost: 5, children: [] };
      const analysis = { passed: false, breaches: [{ node: root, limit: 'maxCost', threshold: 1, observed: 5 }] };

      match(render(root, analysis), /^Seq Scan on widgets w {2}\(cost=5/m);
    });

    test('names the table in the disallowed-operation summary', () => {
      const root = { type: 'Seq Scan', relation: 'widgets', operation: 'SEQ_SCAN', children: [] };
      const analysis = {
        passed: false,
        breaches: [{ node: root, limit: 'disallowOperations', threshold: ['SEQ_SCAN'], observed: 'SEQ_SCAN' }],
      };

      match(render(root, analysis), /✘ disallowed operation: Seq Scan on widgets/);
    });

    test('renders a node that scans no relation exactly as before', () => {
      const root = { type: 'Hash Join', cost: 5, estimatedRows: 10, actualRows: 10, children: [] };
      const analysis = { passed: false, breaches: [{ node: root, limit: 'maxCost', threshold: 1, observed: 5 }] };

      match(render(root, analysis), /^Hash Join {2}\(cost=5 estimated=10 actual=10\)/m);
    });

    test('renders rows scanned between actual rows and time', () => {
      const root = {
        type: 'Seq Scan',
        relation: 'widgets',
        cost: 5,
        estimatedRows: 1,
        actualRows: 1,
        scanned: 20000,
        actualTimeMs: 3,
        children: [],
      };
      const analysis = { passed: false, breaches: [{ node: root, limit: 'maxCost', threshold: 1, observed: 5 }] };

      match(render(root, analysis), /\(cost=5 estimated=1 actual=1 scanned=20000 time=3ms\)/);
    });

    test('renders the loop count only when the node ran more than once', () => {
      const node = (loops) => ({
        type: 'Seq Scan',
        relation: 'books',
        cost: 5,
        actualRows: 1,
        scanned: 20000,
        loops,
        children: [],
      });
      const looped = node(200);
      const once = node(1);
      const breach = (node) => ({ passed: false, breaches: [{ node, limit: 'maxCost', threshold: 1, observed: 5 }] });

      match(render(looped, breach(looped)), /actual=1 scanned=20000 loops=200/);
      doesNotMatch(render(once, breach(once)), /loops=/);
    });

    test('omits rows scanned when the driver did not report it', () => {
      const root = { type: 'Seq Scan', relation: 'widgets', cost: 5, actualRows: 1, children: [] };
      const analysis = { passed: false, breaches: [{ node: root, limit: 'maxCost', threshold: 1, observed: 5 }] };

      doesNotMatch(render(root, analysis), /scanned=/);
    });
  });

  describe('exemptions', () => {
    const scan = (overrides) => ({ type: 'Seq Scan', operation: 'SEQ_SCAN', children: [], ...overrides });

    test('marks an exempted node with the conditions that allowed it', () => {
      const small = scan({ relation: 'authors', scanned: 40 });
      const large = scan({ relation: 'books', scanned: 20000 });
      const root = { type: 'Nested Loop', children: [large, small] };
      const analysis = {
        passed: false,
        breaches: [{ node: large, limit: 'disallowOperations', threshold: ['SEQ_SCAN'], observed: 'SEQ_SCAN' }],
        exemptions: [{ node: small, exemption: { operation: 'SEQ_SCAN', maxScanned: 500 } }],
      };

      const message = render(root, analysis);

      match(message, /Seq Scan on books {2}\(scanned=20000\) {2}✘ Seq Scan not allowed/);
      match(message, /Seq Scan on authors {2}\(scanned=40\) {2}✓ allowed by maxScanned=500/);
    });

    test('lists every condition that allowed the node', () => {
      const small = scan({ relation: 'authors', scanned: 40 });
      const analysis = {
        passed: false,
        breaches: [{ node: small, limit: 'maxCost', threshold: 1, observed: 5 }],
        exemptions: [{ node: small, exemption: { operation: 'SEQ_SCAN', relation: 'authors', maxScanned: 500 } }],
      };

      match(render(small, analysis), /✓ allowed by relation=authors, maxScanned=500/);
    });

    test('marks a node exempted by a bare operation without naming conditions', () => {
      const small = scan({ relation: 'authors' });
      const analysis = {
        passed: false,
        breaches: [{ node: small, limit: 'maxCost', threshold: 1, observed: 5 }],
        exemptions: [{ node: small, exemption: 'SEQ_SCAN' }],
      };

      match(render(small, analysis), /✓ allowed$/m);
    });

    test('renders nothing extra when the analysis reports no exemptions', () => {
      const root = scan({ relation: 'books', cost: 5 });
      const analysis = { passed: false, breaches: [{ node: root, limit: 'maxCost', threshold: 1, observed: 5 }] };

      doesNotMatch(render(root, analysis), /✓/);
    });
  });

  describe('colour', () => {
    const colourVars = ['CI', 'FORCE_COLOR', 'NO_COLOR'];
    const originalEnv = Object.fromEntries(colourVars.map((name) => [name, process.env[name]]));
    const originalIsTTY = process.stdout.isTTY;
    const ansi = new RegExp(`${ESC}\\[`);
    const redMarker = new RegExp(`${ESC}\\[31m✘ cost 62431 exceeds limit 100${ESC}\\[0m`);

    const breaching = () => {
      const root = { type: 'Seq Scan', cost: 62431, estimatedRows: 10, actualRows: 10, children: [] };
      return [root, { passed: false, breaches: [{ node: root, limit: 'maxCost', threshold: 100, observed: 62431 }] }];
    };

    const setEnv = (name, value) => {
      process.env[name] = value;
    };

    const clearEnv = (name) => {
      Reflect.deleteProperty(process.env, name);
    };

    beforeEach(() => {
      for (const name of colourVars) clearEnv(name);
    });

    afterEach(() => {
      for (const name of colourVars) {
        if (originalEnv[name] === undefined) clearEnv(name);
        else setEnv(name, originalEnv[name]);
      }
      process.stdout.isTTY = originalIsTTY;
    });

    test('wraps breach markers in red on an interactive terminal', () => {
      process.stdout.isTTY = true;

      match(renderPlan(...breaching()), redMarker);
    });

    test('emits no colour when CI is set', () => {
      setEnv('CI', 'true');
      process.stdout.isTTY = true;

      doesNotMatch(renderPlan(...breaching()), ansi);
    });

    test('emits no colour when stdout is not a TTY', () => {
      process.stdout.isTTY = false;

      doesNotMatch(renderPlan(...breaching()), ansi);
    });

    test('emits colour when FORCE_COLOR is set even without a TTY', () => {
      setEnv('FORCE_COLOR', '1');
      process.stdout.isTTY = false;

      match(renderPlan(...breaching()), redMarker);
    });

    test('FORCE_COLOR overrides CI', () => {
      setEnv('FORCE_COLOR', '1');
      setEnv('CI', 'true');
      process.stdout.isTTY = false;

      match(renderPlan(...breaching()), redMarker);
    });

    test('NO_COLOR suppresses colour even on an interactive terminal', () => {
      setEnv('NO_COLOR', '1');
      process.stdout.isTTY = true;

      doesNotMatch(renderPlan(...breaching()), ansi);
    });

    test('NO_COLOR wins over FORCE_COLOR', () => {
      setEnv('NO_COLOR', '1');
      setEnv('FORCE_COLOR', '1');
      process.stdout.isTTY = true;

      doesNotMatch(renderPlan(...breaching()), ansi);
    });
  });
});
