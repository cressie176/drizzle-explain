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

export interface ExplainedStatement {
  plan: object;
  root: PlanNode;
}

export interface Driver<TDatabase = unknown> {
  explain(run: (db: TDatabase) => unknown): Promise<ExplainedStatement[]>;
}

export type QueryFunction<TDatabase, TQuery> = (db: TDatabase) => TQuery;

export type ExplainFunction<TDatabase> = (
  run: QueryFunction<TDatabase, unknown>,
  overrides?: Limits,
) => Promise<Analysis>;

export function createExplain<TDatabase>(driver: Driver<TDatabase>, defaults?: Limits): ExplainFunction<TDatabase>;
