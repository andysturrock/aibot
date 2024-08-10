import { RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class DynamoDBStack extends Stack {
  public readonly historyTable: dynamodb.Table;
  public readonly tokensTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.historyTable = new dynamodb.Table(this, 'AIBot_History', {
      tableName: "AIBot_History",
      partitionKey: {name: 'id', type: dynamodb.AttributeType.STRING},
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY
    });

    this.tokensTable = new dynamodb.Table(this, 'AIBot_Tokens', {
      tableName: "AIBot_Tokens",
      partitionKey: {name: 'slack_id', type: dynamodb.AttributeType.STRING},
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY
    });

    // Create exports from the CF template so that CF knows that other stacks depend on this stack.
    this.exportValue(this.historyTable.tableArn);
    this.exportValue(this.tokensTable.tableArn);
  }
}
