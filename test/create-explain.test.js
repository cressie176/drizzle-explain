const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { createExplain } = require('../lib');

function stubDriver(statements) {
  return { explain: async () => statements };
}

function statement(root, plan = { raw: true }) {
  return { plan, root };
}

function node(overrides) {
  return { type: 'Seq Scan', children: [], ...overrides };
}

describe('createExplain', () => {
  test('passes when the plan is within the merged limits', async () => {
    const explain = createExplain(stubDriver([statement(node({ cost: 50 }))]), { maxCost: 100 });

    const analysis = await explain(() => {});

    assert.equal(analysis.passed, true);
    assert.equal(analysis.message, '');
  });

  test('fails and renders the annotated plan when a limit is breached', async () => {
    const explain = createExplain(stubDriver([statement(node({ cost: 62431 }))]), { maxCost: 100 });

    const analysis = await explain(() => {});

    assert.equal(analysis.passed, false);
    assert.match(analysis.message, /cost 62431 exceeds limit 100/);
  });

  test('exposes the effective limits after merging overrides over defaults', async () => {
    const explain = createExplain(stubDriver([statement(node({ cost: 10 }))]), {
      maxCost: 100,
      rowEstimateTolerance: 10,
    });

    const analysis = await explain(() => {}, { maxCost: 500 });

    assert.deepEqual(analysis.limits, { maxCost: 500, rowEstimateTolerance: 10 });
  });

  test('reports the raw, unmodified vendor plan', async () => {
    const rawPlan = [{ Plan: { 'Node Type': 'Seq Scan' } }];
    const explain = createExplain(stubDriver([statement(node({ cost: 10 }), rawPlan)]));

    const analysis = await explain(() => {});

    assert.equal(analysis.plan, rawPlan);
  });

  test('throws when the callback executes no statement', async () => {
    const explain = createExplain(stubDriver([]));

    await assert.rejects(
      explain(() => {}),
      /exactly one statement/,
    );
  });

  test('throws when the callback executes more than one statement', async () => {
    const explain = createExplain(stubDriver([statement(node({})), statement(node({}))]));

    await assert.rejects(
      explain(() => {}),
      /exactly one statement/,
    );
  });

  test('does not throw on a breached plan — it reports', async () => {
    const explain = createExplain(stubDriver([statement(node({ cost: 999 }))]), { maxCost: 1 });

    const analysis = await explain(() => {});

    assert.equal(analysis.passed, false);
  });

  test('skips a limit the driver cannot supply a signal for', async () => {
    const explain = createExplain(stubDriver([statement(node({ cost: undefined }))]), { maxCost: 1 });

    const analysis = await explain(() => {});

    assert.equal(analysis.passed, true);
  });
});
