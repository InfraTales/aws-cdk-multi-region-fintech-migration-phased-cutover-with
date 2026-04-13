#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { Tags } from 'aws-cdk-lib';
import { TapStack } from '../lib/tap-stack';

const app = new cdk.App();

// Get environment suffix from context (set by CI/CD pipeline) or use 'dev' as default
const environmentSuffix = app.node.tryGetContext('environmentSuffix') || 'dev';
const stackName = `TapStack${environmentSuffix}`;
const repositoryName = process.env.REPOSITORY || 'unknown';
const commitAuthor = process.env.COMMIT_AUTHOR || 'unknown';

// Get service name, email, and domain name from context or environment variables
const serviceName =
  app.node.tryGetContext('serviceName') ||
  process.env.SERVICE_NAME ||
  'transaction-migration';
const email = app.node.tryGetContext('email') || process.env.SNS_EMAIL;
const domainName =
  app.node.tryGetContext('domainName') || process.env.DOMAIN_NAME;

// Apply tags to all stacks in this app (optional - you can do this at stack level instead)
Tags.of(app).add('Environment', environmentSuffix);
Tags.of(app).add('Repository', repositoryName);
Tags.of(app).add('Author', commitAuthor);
Tags.of(app).add('Service', serviceName);

// Build stack props - only include optional params if they have values
const stackProps = {
  stackName: stackName,
  environmentSuffix: environmentSuffix,
  serviceName: serviceName,
  ...(email && { email }), // Only add if email is defined
  ...(domainName && { domainName }), // Only add if domainName is defined (enables Route53)
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
};

new TapStack(app, stackName, stackProps);
