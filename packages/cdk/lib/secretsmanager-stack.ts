import {Stack} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import {SecretsManagerStackProps} from './common';

export class SecretsManagerStack extends Stack {
  public readonly aiBotSecret: secretsmanager.ISecret;

  constructor(scope: Construct, id: string, props: SecretsManagerStackProps) {
    super(scope, id, props);

    // Just get a reference to the secret by name
    this.aiBotSecret = secretsmanager.Secret.fromSecretNameV2(this, 'aiBotSecret', "AIBot");

    // Create exports from the CF template so that CF knows that other stacks depend on this stack.
    this.exportValue(this.aiBotSecret.secretArn, {name: 'aiBotSecret'});
  }
}
