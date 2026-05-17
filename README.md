# Deswik DevOps Assessment — Platform Deployment

## Architecture Overview

```
GitHub Actions (OIDC)
      │
      ├─ validate: cdk synth
      ├─ build:    docker build → ECR push
      └─ deploy:   cdk deploy (Platform + Application stacks)
                         │
                   AWS VPC (ap-southeast-2)
                   ├─ Public:  ALB → Internet Gateway
                   └─ Private: ECS Fargate tasks → RDS (future)
```

Two CDK stacks are deployed independently:
- **`{env}-Platform`** — VPC, ECR repository, ECS cluster. Changes rarely.
- **`{env}-Application`** — ECS Fargate service, ALB, CloudWatch alarms. Deployed on every image push.

---

## Repository Structure

```
.
├── .github/workflows/
│   └── deploy.yml            # Build → push → CDK deploy pipeline
├── app/
│   ├── src/server.ts         # Node.js HTTP server (Hello World stub)
│   ├── Dockerfile            # Multi-stage build (builder + slim runtime)
│   ├── package.json
│   └── tsconfig.json
├── cdk/
│   ├── bin/app.ts            # CDK entry point — creates both stacks
│   ├── config/
│   │   └── environments.ts   # Per-environment sizing (dev / staging / prod)
│   ├── lib/
│   │   ├── constructs/
│   │   │   ├── networking.ts       # VPC, security groups, VPC Flow Logs
│   │   │   ├── ecr-repository.ts   # ECR + lifecycle policy + scan on push
│   │   │   ├── ecs-cluster.ts      # ECS cluster with Container Insights
│   │   │   ├── ecs-service.ts      # Fargate service + ALB + auto-scaling
│   │   │   └── observability.ts    # CloudWatch alarms, dashboard, SNS
│   │   └── stacks/
│   │       ├── platform-stack.ts   # Long-lived shared infra
│   │       └── application-stack.ts # Per-release app deployment
│   ├── cdk.json
│   ├── package.json
│   └── tsconfig.json
├── design.md                 # Architecture design proposal (Part 1)
└── README.md
```

---

## Prerequisites

| Tool | Minimum version |
|------|----------------|
| Node.js | 20.x |
| npm | 10.x |
| AWS CLI | 2.x |
| AWS CDK | 2.x (`npm install -g aws-cdk`) |
| Docker | 24.x |

---

## Local Deployment (manual)

### 1. Bootstrap CDK (first time only, per account/region)

```bash
# Replace with your AWS account ID and region
aws configure                     # or set AWS_PROFILE
cdk bootstrap aws://ACCOUNT_ID/ap-southeast-2
```

### 2. Install CDK dependencies

```bash
cd cdk
npm install
```

### 3. Deploy the Platform stack

The Platform stack provisions the VPC, ECR repository, and ECS cluster. It must be deployed before the Application stack.

```bash
cd cdk
npx cdk deploy dev-Platform -c environment=dev -c imageTag=latest
```

Note the `EcrRepositoryUri` output — you'll need it in the next step.

### 4. Build and push the Docker image

```bash
# Authenticate with ECR
aws ecr get-login-password --region ap-southeast-2 \
  | docker login --username AWS --password-stdin <ECR_REGISTRY>

# Build the image
cd app
docker build -t <ECR_REPOSITORY_URI>:latest .

# Push
docker push <ECR_REPOSITORY_URI>:latest
```

### 5. Deploy the Application stack

```bash
cd cdk
npx cdk deploy dev-Application -c environment=dev -c imageTag=latest
```

Note the `AlbDnsName` output. Open `http://<AlbDnsName>/` in your browser.

### 6. Tear down (cleanup)

```bash
cd cdk
npx cdk destroy --all -c environment=dev -c imageTag=latest
```

> **Note:** The ECR repository has `RemovalPolicy.RETAIN` — delete it manually via the console if desired.

---

## GitHub Actions (automated CI/CD)

### Required secrets

| Secret | Description |
|--------|-------------|
| `AWS_DEPLOY_ROLE_ARN` | ARN of the IAM role GitHub Actions assumes via OIDC |

### Setting up OIDC authentication

OIDC eliminates long-lived AWS credentials in GitHub Secrets. Set it up once:

**1. Create the OIDC provider in AWS (once per account):**

```bash
aws iam create-open-id-connect-provider \
  --url https://token.actions.githubusercontent.com \
  --client-id-list sts.amazonaws.com \
  --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1
```

