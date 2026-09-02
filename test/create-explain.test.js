const { equal: eq, deepEqual: deq, match, rejects } = require('node:assert/strict');
const { describe, test } = require('node:test');
const { createExplain } = require('../lib');

function stubDriver(statements) {
  return { explain: async () => statements };
}

function countingDriver(statements) {
  const driver = { runs: 0 };
  driver.explain = async () => {
    driver.runs += 1;
    return statements;
  };
  return driver;
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
        /expected 2 statements but 1 were executed/,
      );
    });

    test('throws when more statements were executed than limits supplied', async () => {
      const explain = createExplain(stubDriver([statement(node({})), statement(node({})), statement(node({}))]));

      await rejects(
        explain(() => {}, [{}, {}]),
        /expected 2 statements but 3 were executed/,
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

  describe('an options object', () => {
    test('checks every statement against the defaults when only a count is given', async () => {
      const driver = stubDriver([
        statement(node({ cost: 10 })),
        statement(node({ cost: 10 })),
        statement(node({ cost: 10 })),
      ]);
      const explain = createExplain(driver, { maxCost: 100 });

      const analysis = await explain(() => {}, { statements: 3 });

      eq(analysis.passed, true);
      eq(analysis.statements.length, 3);
      deq(
        analysis.statements.map((each) => each.limits),
        [{ maxCost: 100 }, { maxCost: 100 }, { maxCost: 100 }],
      );
    });

    test('pairs an array of limits with the statements in the same position', async () => {
      const driver = stubDriver([statement(node({ cost: 50 })), statement(node({ cost: 300 }))]);
      const explain = createExplain(driver);

      const analysis = await explain(() => {}, { statements: 2, limits: [{ maxCost: 100 }, { maxCost: 500 }] });

      eq(analysis.passed, true);
      deq(
        analysis.statements.map((each) => each.limits),
        [{ maxCost: 100 }, { maxCost: 500 }],
      );
    });

    test('infers the count from an array of limits when no count is given', async () => {
      const driver = stubDriver([statement(node({ cost: 1 })), statement(node({ cost: 1 }))]);
      const explain = createExplain(driver);

      const analysis = await explain(() => {}, { limits: [{ maxCost: 100 }, { maxCost: 500 }] });

      eq(analysis.statements.length, 2);
    });

    test('returns a multi-statement analysis even for a single statement', async () => {
      const explain = createExplain(stubDriver([statement(node({ cost: 50 }))]));

      const analysis = await explain(() => {}, { limits: { maxCost: 100 } });

      eq(analysis.statements.length, 1);
      deq(analysis.statements[0].limits, { maxCost: 100 });
    });

    test('accepts one set of limits alongside a count of one', async () => {
      const explain = createExplain(stubDriver([statement(node({ cost: 50 }))]));

      const analysis = await explain(() => {}, { statements: 1, limits: { maxCost: 100 } });

      eq(analysis.passed, true);
      eq(analysis.statements.length, 1);
    });

    test('fails when any statement breaches its limits', async () => {
      const driver = stubDriver([statement(node({ cost: 50 })), statement(node({ cost: 900 }))]);
      const explain = createExplain(driver, { maxCost: 100 });

      const analysis = await explain(() => {}, { statements: 2 });

      eq(analysis.passed, false);
      match(analysis.message, /statement 2 of 2/);
    });

    test('throws when the callback executes a different number of statements', async () => {
      const explain = createExplain(stubDriver([statement(node({})), statement(node({}))]));

      await rejects(
        explain(() => {}, { statements: 3 }),
        /expected 3 statements but 2 were executed/,
      );
    });

    test('throws when the count and the array of limits disagree', async () => {
      const driver = countingDriver([statement(node({}))]);
      const explain = createExplain(driver);

      await rejects(
        explain(() => {}, { statements: 3, limits: [{}, {}] }),
        /given 2 sets of limits but statements is 3; they must agree/,
      );
      eq(driver.runs, 0);
    });

    test('throws rather than applying one set of limits to several statements', async () => {
      const driver = countingDriver([statement(node({}))]);
      const explain = createExplain(driver);

      await rejects(
        explain(() => {}, { statements: 3, limits: { maxCost: 100 } }),
        /cannot apply one set of limits to 3 statements/,
      );
      eq(driver.runs, 0);
    });

    test('throws when the array of limits is empty', async () => {
      const driver = countingDriver([statement(node({}))]);
      const explain = createExplain(driver);

      await rejects(
        explain(() => {}, { limits: [] }),
        /at least one set of limits/,
      );
      eq(driver.runs, 0);
    });

    for (const statements of [0, -1, 1.5, '2', null]) {
      test(`throws when the count is ${JSON.stringify(statements)}`, async () => {
        const driver = countingDriver([statement(node({}))]);
        const explain = createExplain(driver);

        await rejects(
          explain(() => {}, { statements }),
          /statements to be a positive integer/,
        );
        eq(driver.runs, 0);
      });
    }
  });

  test('skips a limit the driver cannot supply a signal for', async () => {
    const explain = createExplain(stubDriver([statement(node({ cost: undefined }))]), { maxCost: 1 });

    const analysis = await explain(() => {});

    eq(analysis.passed, true);
  });
});
