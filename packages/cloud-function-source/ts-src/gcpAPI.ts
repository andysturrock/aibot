import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { PubSub } from '@google-cloud/pubsub';

/**
 * Get a secret value from environment or GCP Secret Manager
 * @param secretName Name of the secret in Secret Manager (e.g., 'AIBot')
 * @param secretKey Key of the secret if stored as JSON, or the secret name itself if plain
 * @returns The secret value
 */
export async function getSecretValue(secretName: string, secretKey: string): Promise<string> {
  // 1. Check if it's already in the Environment
  const envSecret = process.env[secretKey];
  if (envSecret) {
    return envSecret;
  }

  // 2. Fetch from GCP Secret Manager
  const client = new SecretManagerServiceClient();
  const projectId = process.env.GOOGLE_CLOUD_PROJECT;

  if (!projectId) {
    throw new Error("GCP Project ID not found in environment");
  }

  const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;
  const [version] = await client.accessSecretVersion({ name });
  const payload = version.payload?.data?.toString();

  if (!payload) {
    throw new Error(`Secret ${secretName} not found or empty`);
  }

  try {
    const secrets = JSON.parse(payload);
    const secret = secrets[secretKey];
    if (secret === undefined) {
      // If key doesn't exist, it's an error as we've standardized on JSON payloads.
      throw new Error(`Secret key ${secretKey} not found in ${secretName}`);
    }
    return secret;
  } catch (e) {
    // Fail if not valid JSON as per project standard.
    throw new Error(`Failed to parse secret ${secretName} as JSON: ${e}`);
  }
}

/**
 * Publishes a message to a Pub/Sub topic (equivalent to async Lambda invoke)
 * @param topicName The ID of the topic (e.g., 'slack-events')
 * @param payload The string payload
 */
export async function publishToTopic(topicName: string, payload: string): Promise<void> {
  const pubsub = new PubSub();
  const dataBuffer = Buffer.from(payload);

  try {
    const messageId = await pubsub.topic(topicName).publishMessage({ data: dataBuffer });
    console.log(`Message ${messageId} published to ${topicName}`);
  } catch (error) {
    console.error(`Received error while publishing: ${error}`);
    throw error;
  }
}
