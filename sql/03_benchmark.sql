-- Every query is run with EXPLAIN (ANALYZE) so the timing comes from the server,
-- not from the client. First run = cold (nothing in the local cache), then 2 warm runs.

-- B1. "Customer card": what an API endpoint would ask. Last 20 orders of one customer,
--     across hot (Aurora) and lake (S3). 693448 has 8 orders in the hot table, the rest in the lake.
SELECT o_orderkey, o_orderdate, o_totalprice, o_orderstatus, tier
FROM orders_all
WHERE o_custkey = 693448
ORDER BY o_orderdate DESC
LIMIT 20;

-- B2. Same customer, hot rows only. The baseline an app gets today.
SELECT o_orderkey, o_orderdate, o_totalprice, o_orderstatus
FROM orders_hot
WHERE o_custkey = 693448
ORDER BY o_orderdate DESC
LIMIT 20;

-- B3. TPC-H Q1 on 60M lineitem rows straight from S3 (full scan, heavy aggregation).
SELECT l_returnflag, l_linestatus,
       sum(l_quantity) AS sum_qty,
       sum(l_extendedprice) AS sum_base_price,
       sum(l_extendedprice * (1 - l_discount)) AS sum_disc_price,
       avg(l_discount) AS avg_disc,
       count(*) AS count_order
FROM ft_lineitem
WHERE l_shipdate <= DATE '1998-09-02'
GROUP BY l_returnflag, l_linestatus
ORDER BY l_returnflag, l_linestatus;

-- B4. One year of lineitem: flat files vs hive partitions (does pruning help?)
SELECT count(*), sum(l_extendedprice) FROM ft_lineitem
WHERE l_shipdate >= DATE '1995-01-01' AND l_shipdate < DATE '1996-01-01';

SELECT count(*), sum(l_extendedprice) FROM ft_lineitem_by_year
WHERE ship_year = 1995;

-- B5. Join Aurora table with the lake: revenue of this quarter's active customers
--     over their whole history.
SELECT c.c_mktsegment, count(DISTINCT h.o_custkey) AS customers, sum(l.o_totalprice) AS lifetime_revenue
FROM (SELECT DISTINCT o_custkey FROM orders_hot) h
JOIN ft_orders l ON l.o_custkey = h.o_custkey
JOIN ft_customer c ON c.c_custkey = h.o_custkey
GROUP BY c.c_mktsegment
ORDER BY lifetime_revenue DESC;

-- B6. Materialize from the lake into Aurora (this is what replaces an ETL job)
CREATE TABLE customer_lifetime AS
SELECT o_custkey, count(*) AS orders, sum(o_totalprice) AS revenue, max(o_orderdate) AS last_order
FROM ft_orders
GROUP BY o_custkey;
