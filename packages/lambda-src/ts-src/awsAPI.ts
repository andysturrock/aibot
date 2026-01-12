 
 
 
import { InvocationType, InvokeCommand, InvokeCommandInput, LambdaClient, LambdaClientConfig } from "@aws-sdk/client-lambda";
import { GetSecretValueCommand, GetSecretValueRequest, SecretsManagerClient, SecretsManagerClientConfig } from "@aws-sdk/client-secrets-manager";

/**
 * Get a secret value from the environment or AWS Secrets Manager
 * @param secretName Name of the secrets
 * @param secretKey Key of the secret.  The secret is assumed to be stored as JSON text.
 * @returns The secret value as a string
 * @throws AccessDeniedException if the caller doesn't have access to that secret or Error if the secret or key don't exist
 */
export async function getSecretValue(secretName: string, secretKey: string) {
  const envSecret = process.env[secretKey];
  if(envSecret) {
    return envSecret;
  }

  const configuration: SecretsManagerClientConfig = {
    region: 'eu-west-2'
  };
  
  const client = new SecretsManagerClient(configuration);
  const input: GetSecretValueRequest = { // GetSecretValueRequest
    SecretId: secretName,
  };
  const command = new GetSecretValueCommand(input);
  const response = await client.send(command);

  if(!response.SecretString) {
    throw new Error(`Secret ${secretName} not found`);
  }

  type SecretValue = Record<string, string>;
  const secrets = JSON.parse(response.SecretString) as SecretValue;

  const secret = secrets[secretKey];
  if(!secret) {
    throw new Error(`Secret key ${secretKey} not found`);
  }
  return secret;
}

export async function invokeLambda(functionName: string, payload: string) {
  const configuration: LambdaClientConfig = {
    region: 'eu-west-2'
  };
  const lambdaClient = new LambdaClient(configuration);
  const input: InvokeCommandInput = {
    FunctionName: functionName,
    InvocationType: InvocationType.Event,
    Payload: new TextEncoder().encode(payload)
  };
  
  const invokeCommand = new InvokeCommand(input);
  const output = await lambdaClient.send(invokeCommand);
  if(output.StatusCode != 202) {
    console.error(`Failed to invoke ${functionName}`);
    throw new Error(output.FunctionError);
  }
}