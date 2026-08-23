function walkPlanTree(root) {
  const nodes = [];
  collectNodes(root, nodes);
  return nodes;
}

function collectNodes(node, nodes) {
  nodes.push(node);
  for (const child of childrenOf(node)) {
    collectNodes(child, nodes);
  }
}

function childrenOf(node) {
  return node.children ?? [];
}

module.exports = { walkPlanTree };
