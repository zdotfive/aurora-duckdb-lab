# aurora-duckdb-lab

Aurora PostgreSQL can now query Parquet and Iceberg files on S3 directly, through the
`aurora_analytics` extension. Under the hood the analytical part of the query runs on DuckDB,
embedded in the Postgres process.

I wanted to know if this is good enough to put an application on top of it: keep the last
90 days in Aurora, leave years of history in the lake, and expose both through one SQL view.
This repo is the lab I used to measure it. Everything is in one CDK stack and goes away with
one command.

The write-up with the numbers is here: _link to the article, coming soon_.

## What gets deployed

- A VPC with two private subnets and an S3 gateway endpoint. No NAT, no public IPs.
- An S3 bucket used as the lake.
- Aurora PostgreSQL 17.11, one `db.r8gd.xlarge` writer (the "d" means local NVMe, used by the S3 read cache),
  a custom cluster parameter group with `aurora_analytics.enabled = true`, and the Data API turned on.
- An IAM role attached to the cluster with the `AuroraAnalytics` feature name, read-only on the bucket.
- A CodeBuild project that generates TPC-H with DuckDB and writes Parquet to the bucket.

The stack uses `LegacyStackSynthesizer` and has no assets, so it deploys with the credentials of
your CLI profile: you don't need `cdk bootstrap` and nothing is left in the account after `cdk destroy`.

```
cdk/         CDK app (TypeScript)
scripts/     gen_tpch.py (data generation), teardown.sh
sql/         foreign tables, hot/cold setup, benchmark queries
results/     numbers from my runs
```

## Run it

You need Node 20+, the AWS CLI and a profile with admin-ish rights in a region where
Aurora PostgreSQL 17.11 is available.

```bash
cd cdk
npm install
npx cdk deploy                          # ~15 min, mostly the Aurora instance
npx cdk deploy -c sf=1                  # smaller dataset if you just want to try it
npx cdk deploy -c instanceClass=r8gd.2xlarge
```

Generate the data (SF10 is about 5.6 GB of Parquet and takes ~5 minutes):

```bash
aws codebuild start-build --project-name <DatagenProject output>
```

Then run the files in `sql/` in order. The cluster is private, so the easiest way in is the
Data API:

```bash
aws rds-data execute-statement \
  --resource-arn <ClusterArn output> --secret-arn <SecretArn output> \
  --database lab --sql "SELECT count(*) FROM ft_orders"
```

Wrap the benchmark queries in `EXPLAIN (ANALYZE, SUMMARY ON)` to get the server-side time,
bytes read from S3 vs cache and the number of S3 GETs.

## Things that bit me

- **Always set `region`** on the foreign table. Without it Aurora asks the global S3 endpoint
  where the bucket is, and from a private subnet that times out.
- **Hive partitions need a glob** (`.../lineitem/*/*.parquet`). Pointing at the folder doesn't recurse.
  With the glob, partition columns are recognised and files get skipped.
- **Raise `aurora_analytics.query_mem`.** The default (~4 GB on an xlarge) gave me a single thread.
  At 12 GB it used all 4 vCPUs and TPC-H Q1 went from 3.3 s to 1.2 s.
- **Keep Postgres-only functions out of the lake part of the query.** One `current_setting()` in the
  select list was enough to lose the pushdown.
- CloudFormation's validator doesn't know engine version 17.11 yet and prints a warning. The deploy works.
- CDK only knows the `s3Import`/`s3Export` feature names, so the role is attached through the
  L1 construct (see `lib/lab-stack.ts`).

## Results (SF10, db.r8gd.xlarge)

| Query | Cold | Warm |
|---|---|---|
| TPC-H Q1, 59M rows (query_mem 12 GB) | 48.8 s* | 1.2 s |
| Customer card, lake only | 4.0 s | 0.48 s |
| Customer card, hot table only | | 0.05 ms |
| Customer card, view hot + lake | | 155 ms |
| 1 year of lineitem, flat vs hive partitions | | 513 ms vs 89 ms |
| Join Aurora table + 2 lake tables | 1.4 s | |
| Materialize 15M orders into a 1M row table | | 3.9 s |

\* cold run was with the default query_mem. Full details in [results/](results/).

## Cost

There is no extra charge for the feature. You pay the Aurora instance by the hour, S3 storage
and the S3 GET requests. The whole session above (about 1.5 hours of Aurora, mostly me thinking)
costs a few dollars. Run `scripts/teardown.sh` or `npx cdk destroy` when you're done. Empty the
bucket first if you use `cdk destroy`, CloudFormation won't delete a bucket with objects in it.
