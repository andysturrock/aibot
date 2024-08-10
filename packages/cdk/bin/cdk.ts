#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import 'source-map-support/register';
import { getEnv } from '../lib/common';
import { DynamoDBStack } from '../lib/dynamodb-stack';
import { LambdaStack } from '../lib/lambda-stack';
import { NetworkStack } from '../lib/network-stack';
import { SecretsManagerStack } from '../lib/secretsmanager-stack';

// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const lambdaVersion = getEnv('LAMBDA_VERSION', false)!;
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const customDomainName = getEnv('CUSTOM_DOMAIN_NAME', false)!;
// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
const route53ZoneId = getEnv('R53_ZONE_ID', false)!;
const aiBotDomainName = `aibot.${customDomainName}`;

const app = new cdk.App();

const region = 'eu-west-2';

// TODO maybe unhardcode region, but OK for now as always want London to minimise latency and for data residency purposes.
const dynamoDBStack = new DynamoDBStack(app, 'AIBotDynamoDBStack', {
  env: {region}
});

const secretsManagerStack = new SecretsManagerStack(app, 'AIBotSecretsManagerStack', {
  env: {region},
  customDomainName,
});

const networkStack = new NetworkStack(app, 'AIBotNetworkStack', {
  env: {region}
});

new LambdaStack(app, 'AIBotLambdaStack', {
  env: {region},
  vpc: networkStack.vpc,
  securityGroups: networkStack.securityGroups,
  historyTable: dynamoDBStack.historyTable,
  tokensTable: dynamoDBStack.tokensTable,
  aiBotSecret: secretsManagerStack.aiBotSecret,
  lambdaVersion,
  customDomainName,
  aiBotDomainName: aiBotDomainName,
  route53ZoneId
});

