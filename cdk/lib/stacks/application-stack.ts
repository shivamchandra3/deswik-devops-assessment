import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/environments';
import { EcsFargateService } from '../constructs/ecs-service';
import { Observability } from '../constructs/observability';
import { PlatformStack } from './platform-stack';

export interface ApplicationStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
  readonly platformStack: PlatformStack;
  readonly imageTag: string;
}

export class ApplicationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);

    const { config, platformStack, imageTag } = props;

    const ecsService = new EcsFargateService(this, 'EcsService', {
      environmentName: config.environmentName,
      cluster: platformStack.ecsCluster.cluster,
      repository: platformStack.ecrRepository.repository,
      imageTag,
      vpc: platformStack.networking.vpc,
      albSecurityGroup: platformStack.networking.albSecurityGroup,
      appSecurityGroup: platformStack.networking.appSecurityGroup,
      cpu: config.taskCpu,
      memoryLimitMiB: config.taskMemoryMiB,
      desiredCount: config.desiredCount,
    });

    new Observability(this, 'Observability', {
      environmentName: config.environmentName,
      service: ecsService.service,
      alb: ecsService.alb,
      logGroup: ecsService.logGroup,
      cpuAlarmThreshold: 80,
      memoryAlarmThreshold: 80,
    });

    new cdk.CfnOutput(this, 'DeployedImageTag', {
      value: imageTag,
      description: 'Image tag currently running in this environment',
    });
  }
}
