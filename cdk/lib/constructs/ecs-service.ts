import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';

export interface EcsFargateServiceProps {
  readonly environmentName: string;
  readonly cluster: ecs.Cluster;
  readonly repository: ecr.Repository;
  readonly imageTag: string;
  readonly vpc: ec2.Vpc;
  readonly albSecurityGroup: ec2.SecurityGroup;
  readonly appSecurityGroup: ec2.SecurityGroup;
  readonly cpu?: number;
  readonly memoryLimitMiB?: number;
  readonly desiredCount?: number;
  readonly containerPort?: number;
}

export class EcsFargateService extends Construct {
  public readonly service: ecs.FargateService;
  public readonly alb: elbv2.ApplicationLoadBalancer;
  public readonly taskDefinition: ecs.FargateTaskDefinition;
  public readonly logGroup: logs.LogGroup;

  constructor(scope: Construct, id: string, props: EcsFargateServiceProps) {
    super(scope, id);

    const containerPort = props.containerPort ?? 8080;

    this.logGroup = new logs.LogGroup(this, 'ServiceLogGroup', {
      logGroupName: `/ecs/${props.environmentName}/hello-world`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const executionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AmazonECSTaskExecutionRolePolicy',
        ),
      ],
    });

    // Task role is what the running application itself can do — keep this minimal
    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `Runtime permissions for hello-world (${props.environmentName})`,
    });

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'ssmmessages:CreateControlChannel',
          'ssmmessages:CreateDataChannel',
          'ssmmessages:OpenControlChannel',
          'ssmmessages:OpenDataChannel',
        ],
        resources: ['*'],
      }),
    );

    this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: props.cpu ?? 256,
      memoryLimitMiB: props.memoryLimitMiB ?? 512,
      executionRole,
      taskRole,
    });

    this.taskDefinition.addContainer('App', {
      image: ecs.ContainerImage.fromEcrRepository(props.repository, props.imageTag),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: 'hello-world',
        logGroup: this.logGroup,
      }),
      environment: {
        PORT: String(containerPort),
        ENVIRONMENT: props.environmentName,
        APP_VERSION: props.imageTag,
      },
      healthCheck: {
        command: ['CMD-SHELL', `wget -qO- http://localhost:${containerPort}/health || exit 1`],
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        retries: 3,
        startPeriod: cdk.Duration.seconds(60),
      },
      stopTimeout: cdk.Duration.seconds(30),
      portMappings: [{ containerPort }],
    });

    this.alb = new elbv2.ApplicationLoadBalancer(this, 'Alb', {
      vpc: props.vpc,
      internetFacing: true,
      securityGroup: props.albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      deletionProtection: false,
    });

    const targetGroup = new elbv2.ApplicationTargetGroup(this, 'TargetGroup', {
      vpc: props.vpc,
      port: containerPort,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targetType: elbv2.TargetType.IP,
      healthCheck: {
        path: '/health',
        interval: cdk.Duration.seconds(30),
        timeout: cdk.Duration.seconds(5),
        healthyThresholdCount: 2,
        unhealthyThresholdCount: 3,
        healthyHttpCodes: '200',
      },
      deregistrationDelay: cdk.Duration.seconds(30),
    });

    this.alb.addListener('HttpListener', {
      port: 80,
      defaultTargetGroups: [targetGroup],
    });

    this.service = new ecs.FargateService(this, 'Service', {
      cluster: props.cluster,
      taskDefinition: this.taskDefinition,
      desiredCount: props.desiredCount ?? 2,
      securityGroups: [props.appSecurityGroup],
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      capacityProviderStrategies: [
        // one on-demand task as a stable base, spot fills the rest (~70% cheaper)
        { capacityProvider: 'FARGATE', weight: 1, base: 1 },
        { capacityProvider: 'FARGATE_SPOT', weight: 2 },
      ],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: true,
    });

    targetGroup.addTarget(this.service);

    const scaling = this.service.autoScaleTaskCount({
      minCapacity: props.desiredCount ?? 1,
      maxCapacity: 10,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 60,
      scaleInCooldown: cdk.Duration.seconds(120),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(120),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    new cdk.CfnOutput(this, 'AlbDnsName', {
      value: this.alb.loadBalancerDnsName,
      description: 'ALB endpoint',
      exportName: `${props.environmentName}-alb-dns`,
    });
  }
}
