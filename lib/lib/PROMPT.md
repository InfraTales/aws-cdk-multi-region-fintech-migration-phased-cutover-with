Create a single CDK TypeScript file that provisions all resources needed for a phased multi-region migration of a financial transaction processing system from us-east-1 to eu-central-1.

The CDK stack should automatically destroy all resources when the stack is deleted (i.e., set appropriate removal policies for each resource).

Goals:

Design an infrastructure that allows a seamless, monitored, and reversible migration process between AWS regions while maintaining high availability, zero data loss, and compliance with data residency laws.

Requirements:

    1.	DynamoDB Global Tables configured for eventual consistency and active-active replication between us-east-1 and eu-central-1.
    2.	Lambda functions deployed in both regions with weighted routing to gradually shift traffic during migration.
    3.	S3 buckets in both regions with cross-region replication, lifecycle policies, and filters to exclude objects larger than 1GB and only replicate specific prefixes.
    4.	Route53 failover routing with health checks that validate both API availability and data consistency before switching traffic.
    5.	CloudFront distribution with origin failover between regions — caching static assets but bypassing cache for transaction APIs.
    6.	EventBridge rules for cross-region event replication using deduplication and exponential backoff on retries.
    7.	Custom CloudWatch metrics and dashboards to track replication lag and data consistency between regions.
    8.	IAM roles and policies implementing least privilege access for all cross-region operations.
    9.	SSM Parameter Store parameters for tracking migration state and configuration metadata.
    10.	Step Functions state machine to orchestrate migration phases, including manual approval gates before each critical cutover step.

Additional Configuration:
• All resources must include tags for:
• Project: TransactionMigration
• MigrationPhase: <phase-name>
• CutoverTimestamp: <timestamp>
• All resources must use RemovalPolicy.DESTROY to ensure they are deleted when the stack is destroyed.
• Use CDK v2.x with TypeScript targeting Node.js 18+.
• Enable CloudWatch cross-region dashboards and AWS X-Ray tracing for observability.
• Use a single CDK file containing all definitions, clearly separated by logical constructs (e.g., compute, data, networking, observability).

Expected Output:

A production-ready CDK TypeScript application that:
• Provisions all multi-region infrastructure automatically.
• Enables automated phased migration with traffic shifting and rollback capabilities.
• Provides CloudWatch dashboards for real-time monitoring of replication, lag, and API health.
• Ensures complete teardown (no orphaned resources) upon stack deletion.
