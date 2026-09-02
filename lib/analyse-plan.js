const { Operation } = require('./operation');
const { walkPlanTree } = require('./plan-tree-walk');

function analysePlan(root, limits) {
  assertOperationsAreRecognised(limits.disallowOperations, limits.allowOperations);
  assertConditionsAreRecognised(limits.allowOperations);
  const judged = judgeOperations(root, limits.disallowOperations, limits.allowOperations);
  const breaches = [
    ...maxCostBreaches(root, limits.maxCost),
    ...rowEstimateBreaches(root, limits.rowEstimateTolerance),
    ...judged.breaches,
  ];
  return { passed: breaches.length === 0, breaches, exemptions: judged.exemptions };
}

function assertOperationsAreRecognised(disallow, allow) {
  for (const operation of disallow ?? []) assertIsAnOperation(operation, 'disallowOperations');
  for (const entry of allow ?? []) assertIsAnOperation(asExemption(entry).operation, 'allowOperations');
}

function assertIsAnOperation(operation, limit) {
  if (Object.values(Operation).includes(operation)) return;
  throw new Error(
    `${limit} received an unrecognised operation: ${JSON.stringify(operation)}. Supported operations are ${Object.values(Operation).join(', ')}`,
  );
}

function judgeOperations(root, disallow, allow) {
  const judgements = disallowedNodes(root, disallow).map((node) => ({ node, exemption: exemptionFor(node, allow) }));
  return {
    breaches: judgements.filter(isNotExempt).map((judgement) => toOperationBreach(judgement, disallow)),
    exemptions: judgements.filter(isExempt),
  };
}

function disallowedNodes(root, disallow) {
  if (!isApplicable(disallow)) return [];
  return walkPlanTree(root)
    .filter((node) => isApplicable(node.operation))
    .filter((node) => disallow.includes(node.operation));
}

function exemptionFor(node, allow) {
  if (!isApplicable(allow)) return undefined;
  return allow.find((entry) => exempts(entry, node));
}

function exempts(entry, node) {
  return conditionsOf(entry).every((matches) => matches(node));
}

function assertConditionsAreRecognised(allow) {
  for (const entry of allow ?? []) conditionsOf(entry);
}

function conditionsOf(entry) {
  const conditions = asExemption(entry);
  assertConditionsAreSupported(conditions);
  return Object.entries(conditions).map(([key, value]) => conditionsByKey[key](value));
}

function asExemption(entry) {
  if (typeof entry !== 'object' || entry === null) return { operation: entry };
  assertNamesAnOperation(entry);
  assertScopesTheBan(entry);
  return entry;
}

const conditionsByKey = {
  operation: (value) => (node) => node.operation === value,
  relation: (value) => (node) => node.relation === value,
  maxScanned: (value) => (node) => isApplicable(node.scanned) && node.scanned <= value,
  maxActualRows: (value) => (node) => isApplicable(node.actualRows) && node.actualRows <= value,
};

function scopingConditions() {
  return Object.keys(conditionsByKey).filter((key) => key !== 'operation');
}

function assertConditionsAreSupported(conditions) {
  const unsupported = Object.keys(conditions).filter((key) => !(key in conditionsByKey));
  if (unsupported.length === 0) return;
  throw new Error(
    `allowOperations received unknown conditions: ${unsupported.join(', ')}. Supported conditions are ${Object.keys(conditionsByKey).join(', ')}`,
  );
}

function assertScopesTheBan(entry) {
  if (Object.keys(entry).some((key) => key !== 'operation')) return;
  throw new Error(
    `allowOperations entry for ${entry.operation} names no condition, so it would lift the ban across the whole plan. Scope it with ${scopingConditions().join(', ')}`,
  );
}

function assertNamesAnOperation(entry) {
  if (isApplicable(entry.operation)) return;
  throw new Error(
    'allowOperations requires every entry to name an operation, so a condition cannot lift a ban on its own',
  );
}

function isExempt(judgement) {
  return isApplicable(judgement.exemption);
}

function isNotExempt(judgement) {
  return !isExempt(judgement);
}

function toOperationBreach({ node }, disallow) {
  return { node, limit: 'disallowOperations', threshold: disallow, observed: node.operation };
}

function maxCostBreaches(root, threshold) {
  if (!isApplicable(threshold)) return [];
  if (!isApplicable(root.cost)) return [];
  if (root.cost <= threshold) return [];
  return [{ node: root, limit: 'maxCost', threshold, observed: root.cost }];
}

function rowEstimateBreaches(root, threshold) {
  if (!isApplicable(threshold)) return [];
  const worst = worstDivergence(root);
  if (!worst) return [];
  if (worst.observed <= threshold) return [];
  return [{ node: worst.node, limit: 'rowEstimateTolerance', threshold, observed: worst.observed }];
}

function worstDivergence(root) {
  return walkPlanTree(root).map(divergenceOf).filter(Boolean).reduce(keepLarger, undefined);
}

function divergenceOf(node) {
  if (!hasBothRowCounts(node)) return undefined;
  if (producesZeroRows(node)) return undefined;
  return { node, observed: divergenceRatio(node.estimatedRows, node.actualRows) };
}

function divergenceRatio(estimated, actual) {
  return Math.round(Math.max(estimated, actual) / Math.min(estimated, actual));
}

function keepLarger(current, candidate) {
  if (!current) return candidate;
  if (candidate.observed > current.observed) return candidate;
  return current;
}

function hasBothRowCounts(node) {
  return isApplicable(node.estimatedRows) && isApplicable(node.actualRows);
}

function producesZeroRows(node) {
  return node.estimatedRows === 0 || node.actualRows === 0;
}

function isApplicable(value) {
  return value !== undefined && value !== null;
}

module.exports = { analysePlan };
