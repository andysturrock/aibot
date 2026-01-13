import { describe, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { LambdaStack } from '../lib/lambda-stack';

describe('LambdaStack', () => {
  it('should create required lambda functions and infrastructure', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'TestStack');

    const vpc = new ec2.Vpc(stack, 'TestVpc');
    const sg = new ec2.SecurityGroup(stack, 'TestSG', { vpc });
    const securityGroups = new Map<string, ec2.SecurityGroup>();
    securityGroups.set('noInboundAllOutboundSecurityGroup', sg);

    const historyTable = new dynamodb.Table(stack, 'HistoryTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING }
    });
    const tokensTable = new dynamodb.Table(stack, 'TokensTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING }
    });
    const aiBotSecret = new secretsmanager.Secret(stack, 'Secret');

    const lambdaStack = new LambdaStack(app, 'MyLambdaStack', {
      vpc,
      securityGroups,
      historyTable,
      tokensTable,
      aiBotSecret,
      lambdaVersion: '1.0.0',
      customDomainName: 'example.com',
      aiBotDomainName: 'bot.example.com',
      route53ZoneId: 'Z123456789'
    });

    const template = Template.fromStack(lambdaStack);

    // Verify all core Lambdas exist (5 user-defined + 1 for log retention)
    template.resourceCountIs('AWS::Lambda::Function', 6);

    // Verify Node 22 runtime
    template.hasResourceProperties('AWS::Lambda::Function', {
      Runtime: 'nodejs22.x'
    });

    // Verify Secret read permissions
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
            Effect: 'Allow'
          })
        ])
      }
    });

    // Verify API Gateway
    template.resourceCountIs('AWS::ApiGateway::RestApi', 1);
    template.hasResourceProperties('AWS::ApiGateway::RestApi', {
      Name: '/aibot'
    });

    // Verify Route53 record
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'bot.example.com.',
      Type: 'A'
    });
  });
});
