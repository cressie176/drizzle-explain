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
  cost?: number;
  estimatedRows?: number;
  actualRows?: number;
  actualTimeMs?: number;
  children: PlanNode[];
}

export interface Limits {
  maxCost?: number;
  rowEstimateTolerance?: number;
  disallowOperations?: Operation[];
  allowOperations?: Operation[];
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
