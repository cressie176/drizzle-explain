const { Operation } = require('../operation');

function translatePlan(rawPlan) {
  return toPlanNode(rawPlan[0].Plan);
}

function toPlanNode(node) {
  const planNode = {
    type: node['Node Type'],
    cost: node['Total Cost'],
    estimatedRows: node['Plan Rows'],
    actualRows: node['Actual Rows'],
    actualTimeMs: node['Actual Total Time'],
    children: toChildren(node.Plans),
  };
  const operation = operationOf(node['Node Type']);
  if (operation) planNode.operation = operation;
  assign(planNode, 'relation', node['Relation Name']);
  assign(planNode, 'alias', aliasOf(node));
  assign(planNode, 'loops', node['Actual Loops']);
  assign(planNode, 'scanned', scannedBy(node));
  return planNode;
}

function aliasOf(node) {
  if (node.Alias === node['Relation Name']) return undefined;
  return node.Alias;
}

function scannedBy(node) {
  if (!node['Relation Name']) return undefined;
  if (typeof node['Actual Rows'] !== 'number') return undefined;
  return Math.round((node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * loopsOf(node));
}

function loopsOf(node) {
  if (typeof node['Actual Loops'] !== 'number') return 1;
  return node['Actual Loops'];
}

function assign(node, key, value) {
  if (value === undefined || value === null) return;
  node[key] = value;
}

const operationsByNodeType = {
  'Seq Scan': Operation.SEQ_SCAN,
  'Index Scan': Operation.INDEX_SCAN,
  'Index Only Scan': Operation.INDEX_SCAN,
  'Bitmap Heap Scan': Operation.BITMAP_SCAN,
  'Bitmap Index Scan': Operation.BITMAP_SCAN,
  'Nested Loop': Operation.NESTED_LOOP,
  'Hash Join': Operation.HASH_JOIN,
  'Merge Join': Operation.MERGE_JOIN,
  Sort: Operation.SORT,
  Aggregate: Operation.AGGREGATE,
};

function operationOf(nodeType) {
  return operationsByNodeType[nodeType];
}

function toChildren(plans) {
  if (!plans) return [];
  return plans.map(toPlanNode);
}

module.exports = { translatePlan };
