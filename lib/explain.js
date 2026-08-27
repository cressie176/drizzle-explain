const { analysePlan } = require('./analyse-plan');
const { renderPlan, renderStatements } = require('./render-plan');

async function explain(driver, defaults, run, overrides) {
  const expectation = createExpectation(defaults, overrides);
  const statements = await driver.explain(run);
  expectation.assertStatementCount(statements.length);
  return expectation.report(analyseStatements(statements, expectation.limits), statements);
}

function createExpectation(defaults, overrides) {
  if (Array.isArray(overrides)) return everyStatementExpectation(defaults, overrides);
  return singleStatementExpectation(defaults, overrides);
}

function singleStatementExpectation(defaults, overrides) {
  return {
    limits: [mergeLimits(defaults, overrides)],
    assertStatementCount: assertExactlyOne,
    report: ([analysis]) => analysis,
  };
}

function everyStatementExpectation(defaults, overridesPerStatement) {
  assertLimitsSupplied(overridesPerStatement.length);
  const limits = overridesPerStatement.map((overrides) => mergeLimits(defaults, overrides));
  return {
    limits,
    assertStatementCount: (count) => assertExpectedCount(count, limits.length),
    report: summariseStatements,
  };
}

function analyseStatements(statements, limits) {
  return statements.map((statement, index) => analyseStatement(statement, limits[index]));
}

function analyseStatement(statement, limits) {
  const result = analysePlan(statement.root, limits);
  return {
    passed: result.passed,
    message: renderPlan(statement.root, result),
    limits,
    plan: statement.plan,
  };
}

function summariseStatements(analyses, statements) {
  return {
    passed: analyses.every((analysis) => analysis.passed),
    message: renderStatements(analyses, statements),
    statements: analyses,
  };
}

function mergeLimits(defaults, overrides) {
  return { ...defaults, ...overrides };
}

function assertExactlyOne(count) {
  if (count === 1) return;
  throw new Error(`explain requires exactly one statement per call, but ${count} were executed`);
}

function assertExpectedCount(count, expected) {
  if (count === expected) return;
  throw new Error(`explain expected ${expected} statements (limits array length) but ${count} were executed`);
}

function assertLimitsSupplied(count) {
  if (count > 0) return;
  throw new Error('explain requires at least one set of limits when given an array of limits');
}

module.exports = { explain };
