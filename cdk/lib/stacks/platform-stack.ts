import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { EnvironmentConfig } from '../../config/environments';
import { EcsCluster } from '../constructs/ecs-cluster';
import { EcrRepository } from '../constructs/ecr-repository';
import { Networking } from '../constructs/networking';

export interface PlatformStackProps extends cdk.StackProps {
  readonly config: EnvironmentConfig;
}

// Shared infrastructure that changes infrequently — kept separate from ApplicationStack
// so routine deploys (new image tag) never touch VPC or cluster config
export class PlatformStack extends cdk.Stack {
  public readonly networking: Networking;
  public readonly ecrRepository: EcrRepository;
  public readonly ecsCluster: EcsCluster;

  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);

    const { config } = props;

    this.networking = new Networking(this, 'Networking', {
      environmentName: config.environmentName,
      cidr: config.vpcCidr,
      maxAzs: config.maxAzs,
      natGateways: config.natGateways,
    });

    this.ecrRepository = new EcrRepository(this, 'EcrRepository', {
      repositoryName: `${config.environmentName}/hello-world`,
    });

    this.ecsCluster = new EcsCluster(this, 'EcsCluster', {
      clusterName: `${config.environmentName}-platform`,
      vpc: this.networking.vpc,
    });

    new cdk.CfnOutput(this, 'VpcId', {
      value: this.networking.vpc.vpcId,
      exportName: `${config.environmentName}-vpc-id`,
    });

    new cdk.CfnOutput(this, 'EcrRepositoryUri', {
      value: this.ecrRepository.repository.repositoryUri,
      exportName: `${config.environmentName}-ecr-uri`,
      description: 'Full URI — use for docker push and task definition image reference',
    });

    new cdk.CfnOutput(this, 'EcsClusterName', {
      value: this.ecsCluster.cluster.clusterName,
      exportName: `${config.environmentName}-cluster-name`,
    });
  }
}
