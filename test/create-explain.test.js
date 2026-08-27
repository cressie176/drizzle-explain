const { equal: eq, deepEqual: deq, match, rejects } = require('node:assert/strict');
const { describe, test } = require('node:test');
const { createExplain } = require('../lib');

function stubDriver(statements) {
  return { explain: async () => statements };
}

function statement(root, plan = { raw: true }, sql = 'select 1', params = []) {
  return { sql, params, plan, root };
}

function node(overrides) {
  return { type: 'Seq Scan', children: [], ...overrides };
}

describe('createExplain', () => {
  test('passes when the plan is within the merged limits', async () => {
    const explain = createExplain(stubDriver([statement(node({ cost: 50 }))]), { maxCost: 100 });

    const analysis = await explain(() => {});

    eq(analysis.passed, true);
    eq(analysis.message, '');
  });

  test('fails and renders the annotated plan when a limit is breached', async () => {
    const explain = createExplain(stubDriver([statement(node({ cost: 62431 }))]), { maxCost: 100 });

    const analysis = await explain(() => {});

    eq(analysis.passed, false);
    match(analysis.message, /cost 62431 exceeds limit 100/);
  });

  test('exposes the effective limits after merging overrides over defaults', async () => {
    const explain = createExplain(stubDriver([statement(node({ cost: 10 }))]), {
      maxCost: 100,
      rowEstimateTolerance: 10,
    });

    const analysis = await explain(() => {}, { maxCost: 500 });

    deq(analysis.limits, { maxCost: 500, rowEstimateTolerance: 10 });
  });

  test('reports the raw, unmodified vendor plan', async () => {
    const rawPlan = [{ Plan: { 'Node Type': 'Seq Scan' } }];
    const explain = createExplain(stubDriver([statement(node({ cost: 10 }), rawPlan)]));

    const analysis = await explain(() => {});

    eq(analysis.plan, rawPlan);
  });

  test('throws when the callback executes no statement', async () => {
    const explain = createExplain(stubDriver([]));

    await rejects(
      explain(() => {}),
      /exactly one statement/,
    );
  });

  test('throws when the callback executes more than one statement', async () => {
    const explain = createExplain(stubDriver([statement(node({})), statement(node({}))]));

    await rejects(
      explain(() => {}),
      /exactly one statement/,
    );
  });

  test('does not throw on a breached plan — it reports', async () => {
    const explain = createExplain(stubDriver([statement(node({ cost: 999 }))]), { maxCost: 1 });

    const analysis = await explain(() => {});

    eq(analysis.passed, false);
  });

  describe('an array of limits', () => {
    test('analyses each statement against the limits in the same position', async () => {
      const driver = stubDriver([statement(node({ cost: 50 })), statement(node({ cost: 300 }))]);
      const explain = createExplain(driver);

      const analysis = await explain(() => {}, [{ maxCost: 100 }, { maxCost: 500 }]);

      eq(analysis.passed, true);
      eq(analysis.statements.length, 2);
      deq(
        analysis.statements.map((each) => each.limits),
        [{ maxCost: 100 }, { maxCost: 500 }],
      );
    });

    test('merges each set of limits over the defaults independently', async () => {
      const driver = stubDriver([statement(node({ cost: 10 })), statement(node({ cost: 10 }))]);
      const explain = createExplain(driver, { maxCost: 100, rowEstimateTolerance: 10 });

      const analysis = await explain(() => {}, [{}, { maxCost: 500 }]);

      deq(
        analysis.statements.map((each) => each.limits),
        [
          { maxCost: 100, rowEstimateTolerance: 10 },
          { maxCost: 500, rowEstimateTolerance: 10 },
        ],
      );
    });

    test('fails when any statement breaches its limits', async () => {
      const driver = stubDriver([statement(node({ cost: 50 })), statement(node({ cost: 900 }))]);
      const explain = createExplain(driver);

      const analysis = await explain(() => {}, [{ maxCost: 100 }, { maxCost: 100 }]);

      eq(analysis.passed, false);
      deq(
        analysis.statements.map((each) => each.passed),
        [true, false],
      );
    });

    test('reports an empty message when every statement passes', async () => {
      const driver = stubDriver([statement(node({ cost: 50 })), statement(node({ cost: 50 }))]);
      const explain = createExplain(driver);

      const analysis = await explain(() => {}, [{ maxCost: 100 }, { maxCost: 100 }]);

      eq(analysis.message, '');
    });

    test('identifies a failing statement by position, sql and params', async () => {
      const driver = stubDriver([
        statement(node({ cost: 50 }), { raw: true }, 'select "id" from "widgets"'),
        statement(node({ cost: 900 }), { raw: true }, 'select "id" from "rooms" where "id" = $1', [42]),
      ]);
      const explain = createExplain(driver);

      const analysis = await explain(() => {}, [{ maxCost: 100 }, { maxCost: 100 }]);

      match(analysis.message, /statement 2 of 2/);
      match(analysis.message, /sql: select "id" from "rooms" where "id" = \$1/);
      match(analysis.message, /params: \[42\]/);
      match(analysis.message, /cost 900 exceeds limit 100/);
    });

    test('omits passing statements from the message', async () => {
      const driver = stubDriver([
        statement(node({ cost: 900 }), { raw: true }, 'select "id" from "widgets"'),
        statement(node({ cost: 50 }), { raw: true }, 'select "id" from "rooms"'),
      ]);
      const explain = createExplain(driver);

      const analysis = await explain(() => {}, [{ maxCost: 100 }, { maxCost: 100 }]);

      match(analysis.message, /statement 1 of 2/);
      eq(analysis.message.includes('statement 2 of 2'), false);
    });

    test('reports each statement its own raw vendor plan', async () => {
      const first = [{ Plan: { 'Node Type': 'Seq Scan' } }];
      const second = [{ Plan: { 'Node Type': 'Index Scan' } }];
      const driver = stubDriver([statement(node({ cost: 1 }), first), statement(node({ cost: 1 }), second)]);
      const explain = createExplain(driver);

      const analysis = await explain(() => {}, [{}, {}]);

      eq(analysis.statements[0].plan, first);
      eq(analysis.statements[1].plan, second);
    });

    test('throws when fewer statements were executed than limits supplied', async () => {
      const explain = createExplain(stubDriver([statement(node({}))]));

      await rejects(
        explain(() => {}, [{}, {}]),
        /expected 2 statements \(limits array length\) but 1 were executed/,
      );
    });

    test('throws when more statements were executed than limits supplied', async () => {
      const explain = createExplain(stubDriver([statement(node({})), statement(node({})), statement(node({}))]));

      await rejects(
        explain(() => {}, [{}, {}]),
        /expected 2 statements \(limits array length\) but 3 were executed/,
      );
    });

    test('throws when the array of limits is empty', async () => {
      const explain = createExplain(stubDriver([statement(node({}))]));

      await rejects(
        explain(() => {}, []),
        /at least one set of limits/,
      );
    });

    test('a single set of limits still requires exactly one statement', async () => {
      const explain = createExplain(stubDriver([statement(node({})), statement(node({}))]));

      await rejects(
        explain(() => {}, { maxCost: 100 }),
        /exactly one statement/,
      );
    });
  });

  test('skips a limit the driver cannot supply a signal for', async () => {
    const explain = createExplain(stubDriver([statement(node({ cost: undefined }))]), { maxCost: 1 });

    const analysis = await explain(() => {});

    eq(analysis.passed, true);
  });
});
