const { walkPlanTree } = require('./plan-tree-walk');

function analysePlan(root, limits) {
  const breaches = [
    ...maxCostBreaches(root, limits.maxCost),
    ...rowEstimateBreaches(root, limits.rowEstimateTolerance),
  ];
  return { passed: breaches.length === 0, breaches };
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
