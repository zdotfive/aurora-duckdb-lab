-- The "app" side: the last 90 days of orders live in a normal Aurora table.
-- In production the app writes here and CDC ships everything to the lake;
-- a daily job drops partitions older than 90 days. Here we just load it once.
-- TPC-H orders end on 1998-08-02, so 90 days back is 1998-05-04.

CREATE TABLE orders_hot AS
SELECT * FROM ft_orders WHERE o_orderdate >= DATE '1998-05-04';

CREATE INDEX orders_hot_cust_idx ON orders_hot (o_custkey, o_orderdate DESC);
ANALYZE orders_hot;

-- One view for the app. It doesn't know (or care) where each row lives.
CREATE VIEW orders_all AS
SELECT o_orderkey, o_custkey, o_orderstatus, o_totalprice, o_orderdate, 'hot' AS tier
FROM orders_hot
UNION ALL
SELECT o_orderkey, o_custkey, o_orderstatus, o_totalprice, o_orderdate, 'lake' AS tier
FROM ft_orders
WHERE o_orderdate < DATE '1998-05-04';
