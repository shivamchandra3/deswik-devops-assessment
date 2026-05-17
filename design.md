# Architecture Design: Legacy .NET + SQL Server → AWS SaaS Platform

## Overview

Rather than treating this as a straight lift-and-shift, I've designed it in phases — get something running and observable in AWS quickly, then modernise the data layer and move toward multi-tenancy. The decisions below reflect that: I've picked services that are straightforward to operate today and easy to evolve, rather than reaching for the most sophisticated option upfront.

---

## Architecture Diagram

```
  ┌──────────────────────────────────────────────────────────────────────────────┐
  │  AWS Account (ap-southeast-2 — Sydney)                                       │
  │                                                                              │
  │  ┌──────────────────────────────────────────────────────────────────────┐   │
  │  │  VPC  10.0.0.0/16                                                    │   │
  │  │                                                                      │   │
  │  │   Public Subnets  (AZ-a / AZ-b / AZ-c)                              │   │
  │  │   ┌───────────────────────────────────────────────────────────────┐  │   │
  │  │   │  Internet Gateway ──► Application Load Balancer (HTTPS)       │  │   │
  │  │   │                       NAT Gateway (egress for private tasks)   │  │   │
  │  │   └───────────────────────────────────────────────────────────────┘  │   │
  │  │                              │                                        │   │
  │  │   Private Subnets  (AZ-a / AZ-b / AZ-c)                             │   │
  │  │   ┌───────────────────────────────────────────────────────────────┐  │   │
  │  │   │  ECS Fargate Tasks (.NET app container)                       │  │   │
  │  │   │       ↕  auto-scales on CPU / memory (target-tracking)        │  │   │
  │  │   │  Amazon RDS (SQL Server or Aurora PostgreSQL)  ← Multi-AZ     │  │   │
  │  │   │  AWS Secrets Manager  (DB credentials, API keys)              │  │   │
  │  │   └───────────────────────────────────────────────────────────────┘  │   │
  │  └──────────────────────────────────────────────────────────────────────┘   │
  │                                                                              │
  │  Supporting services                                                         │
  │  ┌──────────┐  ┌────────────────┐  ┌──────────────────┐  ┌──────────────┐  │
  │  │ Amazon   │  │ AWS Secrets    │  │ Amazon           │  │ AWS          │  │
  │  │ ECR      │  │ Manager + KMS  │  │ CloudWatch       │  │ CloudTrail   │  │
  │  │ (images) │  │ (secrets/keys) │  │ (logs + alarms)  │  │ + GuardDuty  │  │
  │  └──────────┘  └────────────────┘  └──────────────────┘  └──────────────┘  │
  │                                                                              │
  │  CI/CD                                                                       │
  │  GitHub → GitHub Actions (OIDC) → ECR push → CDK deploy → ECS rolling      │
  └──────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Core Infrastructure

### 1.1 Compute — Amazon ECS Fargate

**Chosen:** ECS Fargate (serverless containers)

**Why not EC2-backed ECS:** Fargate eliminates the need to manage EC2 instance patching, capacity planning, and OS hardening. For a 200-developer organisation moving quickly, the operational overhead reduction is material.

**Why not EKS (Kubernetes):** EKS is the right answer when you need workload-level isolation, advanced scheduling, or have teams already fluent in Kubernetes. For an initial SaaS lift-and-shift of a .NET monolith, EKS adds 3–6 months of platform engineering overhead before the first app team ships. Fargate delivers the container-native benefits today, and migrating to EKS later is straightforward once the application is containerised.

**Why not App Runner / Elastic Beanstalk:** These abstract away too much; they limit the security surface and observability controls a mature platform team needs.

**Task configuration (MVP):**

| Environment | CPU    | Memory | Desired | Max (auto-scale) |
|-------------|--------|--------|---------|-----------------|
| dev         | 0.25   | 512 MB | 1       | 5               |
| staging     | 0.5    | 1 GB   | 2       | 8               |
| prod        | 1.0    | 2 GB   | 2       | 10              |

**Capacity strategy:** 1 on-demand Fargate task as a stable base + FARGATE_SPOT for scale-out. Spot can be ~70% cheaper for stateless HTTP workloads that tolerate 2-minute interruption windows.

### 1.2 Networking — VPC Design

A two-tier VPC with public and private subnets across multiple Availability Zones:

- **Public subnets:** Application Load Balancer, NAT Gateways. The internet boundary lives here.
- **Private subnets:** ECS Fargate tasks, RDS instances. Nothing in private subnets is directly reachable from the internet.
- **NAT Gateways:** One per AZ in production (eliminates cross-AZ NAT traffic charges and the single-NAT-GW failure domain). One shared in dev/staging to minimise cost.
- **VPC Flow Logs:** All traffic logged to CloudWatch Logs for forensics and compliance audit trails.

**Security Group chain:**

```
Internet ──► ALB SG (allows 80, 443 from 0.0.0.0/0)
              └──► App SG (allows 8080 from ALB SG only)
                    └──► RDS SG (allows 1433/5432 from App SG only)
