const Operation = Object.freeze({
  SEQ_SCAN: 'SEQ_SCAN',
  INDEX_SCAN: 'INDEX_SCAN',
  BITMAP_SCAN: 'BITMAP_SCAN',
  NESTED_LOOP: 'NESTED_LOOP',
  HASH_JOIN: 'HASH_JOIN',
  MERGE_JOIN: 'MERGE_JOIN',
  SORT: 'SORT',
  AGGREGATE: 'AGGREGATE',
  OTHER: 'OTHER',
});

module.exports = { Operation };
