
import {DeleteItemCommand, DeleteItemCommandInput, DynamoDBClient, PutItemCommand, PutItemCommandInput, QueryCommand, QueryCommandInput} from '@aws-sdk/client-dynamodb';
import {Content} from '@google-cloud/vertexai';

// The very useful TTL functionality in DynamoDB means we
// can set a TTL on storing the history.
const TTL_IN_MS = 1000 * 60 * 60 * 24 * 7; // One week
const TableName = "AIBot_History";

export type History = {
  slack_id: string,
  thread_ts: string,
  content: Content[]
};
/**
 * Gets the History for the given user and thread id
 * @param slackId Slack user id 
 * @param threadTs the thread id for the conversation
 * @returns history or undefined if no history exists for the user and thread
 */
export async function getHistory(slackId: string, threadTs: string) : Promise<Content[] | undefined>  { 
  const ddbClient = new DynamoDBClient({});

  const id = `${slackId}_${threadTs}`;

  const params: QueryCommandInput = {
    TableName,
    KeyConditionExpression: "id = :id",
    ExpressionAttributeValues: {
      ":id" : {"S" : id}
    }
  };
  const data = await ddbClient.send(new QueryCommand(params));
  const items = data.Items;
  if(items && items[0] && items[0].history.S) {
    const history = JSON.parse(items[0].history.S) as Content[];
    return history;
  }
  else {
    return undefined;
  }
}

export async function deleteHistory(slackId: string, threadTs: string) {
  const ddbClient = new DynamoDBClient({});

  const id = `${slackId}_${threadTs}`;

  const params: DeleteItemCommandInput = {
    TableName,
    Key: {
      'id': {S: id}
    }
  };

  const command = new DeleteItemCommand(params);

  await ddbClient.send(command);
}

/**
 * Put (ie save new or overwite) history with slackId and threadTs as the key
 * @param slackId Key for the table
 * @param history history to write
 */
export async function putHistory(slackId: string, threadTs: string, history: Content[]) {
  const now = Date.now();
  const ttl = new Date(now + TTL_IN_MS);

  const id = `${slackId}_${threadTs}`;

  const putItemCommandInput: PutItemCommandInput = {
    TableName,
    Item: {
      id: {S: id},
      history: {S: JSON.stringify(history)},
      expiry: {N: `${Math.floor(ttl.getTime() / 1000)}`}
    }
  };

  const ddbClient = new DynamoDBClient({});

  await ddbClient.send(new PutItemCommand(putItemCommandInput));
}
