import { Duration, Stack } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as targets from 'aws-cdk-lib/aws-route53-targets';
import { Construct } from 'constructs';
import { LambdaStackProps } from './common';

export class LambdaStack extends Stack {
  constructor(scope: Construct, id: string, props: LambdaStackProps) {
    super(scope, id, props);

    // Semantic versioning has dots as separators but this is invalid in a URL
    // so replace the dots with underscores first.
    const lambdaVersionIdForURL = props.lambdaVersion.replace(/\./g, '_');

    const noInboundAllOutboundSecurityGroup = props.securityGroups.get("noInboundAllOutboundSecurityGroup");
    if(!noInboundAllOutboundSecurityGroup) {
      throw new Error("Cannot find security group noInboundAllOutboundSecurityGroup");
    }

    // Common props for all lambdas, so define them once here.
    const allLambdaProps = {
      environment: {
        NODE_OPTIONS: '--enable-source-maps',
      },
      logRetention: logs.RetentionDays.THREE_DAYS,
      runtime: lambda.Runtime.NODEJS_22_X,
      timeout: Duration.seconds(30),
      vpc: props.vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [noInboundAllOutboundSecurityGroup]
    };

    // The lambda for handling the callback for the Slack install
    const handleSlackAuthRedirectLambda = new lambda.Function(this, "handleSlackAuthRedirectLambda", {
      handler: "handleSlackAuthRedirect.handleSlackAuthRedirect",
      functionName: 'AIBot-handleSlackAuthRedirect',
      code: lambda.Code.fromAsset("../lambda-src/dist/handleSlackAuthRedirect"),
      ...allLambdaProps
    });
    // Allow read access to the secret it needs
    props.aiBotSecret.grantRead(handleSlackAuthRedirectLambda);
    // And access to the tokens table
    props.tokensTable.grantReadWriteData(handleSlackAuthRedirectLambda);

    // Create the lambda for handling events, including DMs from the Messages tab
    const handleEventsEndpointLambda = new lambda.Function(this, "handleEventsEndpointLambda", {
      handler: "handleEventsEndpoint.handleEventsEndpoint",
      functionName: 'AIBot-handleEventsEndpoint',
      code: lambda.Code.fromAsset("../lambda-src/dist/handleEventsEndpoint"),
      memorySize: 512,
      ...allLambdaProps
    });
    // Allow read access to the secret it needs
    props.aiBotSecret.grantRead(handleEventsEndpointLambda);

    // Create the lambda which does the chat style AI.
    // This lambda is called from the events lambda, not via the API Gateway.
    const handlePromptCommandLambda = new lambda.Function(this, "handlePromptCommandLambda", {
      handler: "handlePromptCommand.handlePromptCommand",
      functionName: 'AIBot-handlePromptCommandLambda',
      code: lambda.Code.fromAsset("../lambda-src/dist/handlePromptCommand"),
      memorySize: 1024,
      ...allLambdaProps,
      timeout: Duration.seconds(180)
    });
    // This function is going to be invoked asynchronously, so set some extra config for that
    new lambda.EventInvokeConfig(this, 'handlePromptCommandLambdaEventInvokeConfig', {
      function: handlePromptCommandLambda,
      maxEventAge: Duration.minutes(2),
      retryAttempts: 2,
    });
    // Give the events lambda permission to invoke this one
    handlePromptCommandLambda.grantInvoke(handleEventsEndpointLambda);
    // Allow access to the DynamoDB tables
    props.historyTable.grantReadWriteData(handlePromptCommandLambda);
    // And access to the tokens table
    props.tokensTable.grantReadData(handlePromptCommandLambda);
    // Allow read access to the secret it needs
    props.aiBotSecret.grantRead(handlePromptCommandLambda);
    // Set the name to something short otherwise the GCP workload federation stuff doesn't work.
    const handlePromptCommandLambdaRole = handlePromptCommandLambda.role?.node.defaultChild as iam.CfnRole;
    handlePromptCommandLambdaRole.roleName = 'handlePromptCommandLambdaRole';

    // Create the lambda for handling Slack interactions.
    const handleInteractiveEndpointLambda = new lambda.Function(this, "handleInteractiveEndpointLambda", {
      handler: "handleInteractiveEndpoint.handleInteractiveEndpoint",
      functionName: 'AIBot-handleInteractiveEndpoint',
      code: lambda.Code.fromAsset("../lambda-src/dist/handleInteractiveEndpoint"),
      memorySize: 512,
      ...allLambdaProps
    });
    // Allow read access to the secret it needs
    props.aiBotSecret.grantRead(handleInteractiveEndpointLambda);

    // Create the lambda which handles the Home tab
    // This lambda is called from the event handler lambda, not via the API Gateway.
    const handleHomeTabEventLambda = new lambda.Function(this, "handleHomeTabEventLambda", {
      handler: "handleHomeTabEvent.handleHomeTabEvent",
      functionName: 'AIBot-handleHomeTabEventLambda',
      code: lambda.Code.fromAsset("../lambda-src/dist/handleHomeTabEvent"),
      memorySize: 1024,
      ...allLambdaProps
    });
    // This function is going to be invoked asynchronously, so set some extra config for that
    new lambda.EventInvokeConfig(this, 'handleHomeTabEventLambdaEventInvokeConfig', {
      function: handleHomeTabEventLambda,
      maxEventAge: Duration.minutes(2),
      retryAttempts: 2,
    });
    // Give the handle events lambda permission to invoke this one
    handleHomeTabEventLambda.grantInvoke(handleEventsEndpointLambda);
    // Allow read access to the secret it needs
    props.aiBotSecret.grantRead(handleHomeTabEventLambda);
    // And access to the tokens table
    props.tokensTable.grantReadData(handleHomeTabEventLambda);

    // Get hold of the hosted zone which has previously been created
    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'R53Zone', {
      zoneName: props.customDomainName,
      hostedZoneId: props.route53ZoneId,
    });

