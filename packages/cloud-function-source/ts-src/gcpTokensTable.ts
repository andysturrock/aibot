import { Firestore } from '@google-cloud/firestore';

const COLLECTION_NAME = "AIBot_Tokens";

/**
 * Gets the user access token for the given user id from Firestore
 * @param slackUserId Slack user id 
 * @returns access token or undefined if no access token exists for the user
 */
export async function getAccessToken(slackUserId: string): Promise<string | undefined> {
  const firestore = new Firestore();
  const docRef = firestore.collection(COLLECTION_NAME).doc(slackUserId);
  const doc = await docRef.get();

  if (!doc.exists) {
    return undefined;
  }

  const data = doc.data();
  return data?.access_token;
}

/**
 * Deletes the access token for a given user from Firestore
 * @param slackUserId Slack user id
 */
export async function deleteAccessToken(slackUserId: string): Promise<void> {
  const firestore = new Firestore();
  await firestore.collection(COLLECTION_NAME).doc(slackUserId).delete();
}

/**
 * Saves or overwrites a user's access token in Firestore
 * @param slackUserId Slack user id
 * @param accessToken token to write
 */
export async function putAccessToken(slackUserId: string, accessToken: string): Promise<void> {
  const firestore = new Firestore();
  await firestore.collection(COLLECTION_NAME).doc(slackUserId).set({
    access_token: accessToken,
    slack_id: slackUserId,
    updated_at: new Date().toISOString()
  });
}
