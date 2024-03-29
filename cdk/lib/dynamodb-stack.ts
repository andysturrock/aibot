import {Stack, StackProps, RemovalPolicy} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

export class DynamoDBStack extends Stack {
  public readonly slackIdToGCalTokenTable: dynamodb.Table;
  public readonly stateTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.slackIdToGCalTokenTable = new dynamodb.Table(this, 'AIBot_SlackIdToGCalToken', {
      tableName: "AIBot_SlackIdToGCalToken",
      partitionKey: {name: 'slack_id', type: dynamodb.AttributeType.STRING},
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY
    });

    this.stateTable = new dynamodb.Table(this, 'AIBot_StateTable', {
      tableName: "AIBot_State",
      partitionKey: {name: 'nonce', type: dynamodb.AttributeType.STRING},
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'expiry',
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Create exports from the CF template so that CF knows that other stacks depend on this stack.
    this.exportValue(this.slackIdToGCalTokenTable.tableArn);
    this.exportValue(this.stateTable.tableArn);
  }
}
