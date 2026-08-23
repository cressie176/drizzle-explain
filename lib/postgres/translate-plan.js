function translatePlan(rawPlan) {
  return toPlanNode(rawPlan[0].Plan);
}

function toPlanNode(node) {
  return {
    type: node['Node Type'],
    cost: node['Total Cost'],
    estimatedRows: node['Plan Rows'],
    actualRows: node['Actual Rows'],
    actualTimeMs: node['Actual Total Time'],
    children: toChildren(node.Plans),
  };
}

function toChildren(plans) {
  if (!plans) return [];
  return plans.map(toPlanNode);
}

module.exports = { translatePlan };
