import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import { Construct } from 'constructs';

export interface EcsClusterProps {
  readonly clusterName: string;
  readonly vpc: ec2.Vpc;
}

export class EcsCluster extends Construct {
  public readonly cluster: ecs.Cluster;

  constructor(scope: Construct, id: string, props: EcsClusterProps) {
    super(scope, id);

    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: props.clusterName,
      vpc: props.vpc,
      containerInsights: true,
      enableFargateCapacityProviders: true,
    });
  }
}
