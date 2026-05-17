import * as cdk from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import { Construct } from 'constructs';

export interface EcrRepositoryProps {
  readonly repositoryName: string;
  readonly maxImageCount?: number;
}

export class EcrRepository extends Construct {
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: EcrRepositoryProps) {
    super(scope, id);

    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: props.repositoryName,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.MUTABLE,
      lifecycleRules: [
        {
          description: `Keep the last ${props.maxImageCount ?? 20} tagged images`,
          maxImageCount: props.maxImageCount ?? 20,
          tagStatus: ecr.TagStatus.TAGGED,
          tagPrefixList: ['v', 'sha-'],
        },
        {
          description: 'Remove untagged layers after 7 days',
          maxImageAge: cdk.Duration.days(7),
          tagStatus: ecr.TagStatus.UNTAGGED,
        },
      ],
    });
  }
}
