CREATE TABLE IF NOT EXISTS __CLICKHOUSE_DATABASE__.events (
  event_id String,
  project_id String,
  group_id String,
  fingerprint String,
  title String,
  message String,
  severity LowCardinality(String),
  timestamp DateTime64(3, 'UTC'),
  release String,
  environment LowCardinality(String),
  user_id String,
  browser String,
  device String,
  os String,
  runtime String,
  tags String,
  contexts String,
  exception String,
  stacktrace String,
  raw_payload String
) ENGINE = MergeTree()
ORDER BY (project_id, group_id, timestamp, event_id);

CREATE TABLE IF NOT EXISTS __CLICKHOUSE_DATABASE__.breadcrumbs (
  event_id String,
  project_id String,
  group_id String,
  timestamp DateTime64(3, 'UTC'),
  category LowCardinality(String),
  level LowCardinality(String),
  message String,
  type LowCardinality(String),
  data String
) ENGINE = MergeTree()
ORDER BY (project_id, group_id, event_id, timestamp);

CREATE TABLE IF NOT EXISTS __CLICKHOUSE_DATABASE__.project_daily_metrics (
  project_id String,
  day Date,
  total_events AggregateFunction(count),
  impacted_users AggregateFunction(uniq, String)
) ENGINE = AggregatingMergeTree()
ORDER BY (project_id, day);

CREATE MATERIALIZED VIEW IF NOT EXISTS __CLICKHOUSE_DATABASE__.project_daily_metrics_mv
TO __CLICKHOUSE_DATABASE__.project_daily_metrics AS
SELECT
  project_id,
  toDate(timestamp) AS day,
  countState() AS total_events,
  uniqState(user_id) AS impacted_users
FROM __CLICKHOUSE_DATABASE__.events
GROUP BY project_id, day;