```

No task has a public IP. The only internet-facing endpoint is the ALB.

### 1.3 Load Balancing — Application Load Balancer (ALB)

- **Layer 7** load balancing with path-based routing (enables future multi-service SaaS architecture on the same domain).
- **Health checks** on `/health` — deregisters unhealthy tasks before routing traffic.
- **Access logs** to S3 — feeds SIEM or Athena queries for traffic analysis.
- **Future:** AWS WAF attached to the ALB to block OWASP Top 10, rate-limit per-tenant.

### 1.4 Container Registry — Amazon ECR

- **Image scanning on push** (Amazon Inspector integration) — CVE detection at ingest time, not at runtime.
- **Lifecycle policies:** retain last 20 tagged images; purge untagged layers after 7 days (cost hygiene).
- **Private registry** — no images are publicly accessible.

### 1.5 Data — Amazon RDS

#### Target Data Store

Two valid options depending on risk tolerance:

| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| **RDS for SQL Server** | Zero schema changes, fastest migration, familiar tooling | SQL Server licence cost, less cloud-native | MVP / lift-and-shift |
| **Aurora PostgreSQL** | 5× cheaper than SQL Server, serverless scaling option, fully managed | Requires schema conversion via AWS SCT | Phase 2 modernisation |

**Recommended path:** RDS for SQL Server at MVP → Aurora PostgreSQL after application is stable in AWS.

**RDS configuration:**
- Multi-AZ deployment (synchronous standby in a second AZ for automatic failover in <60 s).
- Automated backups with 7-day retention, point-in-time recovery.
- Encryption at rest with AWS KMS customer-managed key.
- Credentials stored in AWS Secrets Manager (auto-rotated every 30 days).
- No public accessibility — only the App security group can reach the DB port.

---

## 2. Data Migration Strategy

### Phase 1 — Schema assessment (Week 1–2)
- Run **AWS Schema Conversion Tool (SCT)** against the source SQL Server instance.
- Generate a conversion complexity report; identify stored procedures, CLR objects, and SSIS packages that need manual rewrite.
- For RDS for SQL Server (MVP): SCT report is mainly informational; schema transfers 1:1.

### Phase 2 — Continuous replication (Week 3–6)
- Stand up **AWS Database Migration Service (DMS)** with a Full Load + CDC (Change Data Capture) task.
- DMS replicates the source on-prem SQL Server to the target RDS instance continuously, with lag typically under 1 second.
- Application continues pointing to on-premises DB during this phase — zero downtime for users.

### Phase 3 — Validation (Week 6–7)
- Row count and checksum validation between source and target.
- Shadow traffic: run queries against both endpoints, compare results.
- Test application against the RDS endpoint in a staging environment.

### Phase 4 — Cutover (Week 8 — maintenance window)
- Put application into read-only mode (drain in-flight writes).
- Wait for DMS replication lag to hit zero.
- Update application environment variable `DB_HOST` to point to RDS.
- Promote ECS task count (blue/green cutover optional for extra safety).
- Monitor for 30 minutes; roll back by flipping the env var if issues arise.

---

## 3. Security Architecture

Security is implemented as defence-in-depth — multiple independent controls, each of which limits blast radius if another fails.

### Identity & Access

| Control | Detail |
|---------|--------|
| **IAM Roles (not users)** | ECS tasks use task roles; GitHub Actions uses OIDC (no long-lived keys stored anywhere) |
| **Least privilege** | Task role has only the permissions the application code actually calls |
| **Execution role** | Separate from task role — ECS agent uses it to pull images and ship logs |

### Network Security

| Control | Detail |
|---------|--------|
| **Private subnets** | Tasks and DB are not internet-routable |
| **Security group chain** | Internet → ALB SG → App SG → RDS SG — each hop is explicitly scoped |
| **VPC Flow Logs** | All accepted and rejected flows captured for forensic analysis |
| **AWS WAF (next step)** | OWASP Top 10 rules, rate limiting per IP/tenant on the ALB |

### Data Security

| Control | Detail |
|---------|--------|
| **Encryption in transit** | TLS between ALB and clients; TLS between app and RDS (enforced via RDS parameter group) |
| **Encryption at rest** | RDS encrypted with KMS CMK; ECR images encrypted at rest; CloudWatch Logs encrypted |
| **Secrets Manager** | DB credentials, third-party API keys — never in environment variables or source code |
| **KMS key rotation** | Annual automatic rotation; CMK per environment |

### Detection & Response

| Control | Detail |
|---------|--------|
| **Amazon GuardDuty** | Continuous threat intelligence on VPC flow logs, DNS, and CloudTrail events |
| **AWS CloudTrail** | API-level audit trail for all AWS control plane actions |
| **ECR image scanning** | Amazon Inspector identifies CVEs at push time; blocks high-severity images in prod via a Lambda/Step Function gate |
| **CloudWatch Alarms → SNS** | CPU, memory, 5xx rate, p99 latency, application error log count |
| **Composite alarm** | Fires only on correlated symptoms (e.g., CPU spike + 5xx errors) to reduce alert fatigue |

### CI/CD Security

- **OIDC authentication** — GitHub Actions authenticates via short-lived OIDC tokens. IAM trust policy scoped to `repo:org/repo:ref:refs/heads/main`. No AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY stored in GitHub Secrets.
- **ECR image tag immutability** — in production, tags are immutable. `latest` is only used for development.
- **Separate deploy role per environment** — GitHub cannot deploy to prod without a separate trust policy and manual approval gate.

---

## 4. CI/CD Pipeline

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Developer pushes to main branch                                           │
│         │                                                                  │
│  [Job 1: Validate]                                                         │
│  ├─ npm ci                                                                 │
│  └─ cdk synth   ← fails fast on TypeScript errors or CDK policy violations │
│         │                                                                  │
│  [Job 2: Build & Push]  (main branch only)                                 │
│  ├─ OIDC → assume deploy role                                              │
│  ├─ cdk deploy {env}-Platform   ← ensures ECR exists                      │
│  ├─ docker build --platform linux/amd64 (multi-stage)                     │
│  ├─ docker push → ECR (image tag = git short SHA)                         │
│  └─ ECR scan triggered automatically                                       │
│         │                                                                  │
│  [Job 3: Deploy Application]  (depends on Job 2)                          │
│  ├─ cdk deploy {env}-Application -c imageTag=sha-abc1234                  │
│  │    └─ CloudFormation updates task definition → ECS rolling update       │
│  │    └─ circuit breaker: auto-rollback if health checks fail              │
│  └─ smoke test: curl /health via ALB for up to 150 s                      │
└────────────────────────────────────────────────────────────────────────────┘
```

