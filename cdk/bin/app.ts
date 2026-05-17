#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ApplicationStack } from '../lib/stacks/application-stack';
import { PlatformStack } from '../lib/stacks/platform-stack';
import { environments } from '../config/environments';

const app = new cdk.App();

// usage: cdk deploy -c environment=dev -c imageTag=sha-abc1234
const environmentName = app.node.tryGetContext('environment') ?? 'dev';
const imageTag = app.node.tryGetContext('imageTag') ?? 'latest';

const config = environments[environmentName];
if (!config) {
  throw new Error(
    `Unknown environment "${environmentName}". Valid values: ${Object.keys(environments).join(', ')}`,
  );
}

const env: cdk.Environment = {
  account: config.account ?? process.env.CDK_DEFAULT_ACCOUNT,
  region: config.region,
};

const commonTags = {
  Environment: environmentName,
  ManagedBy: 'CDK',
  Project: 'deswik-platform',
  Repository: 'deswik-devops-assessment',
};

const platformStack = new PlatformStack(app, `${environmentName}-Platform`, {
  env,
  config,
  description: `Deswik shared platform infrastructure — ${environmentName}`,
  tags: commonTags,
});

new ApplicationStack(app, `${environmentName}-Application`, {
  env,
  config,
  platformStack,
  imageTag,
  description: `Deswik application services — ${environmentName} @ ${imageTag}`,
  tags: { ...commonTags, ImageTag: imageTag },
});

app.synth();