**2. Create the IAM role with the following trust policy:**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/deswik-devops-assessment:*"
        }
      }
    }
  ]
}
```

**3. Attach permissions to the role:**

Minimum permissions required:
- `CloudFormation: *` (CDK uses CloudFormation)
- `ECR: *`
- `ECS: *`
- `EC2: *` (VPC, security groups)
- `IAM: *` (CDK creates roles — limit to `iam:PassRole` + `iam:CreateRole` in tighter setups)
- `CloudWatch: *`
- `SNS: *`
- `Logs: *`
- `ElasticLoadBalancingV2: *`

> For production, scope these to specific resources using condition keys. The CDK bootstrap process can also deploy a scoped `cdk-hnb659fds-cfn-exec-policy` role.

**4. Add the role ARN as a GitHub repository secret:**

```
Settings → Secrets and variables → Actions → New repository secret
Name:  AWS_DEPLOY_ROLE_ARN
Value: arn:aws:iam::ACCOUNT_ID:role/GitHubActionsDeployRole
```

### Pipeline behaviour

| Trigger | Jobs run |
|---------|----------|
| Pull Request to `main` | `validate` only (CDK synth — no AWS credentials needed) |
| Push to `main` | `validate` → `build` (ECR push) → `deploy` (CDK + smoke test) |
| Manual `workflow_dispatch` | Choose target environment; full pipeline |

---

## Verifying the deployment

```bash
# Get the ALB DNS name from CDK outputs
ALB=$(aws cloudformation describe-stacks \
  --stack-name dev-Application \
  --query "Stacks[0].Outputs[?OutputKey=='AlbDnsName'].OutputValue" \
  --output text)

# Test the root endpoint
curl http://$ALB/

# Test the health endpoint
curl http://$ALB/health
```

Expected response from `/`:
```json
{
  "message": "Hello from Deswik Platform!",
  "version": "sha-abc1234",
  "environment": "dev",
  "hostname": "ip-10-0-1-42.ap-southeast-2.compute.internal",
  "timestamp": "2026-05-17T00:00:00.000Z"
}
```

---

## CloudWatch

- **Log group:** `/ecs/dev/hello-world`
- **Dashboard:** `dev-platform` (in the CloudWatch console)
- **Alarms:** `dev-ecs-high-cpu`, `dev-ecs-high-memory`, `dev-alb-5xx-errors`, `dev-alb-p99-latency`

Run a Logs Insights query:

```
fields @timestamp, level, message, url, durationMs
| filter level = "ERROR"
| sort @timestamp desc
| limit 50
```

---

## ECS Exec (live debugging)

```bash
# List running tasks
aws ecs list-tasks --cluster dev-platform --region ap-southeast-2

# Open an interactive shell on a running task
aws ecs execute-command \
  --cluster dev-platform \
  --task <TASK_ARN> \
  --container App \
  --interactive \
  --command "/bin/sh"
```

---

## Configuration: environments.ts

Adjust per-environment sizing without touching any stack code:

```typescript
// cdk/config/environments.ts
prod: {
  taskCpu: 1024,       // 1 vCPU
  taskMemoryMiB: 2048, // 2 GB
  desiredCount: 2,     // minimum tasks (auto-scaling adds on top)
  natGateways: 3,      // one per AZ — no cross-AZ NAT charges
}
```

---

## Extending this MVP

| What | Where to add |
|------|--------------|
| HTTPS / ACM certificate | `ecs-service.ts` — add HTTPS listener + `Certificate` prop |
| RDS SQL Server | New `rds.ts` construct + reference in `platform-stack.ts` |
| AWS WAF | `ecs-service.ts` — `new wafv2.CfnWebACLAssociation(...)` |
| X-Ray tracing | Add `xray-daemon` sidecar container in `ecs-service.ts` |
| Secrets Manager DB creds | `ecs-service.ts` — `container.addSecret(...)` instead of env vars |
| Blue/green deployment | Replace rolling update with `EcsDeploymentConfig.ALL_AT_ONCE` + CodeDeploy |

---

## Cost estimate (dev environment, ap-southeast-2)

| Service | Estimated monthly cost |
|---------|----------------------|
| ECS Fargate (0.25 vCPU / 512 MB, ~730 h) | ~$15 |
| ALB | ~$20 |
| NAT Gateway (1×) | ~$35 |
| ECR storage (1 GB) | ~$0.10 |
| CloudWatch Logs (5 GB) | ~$3 |
| **Total (dev)** | **~$73/month** |

Production (3 AZ, 3 NAT GWs, larger tasks): ~$250–400/month before application traffic costs.
