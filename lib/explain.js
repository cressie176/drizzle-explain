const { analysePlan } = require('./analyse-plan');
const { renderPlan } = require('./render-plan');

async function explain(driver, defaults, run, overrides) {
  const limits = mergeLimits(defaults, overrides);
  const statement = await captureSingleStatement(driver, run);
  const result = analysePlan(statement.root, limits);
  return toAnalysis(result, statement, limits);
}

function mergeLimits(defaults, overrides) {
  return { ...defaults, ...overrides };
}

async function captureSingleStatement(driver, run) {
  const statements = await driver.explain(run);
  assertExactlyOne(statements.length);
  return statements[0];
}

function assertExactlyOne(count) {
  if (count === 1) return;
  throw new Error(`explain requires exactly one statement per call, but ${count} were executed`);
}

function toAnalysis(result, statement, limits) {
  return {
    passed: result.passed,
    message: renderPlan(statement.root, result),
    limits,
    plan: statement.plan,
  };
}

module.exports = { explain };