**Key design choices:**

- **Two CDK stacks, two deployment frequencies.** The Platform stack (VPC, ECR, ECS cluster) is deployed on infrastructure changes. The Application stack is deployed on every merge — changing `imageTag` in CDK context is what drives a new ECS task revision, making image-tag the single source of truth for what's running.
- **Rolling deployment** (default ECS behaviour) with a circuit breaker. Zero-downtime for active users; automatic rollback on degraded health checks.
- **Smoke test in CI** — a quick `curl /health` confirms the ALB is routing to the new tasks before the pipeline marks a success.

---

## 5. Observability Strategy

Observability is built on three pillars — **logs, metrics, and (future) traces**.

### Logs

- **Structured JSON logging** from the application (`level`, `timestamp`, `url`, `durationMs` fields).
- All container stdout/stderr captured by `awslogs` driver → CloudWatch Logs.
- **CloudWatch Logs Insights** queries run over structured fields — no manual grep.
- **Log retention:** 30 days application logs, 90 days VPC flow logs, 12 months CloudTrail.
- **Future:** Export to S3 + Athena for long-term analysis and compliance reporting.

### Metrics

| Signal | Source | Alarm |
|--------|--------|-------|
| ECS CPU utilisation | Container Insights | > 80% for 10 min |
| ECS memory utilisation | Container Insights | > 80% for 10 min |
| ALB 5xx error count | ALB access metrics | > 10 in 5 min |
| ALB p99 latency | ALB metrics | > 2 s for 15 min |
| Application error log count | CloudWatch Logs metric filter | > 5 in 5 min |
| Composite (CPU + 5xx) | CloudWatch Composite Alarm | fires on correlated failures |

**CloudWatch Dashboard** consolidates all signals — alarm widgets, time-series graphs, and a Logs Insights table of recent structured log lines — in a single operational view.

### Distributed Tracing (next step)

Add **AWS X-Ray** SDK to the .NET application. ECS Fargate supports X-Ray via a sidecar daemon container added to the task definition. X-Ray provides:
- End-to-end request tracing from ALB → ECS → RDS.
- Service map visualisation.
- Automatic identification of slow subsystem calls (N+1 queries, etc).

---

## 6. Scalability

### Horizontal scaling (immediate)

ECS Service auto-scaling with target-tracking policies:
- **Scale-out:** triggered at 60% average CPU or 70% memory — proactive, not reactive.
- **Scale-in cooldown:** 120 s — prevents thrashing.
- **Fargate Spot backfill:** cost-optimised scale-out using Spot capacity.

