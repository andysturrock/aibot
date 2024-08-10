
import { DeleteItemCommand, DeleteItemCommandInput, DynamoDBClient, PutItemCommand, PutItemCommandInput, QueryCommand, QueryCommandInput } from '@aws-sdk/client-dynamodb';

const TableName = "AIBot_Tokens";

/**
 * Gets the user access token for the given user id
 * @param slackUserId Slack user id 
 * @returns access token or undefined if no access token exists for the user
 */
export async function getAccessToken(slackUserId: string) { 
  const ddbClient = new DynamoDBClient({});

  const params: QueryCommandInput = {
    TableName,
    KeyConditionExpression: "slack_id = :slack_id",
    ExpressionAttributeValues: {
      ":slack_id" : {"S" : slackUserId}
    }
  };
  const data = await ddbClient.send(new QueryCommand(params));
  const items = data.Items;
  if(items?.[0]?.access_token.S) {
    const accessToken = items[0].access_token.S;
    return accessToken;
  }
  else {
    return undefined;
  }
}

export async function deleteAccessToken(slackUserId: string) {
  const ddbClient = new DynamoDBClient({});

  const params: DeleteItemCommandInput = {
    TableName,
    Key: {
      'slack_id': {S: slackUserId}
    }
  };

  const command = new DeleteItemCommand(params);

  await ddbClient.send(command);
}

/**
 * Put (ie save new or overwite) token with slackId as the key
 * @param slackUserId Key for the table
 * @param accessToken token to write
 */
export async function putAccessToken(slackUserId: string, accessToken: string) {

  const putItemCommandInput: PutItemCommandInput = {
    TableName,
    Item: {
      slack_id: {S: slackUserId},
      access_token: {S: accessToken}
    }
  };

  const ddbClient = new DynamoDBClient({});

  await ddbClient.send(new PutItemCommand(putItemCommandInput));
}