    // Create the cert for the gateway.
    // Usefully, this writes the DNS Validation CNAME records to the R53 zone,
    // which is great as normal Cloudformation doesn't do that.
    const acmCertificateForCustomDomain = new acm.DnsValidatedCertificate(this, 'CustomDomainCertificate', {
      domainName: props.aiBotDomainName,
      hostedZone: zone,
      validation: acm.CertificateValidation.fromDns(zone),
    });

    // Create the custom domain
    const customDomain = new apigateway.DomainName(this, 'CustomDomainName', {
      domainName: props.aiBotDomainName,
      certificate: acmCertificateForCustomDomain,
      endpointType: apigateway.EndpointType.REGIONAL,
      securityPolicy: apigateway.SecurityPolicy.TLS_1_2
    });

    // This is the API Gateway which then calls the initial response and auth redirect lambdas
    const api = new apigateway.RestApi(this, "APIGateway", {
      restApiName: "/aibot",
      description: "Service for /aibot Slack command.",
      deploy: false // create the deployment below
    });

    // By default CDK creates a deployment and a "prod" stage.  That means the URL is something like
    // https://2z2ockh6g5.execute-api.eu-west-2.amazonaws.com/prod/
    // We want to create the stage to match the version id.
    const apiGatewayDeployment = new apigateway.Deployment(this, 'ApiGatewayDeployment', {
      api: api,
    });
    const stage = new apigateway.Stage(this, 'Stage', {
      deployment: apiGatewayDeployment,
      loggingLevel: apigateway.MethodLoggingLevel.INFO,
      dataTraceEnabled: true,
      stageName: lambdaVersionIdForURL
    });

    // Connect the API Gateway to the lambdas
    const handleSlackAuthRedirectLambdaIntegration = new apigateway.LambdaIntegration(handleSlackAuthRedirectLambda, {
      requestTemplates: {"application/json": '{ "statusCode": "200" }'}
    });
    const handleInteractiveEndpointLambdaIntegration = new apigateway.LambdaIntegration(handleInteractiveEndpointLambda, {
      requestTemplates: {"application/json": '{ "statusCode": "200" }'}
    });
    const handleEventsEndpointLambdaIntegration = new apigateway.LambdaIntegration(handleEventsEndpointLambda, {
      requestTemplates: {"application/json": '{ "statusCode": "200" }'}
    });
    const handleSlackAuthRedirectResource = api.root.addResource('slack-oauth-redirect');
    const handleInteractiveEndpointResource = api.root.addResource('interactive-endpoint');
    const handleEventsEndpointResource = api.root.addResource('events-endpoint');
    // And add the methods.
    handleSlackAuthRedirectResource.addMethod("GET", handleSlackAuthRedirectLambdaIntegration);
    handleInteractiveEndpointResource.addMethod("POST", handleInteractiveEndpointLambdaIntegration);
    handleEventsEndpointResource.addMethod("POST", handleEventsEndpointLambdaIntegration);

    // Create the R53 "A" record to map from the custom domain to the actual API URL
    new route53.ARecord(this, 'CustomDomainAliasRecord', {
      recordName: props.aiBotDomainName,
      zone: zone,
      target: route53.RecordTarget.fromAlias(new targets.ApiGatewayDomain(customDomain))
    });
    // And path mapping to the API
    customDomain.addBasePathMapping(api, {basePath: lambdaVersionIdForURL, stage: stage});
  }
}