### Vertical scaling (configuration)

Task CPU/memory are defined per-environment in `cdk/config/environments.ts`. Changing them triggers a rolling replacement with zero downtime.

### Database scaling

- **Read replicas:** add RDS read replicas for read-heavy analytical queries. Application uses separate read-only connection string.
- **Aurora Serverless v2 (future):** scales Aurora capacity continuously from 0.5 ACU to 128 ACU — eliminates over-provisioning and handles bursty SaaS workloads without a maintenance window.

### Responding to more scrutiny: multi-region

For a global mining customer base:
1. Deploy the same CDK stacks to `us-east-1` and `eu-west-1`.
2. **Amazon Route 53 latency routing** or **Global Accelerator** to direct users to the nearest healthy ALB.
3. **RDS Global Database** (Aurora) for cross-region read replicas with ~1 s replication lag and <1 min promotion RTO.

---

## 7. SaaS Multi-tenancy Direction

The current MVP is single-tenant. The platform evolves toward SaaS using a **silo-to-pool** migration path:

| Stage | Model | Isolation | When |
|-------|-------|-----------|------|
| **MVP** | Single-tenant silo | Full — separate stack per customer | Now |
| **Phase 2** | Pool model | Shared ECS cluster, tenant ID in JWT | 6–12 months |
| **Phase 3** | Hybrid | Large customers get dedicated RDS; SMB pool shared Aurora | 12–24 months |

For pool-model SaaS:
- **Tenant context propagation:** tenant ID extracted from JWT/API key at the ALB (via a Lambda@Edge or WAF rule), forwarded as an HTTP header, and threaded through all log lines for observability.
- **Row-Level Security (RLS) in Aurora** ensures one tenant cannot access another's data even if the application has a bug.
- **AWS Bedrock integration:** per-tenant inference requests routed through a central API Gateway + Lambda authoriser that validates tenant entitlements before forwarding to Bedrock — giving Deswik control over cost allocation and rate limiting per customer.

---

## 8. Migration Phases

| Phase | Duration | Goal | Risk |
|-------|----------|------|------|
| **0 — Containerise** | 2–4 weeks | Dockerise .NET app, run locally | Low |
| **1 — Lift-and-shift** | 4–6 weeks | Deploy container to ECS Fargate, RDS SQL Server, CI/CD pipeline | Medium |
| **2 — Modernise** | 8–12 weeks | Migrate RDS to Aurora PostgreSQL, add X-Ray tracing, WAF, secrets rotation | Medium |
| **3 — SaaS** | 3–6 months | Multi-tenant architecture, tenant onboarding automation, cost allocation | High |

---

## 9. Tradeoffs & Decisions

| Decision | Alternative | Why this choice |
|----------|-------------|-----------------|
| ECS Fargate | EKS | Lower ops overhead for MVP; EKS viable when platform team grows |
| Rolling deployment | Blue/Green (CodeDeploy) | Simpler; circuit breaker + health checks provide sufficient safety. Blue/green is better when cutover must be instantaneous |
| RDS SQL Server | Aurora PostgreSQL | Fastest migration path — zero schema risk. PostgreSQL in Phase 2 after app is stable |
| Two CDK stacks | One monolith stack | Decouples infra change risk from app deployment risk |
| FARGATE_SPOT for scale | All on-demand | ~70% cost saving; acceptable for stateless HTTP workloads |
| CDK TypeScript | Terraform | Aligns with Deswik's existing CDK investment; type-safety prevents class of config mistakes |

---

## 10. Future Improvements

- **HTTPS / ACM certificate** on the ALB — currently HTTP only (MVP)
- **AWS WAF** on the ALB — OWASP Top 10, rate limiting, geo-blocking
- **Private Link / Interface Endpoints** for ECR, Secrets Manager, CloudWatch — eliminate NAT Gateway data transfer costs for AWS service calls
- **AWS X-Ray** distributed tracing with the .NET SDK
- **Container image hardening** — distroless or Chainguard base image; `readOnlyRootFilesystem: true`
- **ECS task placement constraints** — spread across AZs explicitly
- **S3 access logging** on the ALB → Athena for long-term traffic analysis
- **Service Control Policies (SCPs)** at the AWS Organisation level — prevent any stack from creating public S3 buckets or disabling GuardDuty
- **CDK Pipelines (self-mutating)** — move from GitHub Actions CDK deploy to a native CDK Pipeline for safer multi-stage promotion with built-in change-set approval
- **Tenant onboarding automation** — Step Functions state machine provisions tenant resources (RDS schema, IAM policy, Bedrock limits) end-to-end without manual ops
