export enum Operation {
  SEQ_SCAN = 'SEQ_SCAN',
  INDEX_SCAN = 'INDEX_SCAN',
  BITMAP_SCAN = 'BITMAP_SCAN',
  NESTED_LOOP = 'NESTED_LOOP',
  HASH_JOIN = 'HASH_JOIN',
  MERGE_JOIN = 'MERGE_JOIN',
  SORT = 'SORT',
  AGGREGATE = 'AGGREGATE',
  OTHER = 'OTHER',
}

export interface PlanNode {
  type: string;
  operation?: Operation;
  relation?: string;
  alias?: string;
  cost?: number;
  estimatedRows?: number;
  actualRows?: number;
  scanned?: number;
  loops?: number;
  actualTimeMs?: number;
  children: PlanNode[];
}

export interface OperationExemption {
  operation: Operation;
  relation?: string;
  maxScanned?: number;
  maxActualRows?: number;
}

export interface Limits {
  maxCost?: number;
  rowEstimateTolerance?: number;
  disallowOperations?: Operation[];
  /**
   * Lifts a `disallowOperations` ban on the nodes an entry matches. An entry must name an
   * operation and at least one condition, so it states which nodes it covers.
   *
   * Passing a bare `Operation` lifts the ban across the whole plan. It is deprecated because a
   * query that later gains a join carries the exemption onto the new table silently. Scope the
   * entry with `relation`, `maxScanned` or `maxActualRows` instead. Removed in 2.0.
   */
  allowOperations?: (Operation | OperationExemption)[];
}

export interface Analysis {
  passed: boolean;
  message: string;
  limits: Limits;
  plan: object;
}

export interface MultiStatementAnalysis {
  passed: boolean;
  message: string;
  statements: Analysis[];
}

export interface ExplainedStatement {
  sql: string;
  params: unknown[];
  plan: object;
  root: PlanNode;
}

export interface Driver<TDatabase = unknown> {
  explain(run: (db: TDatabase) => unknown): Promise<ExplainedStatement[]>;
}

export type QueryFunction<TDatabase, TQuery> = (db: TDatabase) => TQuery;

/**
 * How many statements the callback is expected to execute, and the limits each
 * one is checked against. Supply `statements`, `limits`, or both; when both are
 * given they must agree, and one set of limits can only govern one statement.
 */
export type ExplainOptions =
  | { statements: number; limits?: Limits | Limits[] }
  | { statements?: number; limits: Limits | Limits[] };

export interface ExplainFunction<TDatabase> {
  (run: QueryFunction<TDatabase, unknown>): Promise<Analysis>;
  (run: QueryFunction<TDatabase, unknown>, options: ExplainOptions): Promise<MultiStatementAnalysis>;
  /** @deprecated Pass `{ limits: [...] }` instead. Removed in 2.0. */
  (run: QueryFunction<TDatabase, unknown>, overrides: Limits[]): Promise<MultiStatementAnalysis>;
  /** @deprecated Pass `{ limits: { ... } }` instead. Removed in 2.0. */
  (run: QueryFunction<TDatabase, unknown>, overrides: Limits): Promise<Analysis>;
}

export function createExplain<TDatabase>(driver: Driver<TDatabase>, defaults?: Limits): ExplainFunction<TDatabase>;
