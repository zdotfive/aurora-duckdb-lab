"""Generate TPC-H with DuckDB and write it as Parquet.

Runs inside the CodeBuild job created by the stack, but works the same on a laptop:
    SF=1 python scripts/gen_tpch.py && aws s3 sync out/ s3://<bucket>/tpch/sf1/
"""
import os
import time

import duckdb

sf = float(os.environ.get("SF", "1"))
os.makedirs("out/flat", exist_ok=True)
os.makedirs("out/partitioned", exist_ok=True)

con = duckdb.connect("tpch.duckdb")
con.execute("INSTALL tpch; LOAD tpch;")

start = time.time()
con.execute(f"CALL dbgen(sf={sf})")
print(f"dbgen sf={sf} took {time.time() - start:.1f}s")

# one folder per table, files rotated at ~256 MB
for (table,) in con.execute("SHOW TABLES").fetchall():
    con.execute(f"COPY {table} TO 'out/flat/{table}' (FORMAT parquet, FILE_SIZE_BYTES '256MB')")

# same lineitem, hive-partitioned by ship year, to see if partition pruning kicks in
con.execute("""
    COPY (SELECT *, year(l_shipdate) AS ship_year FROM lineitem)
    TO 'out/partitioned/lineitem' (FORMAT parquet, PARTITION_BY (ship_year))
""")
print("done")
