-- Foreign tables over the TPC-H Parquet files.
-- Replace <bucket> with the BucketName output of the stack and the region with yours.
-- Empty column list = Aurora infers the schema from the Parquet footer.

CREATE EXTENSION IF NOT EXISTS aurora_analytics;

-- The default (~4 GB on an xlarge) made the engine run on a single thread for me.
-- With 12 GB it used all 4 vCPUs and Q1 went from 3.3 s to 1.2 s.
ALTER DATABASE lab SET aurora_analytics.query_mem = '12GB';

-- Always set `region`. Without it Aurora asks the global S3 endpoint where the bucket
-- lives, and from a private subnet with only the S3 gateway endpoint that times out.
CREATE FOREIGN TABLE ft_lineitem ()
SERVER aurora_analytics_server
OPTIONS (location 's3://<bucket>/tpch/sf10/flat/lineitem/', format 'parquet', region 'eu-central-1');

CREATE FOREIGN TABLE ft_orders ()
SERVER aurora_analytics_server
OPTIONS (location 's3://<bucket>/tpch/sf10/flat/orders/', format 'parquet', region 'eu-central-1');

CREATE FOREIGN TABLE ft_customer ()
SERVER aurora_analytics_server
OPTIONS (location 's3://<bucket>/tpch/sf10/flat/customer/', format 'parquet', region 'eu-central-1');

-- Same lineitem, hive-partitioned by ship_year. A plain folder is not read recursively,
-- so point at a glob. ship_year shows up as a column and is used to skip files.
CREATE FOREIGN TABLE ft_lineitem_by_year ()
SERVER aurora_analytics_server
OPTIONS (location 's3://<bucket>/tpch/sf10/partitioned/lineitem/*/*.parquet', format 'parquet', region 'eu-central-1');
