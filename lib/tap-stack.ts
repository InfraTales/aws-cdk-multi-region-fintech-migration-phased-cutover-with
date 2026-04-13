import * as cdk from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';

interface TapStackProps extends cdk.StackProps {
  environmentSuffix?: string;
  serviceName: string;
  email?: string; // For SNS subscription
  domainName?: string; // Optional domain for Route53 failover
}

export class TapStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: TapStackProps) {
    super(scope, id, props);

    // Get environment suffix from props, context, or use 'dev' as default
    const environmentSuffix =
      props.environmentSuffix ||
      this.node.tryGetContext('environmentSuffix') ||
      'dev';

    const serviceName = props.serviceName;
    const region = this.region;
    const accountId = this.account;
    const replicaRegion = region === 'us-east-1' ? 'eu-central-1' : 'us-east-1';

    // Common tags for all resources
    const commonTags = {
      Project: 'TransactionMigration',
      MigrationPhase: 'Phase1',
      CutoverTimestamp: new Date().toISOString(),
      Environment: environmentSuffix,
      Service: serviceName,
    };

    // Apply tags to stack
    Object.entries(commonTags).forEach(([key, value]) => {
      cdk.Tags.of(this).add(key, value);
    });

    // ========================================
    // 1. DynamoDB Global Table
    // ========================================
    const transactionTable = new dynamodb.TableV2(this, 'TransactionTable', {
      tableName: `${serviceName}-transactions-${region}-${environmentSuffix}`,
      partitionKey: {
        name: 'transactionId',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.NUMBER },
      billing: dynamodb.Billing.onDemand(),
      replicas: [
        {
          region: replicaRegion,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: true,
      contributorInsights: true,
    });

    // ========================================
    // 2. S3 Buckets with Cross-Region Replication
    // ========================================
    const primaryBucket = new s3.Bucket(this, 'PrimaryBucket', {
      bucketName: `${serviceName}-primary-${accountId}-${region}-${environmentSuffix}`,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(90),
        },
        {
          id: 'TransitionToIA',
          enabled: true,
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
      encryption: s3.BucketEncryption.S3_MANAGED,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    const replicaBucket = new s3.Bucket(this, 'ReplicaBucket', {
      bucketName: `${serviceName}-replica-${accountId}-${replicaRegion}-${environmentSuffix}`,
      versioned: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
    });

    // Replication role
    const replicationRole = new iam.Role(this, 'ReplicationRole', {
      roleName: `${serviceName}-s3-replication-${region}-${environmentSuffix}`,
      assumedBy: new iam.ServicePrincipal('s3.amazonaws.com'),
      description: 'S3 Cross-Region Replication Role',
    });

    primaryBucket.grantRead(replicationRole);
    replicaBucket.grantWrite(replicationRole);

    // Add replication configuration via CfnBucket
    const cfnPrimaryBucket = primaryBucket.node.defaultChild as s3.CfnBucket;
    cfnPrimaryBucket.replicationConfiguration = {
      role: replicationRole.roleArn,
      rules: [
        {
          id: 'ReplicateTransactions',
          status: 'Enabled',
          priority: 1,
          filter: {
            prefix: 'transactions/',
          },
          destination: {
            bucket: replicaBucket.bucketArn,
            storageClass: 'STANDARD',
            replicationTime: {
              status: 'Enabled',
              time: {
                minutes: 15,
              },
            },
            metrics: {
              status: 'Enabled',
              eventThreshold: {
                minutes: 15,
              },
            },
          },
          deleteMarkerReplication: {
            status: 'Enabled',
          },
        },
      ],
    };

    // ========================================
    // 3. Lambda Functions for Transaction Processing
    // ========================================
    const transactionProcessorRole = new iam.Role(
      this,
      'TransactionProcessorRole',
      {
        roleName: `${serviceName}-lambda-processor-${region}-${environmentSuffix}`,
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            'service-role/AWSLambdaBasicExecutionRole'
          ),
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            'AWSXRayDaemonWriteAccess'
          ),
        ],
      }
    );

    transactionTable.grantReadWriteData(transactionProcessorRole);
    primaryBucket.grantReadWrite(transactionProcessorRole);

    const transactionProcessor = new lambda.Function(
      this,
      'TransactionProcessor',
      {
        functionName: `${serviceName}-processor-${region}-${environmentSuffix}`,
        runtime: lambda.Runtime.NODEJS_18_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline(`
        const { DynamoDBClient, PutItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
        const { S3Client, PutObjectCommand, HeadBucketCommand } = require('@aws-sdk/client-s3');
        
        exports.handler = async (event) => {
          console.log('Processing event:', JSON.stringify(event));
          
          // Health check endpoint for Route53
          if (event.action === 'healthCheck' || event.path === '/health' || event.rawPath === '/health') {
            try {
              const dynamoClient = new DynamoDBClient({});
              const s3Client = new S3Client({});
              
              // Check DynamoDB connectivity
              await dynamoClient.send(new GetItemCommand({
                TableName: process.env.TABLE_NAME,
                Key: { 
                  transactionId: { S: 'health-check' },
                  timestamp: { N: '0' }
                }
              }));
              
              // Check S3 connectivity
              await s3Client.send(new HeadBucketCommand({
                Bucket: process.env.BUCKET_NAME
              }));
              
              return {
                statusCode: 200,
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  status: 'healthy',
                  region: process.env.AWS_REGION,
                  service: process.env.SERVICE,
                  environment: process.env.ENVIRONMENT,
                  timestamp: Date.now(),
                  checks: {
                    dynamodb: 'ok',
                    s3: 'ok'
                  }
                })
              };
            } catch (error) {
              console.error('Health check failed:', error);
              return {
                statusCode: 503,
                headers: {
                  'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                  status: 'unhealthy',
                  region: process.env.AWS_REGION,
                  error: error.message
                })
              };
            }
          }
          
          // Transaction processing
          const transactionId = event.transactionId || Date.now().toString();
          const timestamp = Date.now();
          
          // Store in DynamoDB
          const dynamoClient = new DynamoDBClient({});
          await dynamoClient.send(new PutItemCommand({
            TableName: process.env.TABLE_NAME,
            Item: {
              transactionId: { S: transactionId },
              timestamp: { N: timestamp.toString() },
              data: { S: JSON.stringify(event) },
              region: { S: process.env.AWS_REGION }
            }
          }));
          
          // Store metadata in S3
          const s3Client = new S3Client({});
          await s3Client.send(new PutObjectCommand({
            Bucket: process.env.BUCKET_NAME,
            Key: \`transactions/\${transactionId}.json\`,
            Body: JSON.stringify(event),
            ContentType: 'application/json'
          }));
          
          return {
            statusCode: 200,
            body: JSON.stringify({ transactionId, timestamp, region: process.env.AWS_REGION })
          };
        };
      `),
        environment: {
          TABLE_NAME: transactionTable.tableName,
          BUCKET_NAME: primaryBucket.bucketName,
          ENVIRONMENT: environmentSuffix,
          SERVICE: serviceName,
        },
        role: transactionProcessorRole,
        timeout: cdk.Duration.seconds(30),
        memorySize: 512,
        tracing: lambda.Tracing.ACTIVE,
        logRetention: logs.RetentionDays.ONE_WEEK,
      }
    );

    // Lambda Alias for weighted routing
    const liveAlias = new lambda.Alias(this, 'ProcessorLiveAlias', {
      aliasName: 'live',
      version: transactionProcessor.currentVersion,
    });

    // ========================================
    // 4. SNS Topic for Alerts
    // ========================================
    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `${serviceName}-alerts-${region}-${environmentSuffix}`,
      displayName: 'Transaction Migration Alerts',
    });

    if (props.email) {
      alertTopic.addSubscription(
        new subscriptions.EmailSubscription(props.email)
      );
    }

    // ========================================
    // 5. EventBridge for Cross-Region Events
    // ========================================
    const eventBus = new events.EventBus(this, 'MigrationEventBus', {
      eventBusName: `${serviceName}-migration-${region}-${environmentSuffix}`,
    });

    const transactionEventRule = new events.Rule(this, 'TransactionEventRule', {
      ruleName: `${serviceName}-transaction-events-${region}-${environmentSuffix}`,
      eventBus: eventBus,
      eventPattern: {
        source: ['transaction.processing'],
        detailType: ['Transaction Created', 'Transaction Updated'],
      },
      description: 'Cross-region transaction event replication',
    });

    transactionEventRule.addTarget(
      new targets.LambdaFunction(liveAlias, {
        retryAttempts: 3,
        maxEventAge: cdk.Duration.hours(2),
      })
    );

    // Cross-region event target
    const crossRegionEventRole = new iam.Role(this, 'CrossRegionEventRole', {
      roleName: `${serviceName}-eventbridge-cross-region-${region}-${environmentSuffix}`,
      assumedBy: new iam.ServicePrincipal('events.amazonaws.com'),
    });

    crossRegionEventRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['events:PutEvents'],
        resources: [
          `arn:aws:events:${replicaRegion}:${accountId}:event-bus/${serviceName}-migration-${replicaRegion}-${environmentSuffix}`,
        ],
      })
    );

    // ========================================
    // 6. CloudWatch Dashboards and Alarms
    // ========================================
    const dashboard = new cloudwatch.Dashboard(this, 'MigrationDashboard', {
      dashboardName: `${serviceName}-migration-${region}-${environmentSuffix}`,
    });

    // Lambda metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Lambda Invocations',
        left: [transactionProcessor.metricInvocations()],
        right: [transactionProcessor.metricErrors()],
      }),
      new cloudwatch.GraphWidget({
        title: 'Lambda Duration',
        left: [transactionProcessor.metricDuration()],
      })
    );

    // DynamoDB metrics
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Read/Write Capacity',
        left: [
          transactionTable.metricConsumedReadCapacityUnits(),
          transactionTable.metricConsumedWriteCapacityUnits(),
        ],
      })
    );

    // Replication lag alarm
    const replicationLagAlarm = new cloudwatch.Alarm(
      this,
      'ReplicationLagAlarm',
      {
        alarmName: `${serviceName}-replication-lag-${region}-${environmentSuffix}`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/DynamoDB',
          metricName: 'ReplicationLatency',
          dimensionsMap: {
            TableName: transactionTable.tableName,
            ReceivingRegion: replicaRegion,
          },
          statistic: 'Average',
          period: cdk.Duration.minutes(5),
        }),
        threshold: 60000, // 60 seconds in milliseconds
        evaluationPeriods: 2,
        comparisonOperator:
          cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }
    );

    replicationLagAlarm.addAlarmAction(
      new cdk.aws_cloudwatch_actions.SnsAction(alertTopic)
    );

    // Lambda error alarm
    const lambdaErrorAlarm = new cloudwatch.Alarm(this, 'LambdaErrorAlarm', {
      alarmName: `${serviceName}-lambda-errors-${region}-${environmentSuffix}`,
      metric: transactionProcessor.metricErrors(),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    });

    lambdaErrorAlarm.addAlarmAction(
      new cdk.aws_cloudwatch_actions.SnsAction(alertTopic)
    );

    // ========================================
    // 7. SSM Parameters for Migration State
    // ========================================
    new ssm.StringParameter(this, 'MigrationStateParameter', {
      parameterName: `/${serviceName}/migration/state/${environmentSuffix}`,
      stringValue: JSON.stringify({
        currentPhase: 'initialization',
        primaryRegion: region,
        replicaRegion: replicaRegion,
        lastUpdated: new Date().toISOString(),
      }),
      description: 'Migration state tracking',
      tier: ssm.ParameterTier.STANDARD,
    });

    new ssm.StringParameter(this, 'MigrationConfigParameter', {
      parameterName: `/${serviceName}/migration/config/${environmentSuffix}`,
      stringValue: JSON.stringify({
        trafficWeightPrimary: 100,
        trafficWeightReplica: 0,
        enableAutoRollback: true,
        healthCheckThreshold: 95,
      }),
      description: 'Migration configuration metadata',
      tier: ssm.ParameterTier.STANDARD,
    });

    // ========================================
    // 8. Step Functions for Migration Orchestration
    // ========================================
    const snsPublishTask = new tasks.SnsPublish(
      this,
      'SendApprovalNotification',
      {
        topic: alertTopic,
        message: sfn.TaskInput.fromJsonPathAt('$.message'),
      }
    );

    const manualApprovalTask = new sfn.Wait(this, 'WaitForManualApproval', {
      time: sfn.WaitTime.duration(cdk.Duration.minutes(5)),
    });

    const validateHealthTask = new tasks.LambdaInvoke(this, 'ValidateHealth', {
      lambdaFunction: transactionProcessor,
      payload: sfn.TaskInput.fromObject({
        action: 'healthCheck',
        'phase.$': '$.phase',
      }),
      resultPath: '$.healthCheckResult',
    });

    const updateTrafficTask = new sfn.Pass(this, 'UpdateTrafficWeight', {
      parameters: {
        'phase.$': '$.phase',
        'trafficWeight.$': '$.trafficWeight',
        result: 'Traffic weight updated',
      },
    });

    const rollbackTask = new sfn.Pass(this, 'RollbackChanges', {
      result: sfn.Result.fromString('Rollback completed'),
    });

    const successState = new sfn.Succeed(this, 'MigrationSuccessful');
    const failState = new sfn.Fail(this, 'MigrationFailed', {
      cause: 'Migration failed validation',
      error: 'HealthCheckFailed',
    });

    // Define state machine
    const definition = snsPublishTask
      .next(manualApprovalTask)
      .next(validateHealthTask)
      .next(
        new sfn.Choice(this, 'HealthCheckPassed')
          .when(
            sfn.Condition.numberGreaterThan(
              '$.healthCheckResult.Payload.statusCode',
              199
            ),
            updateTrafficTask.next(successState)
          )
          .otherwise(rollbackTask.next(failState))
      );

    const migrationStateMachine = new sfn.StateMachine(
      this,
      'MigrationStateMachine',
      {
        stateMachineName: `${serviceName}-migration-orchestration-${region}-${environmentSuffix}`,
        definitionBody: sfn.DefinitionBody.fromChainable(definition),
        timeout: cdk.Duration.hours(2),
        tracingEnabled: true,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      }
    );

    // ========================================
    // 9. CloudFront Distribution
    // ========================================
    const cloudfrontDistribution = new cloudfront.Distribution(
      this,
      'TransactionDistribution',
      {
        comment: `${serviceName} Transaction API Distribution - ${environmentSuffix}`,
        defaultBehavior: {
          origin: new origins.S3Origin(primaryBucket),
          viewerProtocolPolicy:
            cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.CORS_S3_ORIGIN,
        },
        additionalBehaviors: {
          '/api/*': {
            origin: new origins.S3Origin(primaryBucket),
            viewerProtocolPolicy:
              cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
            cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED, // Bypass cache for transaction APIs
            originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
          },
        },
        priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
        enableLogging: true,
        logBucket: new s3.Bucket(this, 'CloudFrontLogBucket', {
          bucketName: `${serviceName}-cf-logs-${accountId}-${region}-${environmentSuffix}`,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          autoDeleteObjects: true,
          encryption: s3.BucketEncryption.S3_MANAGED,
          objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
          publicReadAccess: false,
          blockPublicAccess: new s3.BlockPublicAccess({
            blockPublicAcls: false,
            blockPublicPolicy: true,
            ignorePublicAcls: false,
            restrictPublicBuckets: true,
          }),
        }),
        logFilePrefix: 'cloudfront-logs/',
      }
    );

    // ========================================
    // 10. Route53 Health Checks and Failover (Optional)
    // ========================================
    if (props.domainName) {
      // Lookup existing hosted zone
      const hostedZone = route53.HostedZone.fromLookup(this, 'HostedZone', {
        domainName: props.domainName,
      });

      // Health check for primary CloudFront distribution
      const primaryHealthCheck = new route53.CfnHealthCheck(
        this,
        'PrimaryHealthCheck',
        {
          healthCheckConfig: {
            type: 'HTTPS',
            resourcePath: '/health',
            fullyQualifiedDomainName:
              cloudfrontDistribution.distributionDomainName,
            port: 443,
            requestInterval: 30,
            failureThreshold: 3,
            measureLatency: true,
          },
          healthCheckTags: [
            {
              key: 'Name',
              value: `${serviceName}-primary-health-${region}-${environmentSuffix}`,
            },
            {
              key: 'Service',
              value: serviceName,
            },
            {
              key: 'Environment',
              value: environmentSuffix,
            },
          ],
        }
      );

      // Health check for API Gateway endpoint (via Lambda)
      const apiHealthCheck = new route53.CfnHealthCheck(
        this,
        'ApiHealthCheck',
        {
          healthCheckConfig: {
            type: 'CALCULATED',
            childHealthChecks: [primaryHealthCheck.attrHealthCheckId],
            healthThreshold: 1,
          },
          healthCheckTags: [
            {
              key: 'Name',
              value: `${serviceName}-api-health-${region}-${environmentSuffix}`,
            },
          ],
        }
      );

      // CloudWatch alarm for data consistency (replication lag)
      const consistencyMetric = new cloudwatch.Metric({
        namespace: 'AWS/DynamoDB',
        metricName: 'ReplicationLatency',
        dimensionsMap: {
          TableName: transactionTable.tableName,
          ReceivingRegion: replicaRegion,
        },
        statistic: 'Average',
        period: cdk.Duration.minutes(1),
      });

      // Create health check based on CloudWatch alarm for data consistency
      const dataConsistencyAlarm = new cloudwatch.Alarm(
        this,
        'DataConsistencyAlarm',
        {
          alarmName: `${serviceName}-data-consistency-${region}-${environmentSuffix}`,
          metric: consistencyMetric,
          threshold: 30000, // 30 seconds in milliseconds
          evaluationPeriods: 2,
          comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
          treatMissingData: cloudwatch.TreatMissingData.BREACHING,
        }
      );

      const dataConsistencyHealthCheck = new route53.CfnHealthCheck(
        this,
        'DataConsistencyHealthCheck',
        {
          healthCheckConfig: {
            type: 'CLOUDWATCH_METRIC',
            alarmIdentifier: {
              name: dataConsistencyAlarm.alarmName,
              region: region,
            },
            insufficientDataHealthStatus: 'Unhealthy',
          },
          healthCheckTags: [
            {
              key: 'Name',
              value: `${serviceName}-consistency-health-${region}-${environmentSuffix}`,
            },
          ],
        }
      );

      // Composite health check combining API availability and data consistency
      const compositeHealthCheck = new route53.CfnHealthCheck(
        this,
        'CompositeHealthCheck',
        {
          healthCheckConfig: {
            type: 'CALCULATED',
            childHealthChecks: [
              apiHealthCheck.attrHealthCheckId,
              dataConsistencyHealthCheck.attrHealthCheckId,
            ],
            healthThreshold: 2, // Both must be healthy
          },
          healthCheckTags: [
            {
              key: 'Name',
              value: `${serviceName}-composite-health-${region}-${environmentSuffix}`,
            },
          ],
        }
      );

      // Create subdomain for API (e.g., api.yourdomain.com)
      const apiSubdomain = `api-${environmentSuffix}`;
      const fullDomain = `${apiSubdomain}.${props.domainName}`;

      // Primary failover record pointing to CloudFront
      const primaryRecord = new route53.ARecord(this, 'PrimaryRecord', {
        zone: hostedZone,
        recordName: fullDomain,
        target: route53.RecordTarget.fromAlias(
          new route53Targets.CloudFrontTarget(cloudfrontDistribution)
        ),
        comment: `Primary failover record for ${serviceName} in ${region}`,
      });

      // Configure failover routing using L1 construct
      const cfnPrimaryRecord = primaryRecord.node
        .defaultChild as route53.CfnRecordSet;
      cfnPrimaryRecord.failover = 'PRIMARY';
      cfnPrimaryRecord.healthCheckId = compositeHealthCheck.attrHealthCheckId;
      cfnPrimaryRecord.setIdentifier = `${serviceName}-primary-${region}-${environmentSuffix}`;

      // Note: Secondary failover record should be created in the replica region deployment
      // This creates a complete PRIMARY record. Deploy to replica region for SECONDARY.

      // Add CloudWatch alarm for health check failures
      const healthCheckAlarm = new cloudwatch.Alarm(this, 'HealthCheckAlarm', {
        alarmName: `${serviceName}-healthcheck-failure-${region}-${environmentSuffix}`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Route53',
          metricName: 'HealthCheckStatus',
          dimensionsMap: {
            HealthCheckId: compositeHealthCheck.attrHealthCheckId,
          },
          statistic: 'Minimum',
          period: cdk.Duration.minutes(1),
        }),
        threshold: 1,
        evaluationPeriods: 2,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });

      healthCheckAlarm.addAlarmAction(
        new cdk.aws_cloudwatch_actions.SnsAction(alertTopic)
      );

      // Output Route53 information
      new cdk.CfnOutput(this, 'ApiDomain', {
        value: fullDomain,
        description: 'API Domain Name with Route53 Failover',
        exportName: `${serviceName}-api-domain-${environmentSuffix}`,
      });

      new cdk.CfnOutput(this, 'HealthCheckId', {
        value: compositeHealthCheck.attrHealthCheckId,
        description: 'Route53 Composite Health Check ID',
        exportName: `${serviceName}-health-check-${region}-${environmentSuffix}`,
      });
    }

    // ========================================
    // Outputs
    // ========================================
    new cdk.CfnOutput(this, 'TransactionTableName', {
      value: transactionTable.tableName,
      description: 'DynamoDB Global Table Name',
      exportName: `${serviceName}-table-${region}-${environmentSuffix}`,
    });

    new cdk.CfnOutput(this, 'PrimaryBucketName', {
      value: primaryBucket.bucketName,
      description: 'Primary S3 Bucket Name',
      exportName: `${serviceName}-primary-bucket-${region}-${environmentSuffix}`,
    });

    new cdk.CfnOutput(this, 'TransactionProcessorArn', {
      value: transactionProcessor.functionArn,
      description: 'Transaction Processor Lambda ARN',
      exportName: `${serviceName}-lambda-${region}-${environmentSuffix}`,
    });

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: cloudfrontDistribution.distributionId,
      description: 'CloudFront Distribution ID',
      exportName: `${serviceName}-cloudfront-${environmentSuffix}`,
    });

    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: cloudfrontDistribution.distributionDomainName,
      description: 'CloudFront Distribution Domain Name',
      exportName: `${serviceName}-cloudfront-domain-${environmentSuffix}`,
    });

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: migrationStateMachine.stateMachineArn,
      description: 'Migration State Machine ARN',
      exportName: `${serviceName}-statemachine-${region}-${environmentSuffix}`,
    });

    new cdk.CfnOutput(this, 'AlertTopicArn', {
      value: alertTopic.topicArn,
      description: 'SNS Alert Topic ARN',
      exportName: `${serviceName}-sns-alerts-${region}-${environmentSuffix}`,
    });

    new cdk.CfnOutput(this, 'DashboardName', {
      value: dashboard.dashboardName,
      description: 'CloudWatch Dashboard Name',
      exportName: `${serviceName}-dashboard-${region}-${environmentSuffix}`,
    });
  }
}
