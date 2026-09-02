const useColour = () => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return !process.env.CI && Boolean(process.stdout.isTTY);
};
const red = (text) => (useColour() ? `\x1b[31m${text}\x1b[0m` : text);

const summaryFormatters = {
  maxCost: (breach) => red(`✘ cost ${breach.observed} exceeds limit ${breach.threshold}`),
  rowEstimateTolerance: (breach) => red(`✘ row estimate ${breach.observed}x off, limit ${breach.threshold}`),
  disallowOperations: (breach) => red(`✘ disallowed operation: ${describeNode(breach.node)}`),
};

const annotationFormatters = {
  maxCost: (breach) => red(`✘ cost ${breach.observed} > ${breach.threshold}`),
  rowEstimateTolerance: (breach) => red(`✘ ${breach.observed}x off, limit ${breach.threshold}`),
  disallowOperations: (breach) => red(`✘ ${breach.node.type} not allowed`),
};

const metricFields = [
  { read: (node) => node.cost, format: (value) => `cost=${value}` },
  { read: (node) => node.estimatedRows, format: (value) => `estimated=${value}` },
  { read: (node) => node.actualRows, format: (value) => `actual=${value}` },
  { read: (node) => node.scanned, format: (value) => `scanned=${value}` },
  { read: (node) => node.actualTimeMs, format: (value) => `time=${value}ms` },
];

function describeNode(node) {
  return `${node.type}${renderRelation(node)}`;
}

function renderRelation(node) {
  if (!isPresent(node.relation)) return '';
  return ` on ${[node.relation, node.alias].filter(isPresent).join(' ')}`;
}

const isPresent = (value) => value !== undefined && value !== null;

function renderSummary(breaches) {
  return breaches.map((breach) => summaryFormatters[breach.limit](breach)).join('\n');
}

function groupAnnotationsByNode(breaches) {
  const annotationsByNode = new Map();
  for (const breach of breaches) {
    const annotations = annotationsByNode.get(breach.node) ?? [];
    annotations.push(annotationFormatters[breach.limit](breach));
    annotationsByNode.set(breach.node, annotations);
  }
  return annotationsByNode;
}

function renderMetrics(node) {
  const parts = metricFields
    .filter((field) => isPresent(field.read(node)))
    .map((field) => field.format(field.read(node)));
  return parts.length === 0 ? '' : `  (${parts.join(' ')})`;
}

function renderNodeLine(node, depth, annotationsByNode) {
  const indent = '  '.repeat(depth);
  const line = `${indent}${describeNode(node)}${renderMetrics(node)}`;
  const annotations = annotationsByNode.get(node) ?? [];
  return annotations.reduce((annotated, annotation) => `${annotated}  ${annotation}`, line);
}

function renderTree(root, annotationsByNode) {
  const lines = [];
  const visit = (node, depth) => {
    lines.push(renderNodeLine(node, depth, annotationsByNode));
    for (const child of node.children) visit(child, depth + 1);
  };
  visit(root, 0);
  return lines.join('\n');
}

function renderPlan(root, analysis) {
  if (analysis.passed) return '';
  const summary = renderSummary(analysis.breaches);
  const tree = renderTree(root, groupAnnotationsByNode(analysis.breaches));
  return `${summary}\n\n${tree}`;
}

function renderStatementHeader(statement, position, total) {
  return `statement ${position} of ${total}\n  sql: ${statement.sql}\n  params: ${JSON.stringify(statement.params)}`;
}

function renderStatementSection({ analysis, header }) {
  return `${header}\n\n${analysis.message}`;
}

function renderStatements(analyses, statements) {
  return analyses
    .map((analysis, index) => ({
      analysis,
      header: renderStatementHeader(statements[index], index + 1, analyses.length),
    }))
    .filter((section) => !section.analysis.passed)
    .map(renderStatementSection)
    .join('\n\n');
}

module.exports = { renderPlan, renderStatements };
