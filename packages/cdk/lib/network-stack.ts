import { Duration, RemovalPolicy, Stack, StackProps } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class NetworkStack extends Stack {
  public readonly vpc: ec2.Vpc;
  public readonly securityGroups = new Map<string, ec2.SecurityGroup>();

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const publicSubnetConfiguration: ec2.SubnetConfiguration = {
      subnetType: ec2.SubnetType.PUBLIC,
      name: 'public-subnet'
    };
    const privateSubnetConfiguration: ec2.SubnetConfiguration = {
      subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      name: 'private-subnet'
    };
    const vpcProps: ec2.VpcProps = {
      vpcName: "AIBotLambdaVPC",
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/25'),
      subnetConfiguration: [publicSubnetConfiguration, privateSubnetConfiguration]
    };
    this.vpc = new ec2.Vpc(this, 'AIBotLambdaVPC', vpcProps);

    const bucketProps: s3.BucketProps = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.DESTROY,
      accessControl: s3.BucketAccessControl.LOG_DELIVERY_WRITE,
      encryption: s3.BucketEncryption.S3_MANAGED,
      intelligentTieringConfigurations: [
        {
          name: "archive",
          archiveAccessTierTime: Duration.days(90),
          deepArchiveAccessTierTime: Duration.days(180),
        },
      ],
    };
    const s3LogBucket = new s3.Bucket(this, "s3LogBucket", bucketProps);
    const vpcFlowLogRole = new iam.Role(this, "vpcFlowLogRole", {
      assumedBy: new iam.ServicePrincipal("vpc-flow-logs.amazonaws.com"),
    });
    s3LogBucket.grantWrite(vpcFlowLogRole, "sharedVpcFlowLogs/*");
    new ec2.FlowLog(this, "sharedVpcFlowLogs", {
      destination: ec2.FlowLogDestination.toS3(s3LogBucket, "sharedVpcFlowLogs/"),
      trafficType: ec2.FlowLogTrafficType.ALL,
      flowLogName: "sharedVpcFlowLogs",
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
    });

    // Reduces internet traffic and improves security by routing internally.
    this.vpc.addGatewayEndpoint("dynamoDBEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.DYNAMODB,
    });

    // Security groups for Lambdas
    const noInboundAllOutboundSecurityGroup = new ec2.SecurityGroup(this, "noInboundAllOutboundSecurityGroup", {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: "No inbound / all outbound",
      securityGroupName: "noInboundAllOutboundSecurityGroup",
    });
    this.securityGroups.set("noInboundAllOutboundSecurityGroup", noInboundAllOutboundSecurityGroup);

    // Create exports from the CF template so that CF knows that other stacks depend on this stack.
    this.exportValue(this.vpc.vpcArn, {name: 'aiBotNetwork'});
  }
}