function translatePlan(plan) {
  return translateQueryBlock(plan.query_block);
}

function translateQueryBlock(queryBlock) {
  return buildNode('Query Block', queryBlock, childrenOf(queryBlock));
}

function translateTable(table) {
  return buildNode(tableType(table), table, childrenOf(table));
}

function tableType(table) {
  return [table.access_type, table.table_name].filter(Boolean).join(' ') || 'Table';
}

function childrenOf(source) {
  return Object.keys(source)
    .filter((key) => key in childBuilders)
    .flatMap((key) => childBuilders[key](source[key]));
}

const childBuilders = {
  table: (value) => [translateTable(value)],
  nested_loop: (value) => value.flatMap(childrenOf),
  'block-nested-loop': (value) => value.flatMap(childrenOf),
  query_block: (value) => [translateQueryBlock(value)],
  materialized: (value) => childrenOf(value),
  duplicates_removal: (value) => childrenOf(value),
  union_result: (value) => childrenOf(value),
  query_specifications: (value) => value.flatMap(childrenOf),
};

function buildNode(type, source, children) {
  const node = { type, children };
  assignNumber(node, 'estimatedRows', source.rows);
  assignNumber(node, 'actualRows', source.r_rows);
  assignNumber(node, 'actualTimeMs', actualTime(source));
  return node;
}

function actualTime(source) {
  return source.r_total_time_ms ?? source.r_table_time_ms;
}

function assignNumber(node, key, value) {
  if (typeof value !== 'number') return;
  node[key] = value;
}

module.exports = { translatePlan };
