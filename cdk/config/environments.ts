export interface EnvironmentConfig {
  readonly environmentName: string;
  /** AWS account ID — leave undefined to use CDK_DEFAULT_ACCOUNT */
  readonly account?: string;
  /** Deployment region — ap-southeast-2 (Sydney) for Deswik */
  readonly region: string;
  readonly vpcCidr: string;
  readonly maxAzs: number;
  /**
   * Number of NAT Gateways.
   * Dev: 1 (cheapest). Prod: one per AZ to eliminate cross-AZ traffic cost
   * and single-NAT-GW as a failure domain.
   */
  readonly natGateways: number;
  /** Fargate task CPU units (256 = 0.25 vCPU) */
  readonly taskCpu: number;
  /** Fargate task memory in MiB */
  readonly taskMemoryMiB: number;
  /** Baseline ECS task count — auto-scaling adds on top */
  readonly desiredCount: number;
}

export const environments: Record<string, EnvironmentConfig> = {
  dev: {
    environmentName: 'dev',
    region: 'ap-southeast-2',
    vpcCidr: '10.0.0.0/16',
    maxAzs: 2,
    natGateways: 1,
    taskCpu: 256,
    taskMemoryMiB: 512,
    desiredCount: 1,
  },

  staging: {
    environmentName: 'staging',
    region: 'ap-southeast-2',
    vpcCidr: '10.1.0.0/16',
    maxAzs: 2,
    natGateways: 2,
    taskCpu: 512,
    taskMemoryMiB: 1024,
    desiredCount: 2,
  },

  prod: {
    environmentName: 'prod',
    region: 'ap-southeast-2',
    vpcCidr: '10.2.0.0/16',
    maxAzs: 3,
    natGateways: 3,
    taskCpu: 1024,
    taskMemoryMiB: 2048,
    desiredCount: 2,
  },
};
