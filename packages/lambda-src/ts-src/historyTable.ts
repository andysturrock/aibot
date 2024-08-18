
import { DeleteItemCommand, DeleteItemCommandInput, DynamoDBClient, PutItemCommand, PutItemCommandInput, QueryCommand, QueryCommandInput } from '@aws-sdk/client-dynamodb';
import { Content } from '@google-cloud/vertexai';

// The very useful TTL functionality in DynamoDB means we
// can set a TTL on storing the history.
const TTL_IN_MS = 1000 * 60 * 60 * 24 * 30; // Thirty days
const TableName = "AIBot_History";

export type History = {
  channel_id: string,
  thread_ts: string,
  content: Content[]
};
export type GetHistoryFunction = (channelId: string, threadTs: string, agentName: string) => Promise<Content[] | undefined>;
export type PutHistoryFunction = (channelId: string, threadTs: string, history: Content[], agentName: string) => Promise<void>;

/**
 * Gets the History for the given channel and thread id
 * @param channelId Slack channel id 
 * @param threadTs the thread id for the conversation
 * @param agentName the name of the agent to get the history for
 * @returns history or undefined if no history exists for the channel and thread
 */
export async function getHistory(channelId: string, threadTs: string, agentName: string) : Promise<Content[] | undefined>  { 
  const ddbClient = new DynamoDBClient({});

  const id = `${channelId}_${threadTs}_${agentName}`;

  const params: QueryCommandInput = {
    TableName,
    KeyConditionExpression: "id = :id",
    ExpressionAttributeValues: {
      ":id" : {"S" : id}
    }
  };
  const data = await ddbClient.send(new QueryCommand(params));
  const items = data.Items;
  if(items?.[0]?.history.S) {
    const history = JSON.parse(items[0].history.S) as Content[];
    return history;
  }
  else {
    return undefined;
  }
}

export async function deleteHistory(channelId: string, threadTs: string, agentName: string) {
  const ddbClient = new DynamoDBClient({});

  const id = `${channelId}_${threadTs}_${agentName}`;

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
 * Put (ie save new or overwite) history with channelId and threadTs as the key
 * @param channelId channel id
 * @param threadTs thread timestamp
 * @param agentName the name of the agent whose history this is
 * @param history history to write
 */
export async function putHistory(channelId: string, threadTs: string, history: Content[], agentName: string) {
  const now = Date.now();
  const ttl = new Date(now + TTL_IN_MS);

  const id = `${channelId}_${threadTs}_${agentName}`;

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
