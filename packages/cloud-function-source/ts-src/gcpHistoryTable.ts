import { Firestore } from '@google-cloud/firestore';
import { Content } from '@google/genai';

const COLLECTION_NAME = "AIBot_History";
const TTL_IN_DAYS = 30;

export type History = {
  channel_id: string,
  thread_ts: string,
  content: Content[]
};

export type GetHistoryFunction = (channelId: string, threadTs: string, agentName: string) => Promise<Content[] | undefined>;
export type PutHistoryFunction = (channelId: string, threadTs: string, history: Content[], agentName: string) => Promise<void>;

/**
 * Gets the History for the given channel and thread id from Firestore
 * @param channelId Slack channel id 
 * @param threadTs the thread id for the conversation
 * @param agentName the name of the agent to get the history for
 * @returns history or undefined if no history exists for the channel and thread
 */
export async function getHistory(channelId: string, threadTs: string, agentName: string): Promise<Content[] | undefined> {
  const firestore = new Firestore();
  const id = `${channelId}_${threadTs}_${agentName}`;
  const docRef = firestore.collection(COLLECTION_NAME).doc(id);
  const doc = await docRef.get();

  if (!doc.exists) {
    return undefined;
  }

  const data = doc.data();
  if (data?.history) {
    return JSON.parse(data.history) as Content[];
  }
  return undefined;
}

/**
 * Deletes the history for a given conversation from Firestore
 */
export async function deleteHistory(channelId: string, threadTs: string, agentName: string): Promise<void> {
  const firestore = new Firestore();
  const id = `${channelId}_${threadTs}_${agentName}`;
  await firestore.collection(COLLECTION_NAME).doc(id).delete();
}

/**
 * Saves or overwrites conversation history in Firestore
 * @param channelId channel id
 * @param threadTs thread timestamp
 * @param agentName the name of the agent whose history this is
 * @param history history to write
 */
export async function putHistory(channelId: string, threadTs: string, history: Content[], agentName: string): Promise<void> {
  const firestore = new Firestore();
  const id = `${channelId}_${threadTs}_${agentName}`;

  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + TTL_IN_DAYS);

  await firestore.collection(COLLECTION_NAME).doc(id).set({
    history: JSON.stringify(history),
    channel_id: channelId,
    thread_ts: threadTs,
    agent_name: agentName,
    expiry: expiryDate.toISOString(),
    updated_at: new Date().toISOString()
  });
}
