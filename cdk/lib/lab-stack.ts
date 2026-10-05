import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import { Construct } from 'constructs';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface LabStackProps extends StackProps {
  instanceClass: string; // e.g. r8gd.xlarge
  scaleFactor: number;   // TPC-H scale factor for the generated data
}

export class AuroraDuckdbLabStack extends Stack {
  constructor(scope: Construct, id: string, props: LabStackProps) {
    super(scope, id, props);

    // Small VPC with private subnets only: no NAT gateway, so it costs nothing.
    // We talk to the database through the Data API, so nothing needs to be public.
    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      natGateways: 0,
      restrictDefaultSecurityGroup: false,
      subnetConfiguration: [{ name: 'db', subnetType: ec2.SubnetType.PRIVATE_ISOLATED }],
      gatewayEndpoints: { S3: { service: ec2.GatewayVpcEndpointAwsService.S3 } },
    });

    // The "lake". Emptied by scripts/teardown.sh before the stack is deleted.
    const lake = new s3.Bucket(this, 'Lake', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Role assumed by Aurora when aurora_analytics reads from S3.
    const analyticsRole = new iam.Role(this, 'AuroraAnalyticsRole', {
      assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
    });
    lake.grantRead(analyticsRole);
    analyticsRole.addToPolicy(new iam.PolicyStatement({
      actions: ['s3:GetBucketLocation'],
      resources: [lake.bucketArn],
    }));

    // aurora_analytics.enabled is false by default and the default group can't be changed.
    const params = new rds.ParameterGroup(this, 'ClusterParams', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.of('17.11', '17'),
      }),
      parameters: { 'aurora_analytics.enabled': 'true' },
    });

    const cluster = new rds.DatabaseCluster(this, 'Cluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.of('17.11', '17'),
      }),
      // we only use the password through Secrets Manager / Data API, so a short exclude list is fine
      credentials: rds.Credentials.fromGeneratedSecret('postgres', { excludeCharacters: ' %+~`#$&*()|[]{}:;<>?!/@"\\' }),
      defaultDatabaseName: 'lab',
      parameterGroup: params,
      writer: rds.ClusterInstance.provisioned('writer', {
        instanceType: new ec2.InstanceType(props.instanceClass),
        publiclyAccessible: false,
      }),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      enableDataApi: true,
      storageEncrypted: true,
      deletionProtection: false,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // CDK only knows the s3Import / s3Export feature names, so set the role by hand.
    const cfnCluster = cluster.node.defaultChild as rds.CfnDBCluster;
    cfnCluster.associatedRoles = [{ roleArn: analyticsRole.roleArn, featureName: 'AuroraAnalytics' }];

    // One-off job that generates TPC-H with DuckDB and writes Parquet to the bucket.
    // CodeBuild instead of Lambda: no packaging, no 15 minute limit, plenty of disk.
    const datagenLogs = new logs.LogGroup(this, 'DatagenLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const datagen = new codebuild.Project(this, 'Datagen', {
      description: 'Generates TPC-H Parquet files with DuckDB',
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        computeType: codebuild.ComputeType.LARGE,
      },
      timeout: Duration.minutes(60),
      environmentVariables: {
        BUCKET: { value: lake.bucketName },
        SF: { value: String(props.scaleFactor) },
        // the script lives in scripts/, passed in as base64 so the job needs no source
        GEN_SCRIPT: { value: readFileSync(join(__dirname, '../../scripts/gen_tpch.py')).toString('base64') },
      },
      logging: { cloudWatch: { logGroup: datagenLogs } },
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: { commands: ['pip install --quiet duckdb==1.5.6'] },
          build: {
            commands: [
              'mkdir -p /tmp/tpch && cd /tmp/tpch',
              'echo "$GEN_SCRIPT" | base64 -d > gen_tpch.py',
              'python gen_tpch.py',
              'aws s3 sync out/ "s3://$BUCKET/tpch/sf$SF/" --only-show-errors',
              'aws s3 ls "s3://$BUCKET/tpch/sf$SF/" --recursive --summarize | tail -2',
            ],
          },
        },
      }),
    });
    lake.grantReadWrite(datagen);

    new CfnOutput(this, 'ClusterArn', { value: cluster.clusterArn });
    new CfnOutput(this, 'SecretArn', { value: cluster.secret!.secretArn });
    new CfnOutput(this, 'BucketName', { value: lake.bucketName });
    new CfnOutput(this, 'DatagenProject', { value: datagen.projectName });
  }
}
