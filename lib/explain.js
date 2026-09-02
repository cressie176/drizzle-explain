const { analysePlan } = require('./analyse-plan');
const { renderPlan, renderStatements } = require('./render-plan');

async function explain(driver, defaults, run, argument) {
  const expectation = createExpectation(defaults, argument);
  const statements = await driver.explain(run);
  expectation.assertStatementCount(statements.length);
  return expectation.report(analyseStatements(statements, expectation.limits), statements);
}

function createExpectation(defaults, argument) {
  if (isExplainOptions(argument)) return optionsExpectation(defaults, argument);
  if (Array.isArray(argument)) return arrayOfLimitsExpectation(defaults, argument);
  return singleStatementExpectation(defaults, argument);
}

function isExplainOptions(argument) {
  if (argument === null || typeof argument !== 'object' || Array.isArray(argument)) return false;
  return 'statements' in argument || 'limits' in argument;
}

function singleStatementExpectation(defaults, overrides) {
  return {
    limits: [mergeLimits(defaults, overrides)],
    assertStatementCount: assertExactlyOne,
    report: ([analysis]) => analysis,
  };
}

function arrayOfLimitsExpectation(defaults, overridesPerStatement) {
  assertLimitsSupplied(overridesPerStatement.length);
  return everyStatementExpectation(overridesPerStatement.map((overrides) => mergeLimits(defaults, overrides)));
}

function optionsExpectation(defaults, { statements, limits }) {
  assertStatementCountIsCountable(statements);
  const source = createLimitsSource(limits);
  const expected = statements ?? source.statementCount ?? 1;
  source.assertGoverns(expected);
  return everyStatementExpectation(mergeEachStatement(defaults, source, expected));
}

function everyStatementExpectation(limits) {
  return {
    limits,
    assertStatementCount: (count) => assertExpectedCount(count, limits.length),
    report: summariseStatements,
  };
}

function mergeEachStatement(defaults, source, expected) {
  return Array.from({ length: expected }, (_, index) => mergeLimits(defaults, source.overridesFor(index)));
}

function createLimitsSource(limits) {
  if (limits === undefined) return defaultsOnlySource();
  if (Array.isArray(limits)) return perStatementSource(limits);
  return oneStatementSource(limits);
}

function defaultsOnlySource() {
  return {
    statementCount: undefined,
    assertGoverns: () => {},
    overridesFor: () => ({}),
  };
}

function perStatementSource(entries) {
  assertLimitsSupplied(entries.length);
  return {
    statementCount: entries.length,
    assertGoverns: (expected) => assertLimitsMatchStatements(entries.length, expected),
    overridesFor: (index) => entries[index],
  };
}

function oneStatementSource(overrides) {
  return {
    statementCount: 1,
    assertGoverns: assertGovernsOneStatement,
    overridesFor: () => overrides,
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
  throw new Error(
    `explain requires exactly one statement per call, but ${count} were executed. If this function legitimately issues several, pass { statements: n }, optionally with one set of limits per statement`,
  );
}

function assertExpectedCount(count, expected) {
  if (count === expected) return;
  throw new Error(`explain expected ${expected} statements but ${count} were executed`);
}

function assertLimitsSupplied(count) {
  if (count > 0) return;
  throw new Error('explain requires at least one set of limits when given an array of limits');
}

function assertStatementCountIsCountable(statements) {
  if (statements === undefined) return;
  if (Number.isInteger(statements) && statements > 0) return;
  throw new Error(`explain requires statements to be a positive integer, but received ${JSON.stringify(statements)}`);
}

function assertLimitsMatchStatements(supplied, expected) {
  if (supplied === expected) return;
  throw new Error(`explain was given ${supplied} sets of limits but statements is ${expected}; they must agree`);
}

function assertGovernsOneStatement(expected) {
  if (expected === 1) return;
  throw new Error(
    `explain cannot apply one set of limits to ${expected} statements; supply one set of limits per statement`,
  );
}

module.exports = { explain };
