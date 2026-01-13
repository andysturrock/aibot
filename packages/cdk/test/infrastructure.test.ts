import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { NetworkStack } from '../lib/network-stack';
import { DynamoDBStack } from '../lib/dynamodb-stack';
import { SecretsManagerStack } from '../lib/secretsmanager-stack';
import { describe, it } from 'vitest';

describe('Infrastructure Stacks', () => {
  const env = { region: 'eu-west-2' };

  describe('NetworkStack', () => {
    it('should create a VPC and security groups', () => {
      const app = new cdk.App();
      const stack = new NetworkStack(app, 'TestNetworkStack', { env });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::EC2::VPC', 1);
      template.resourceCountIs('AWS::EC2::SecurityGroup', 1);
    });
  });

  describe('DynamoDBStack', () => {
    it('should create history and tokens tables', () => {
      const app = new cdk.App();
      const stack = new DynamoDBStack(app, 'TestDynamoDBStack', { env });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::DynamoDB::Table', 2);
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'AIBot_History'
      });
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'AIBot_Tokens'
      });
    });
  });

  describe('SecretsManagerStack', () => {
    it('should create AIBot secret', () => {
      const app = new cdk.App();
      const stack = new SecretsManagerStack(app, 'TestSecretsManagerStack', {
        env,
        customDomainName: 'example.com'
      });
      const template = Template.fromStack(stack);

      template.resourceCountIs('AWS::SecretsManager::Secret', 0);
    });
  });
});
