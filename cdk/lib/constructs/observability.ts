import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cw_actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface ObservabilityProps {
  readonly environmentName: string;
  readonly service: ecs.FargateService;
  readonly alb: elbv2.ApplicationLoadBalancer;
  readonly logGroup: logs.LogGroup;
  readonly cpuAlarmThreshold?: number;
  readonly memoryAlarmThreshold?: number;
}

export class Observability extends Construct {
  public readonly alarmTopic: sns.Topic;
  public readonly dashboard: cloudwatch.Dashboard;

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id);

    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `${props.environmentName}-platform-alarms`,
      displayName: `${props.environmentName} Platform Alarms`,
    });

    const cpuAlarm = new cloudwatch.Alarm(this, 'CpuAlarm', {
      alarmName: `${props.environmentName}-ecs-high-cpu`,
      alarmDescription: 'ECS average CPU exceeded threshold for two consecutive periods',
      metric: props.service.metricCpuUtilization({
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: props.cpuAlarmThreshold ?? 80,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    cpuAlarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));
    cpuAlarm.addOkAction(new cw_actions.SnsAction(this.alarmTopic));

    const memoryAlarm = new cloudwatch.Alarm(this, 'MemoryAlarm', {
      alarmName: `${props.environmentName}-ecs-high-memory`,
      alarmDescription: 'ECS average memory exceeded threshold',
      metric: props.service.metricMemoryUtilization({
        period: cdk.Duration.minutes(5),
        statistic: 'Average',
      }),
      threshold: props.memoryAlarmThreshold ?? 80,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    memoryAlarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));

    const albErrorAlarm = new cloudwatch.Alarm(this, 'AlbErrorAlarm', {
      alarmName: `${props.environmentName}-alb-5xx-errors`,
      alarmDescription: 'ALB 5xx error rate is elevated',
      metric: props.alb.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT, {
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    albErrorAlarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));

    const responseTimeAlarm = new cloudwatch.Alarm(this, 'ResponseTimeAlarm', {
      alarmName: `${props.environmentName}-alb-p99-latency`,
      alarmDescription: 'ALB p99 response time exceeded 2s',
      metric: props.alb.metrics.targetResponseTime({
        period: cdk.Duration.minutes(5),
        statistic: 'p99',
      }),
      threshold: 2,
      evaluationPeriods: 3,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    responseTimeAlarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));

    const errorMetricFilter = new logs.MetricFilter(this, 'ErrorMetricFilter', {
      logGroup: props.logGroup,
      filterPattern: logs.FilterPattern.anyTerm('ERROR', 'error', 'Exception', 'FATAL'),
      metricNamespace: `Deswik/${props.environmentName}`,
      metricName: 'ApplicationErrorCount',
      metricValue: '1',
      defaultValue: 0,
    });

    const appErrorAlarm = new cloudwatch.Alarm(this, 'AppErrorAlarm', {
      alarmName: `${props.environmentName}-application-errors`,
      alarmDescription: 'Application error log rate is elevated',
      metric: errorMetricFilter.metric({ period: cdk.Duration.minutes(5), statistic: 'Sum' }),
      threshold: 5,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    appErrorAlarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));

    // composite alarm fires only when CPU and 5xx errors correlate — avoids load-test noise
    const compositeAlarm = new cloudwatch.CompositeAlarm(this, 'ServiceDegradedAlarm', {
      compositeAlarmName: `${props.environmentName}-service-degraded`,
      alarmDescription: 'Correlated CPU spike and 5xx errors — likely a real incident',
      alarmRule: cloudwatch.AlarmRule.allOf(cpuAlarm, albErrorAlarm),
    });
    compositeAlarm.addAlarmAction(new cw_actions.SnsAction(this.alarmTopic));

    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `${props.environmentName}-platform`,
      defaultInterval: cdk.Duration.hours(3),
    });

    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `# ${props.environmentName.toUpperCase()} — Deswik Platform`,
        width: 24,
        height: 2,
      }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.AlarmWidget({ alarm: cpuAlarm, title: 'CPU Utilisation', width: 6, height: 6 }),
      new cloudwatch.AlarmWidget({ alarm: memoryAlarm, title: 'Memory Utilisation', width: 6, height: 6 }),
      new cloudwatch.AlarmWidget({ alarm: albErrorAlarm, title: 'ALB 5xx / 5 min', width: 6, height: 6 }),
      new cloudwatch.AlarmWidget({ alarm: responseTimeAlarm, title: 'p99 Latency (s)', width: 6, height: 6 }),
    );

    this.dashboard.addWidgets(
      new cloudwatch.LogQueryWidget({
        logGroupNames: [props.logGroup.logGroupName],
        title: 'Recent Application Logs',
        queryLines: [
          'fields @timestamp, level, message, url, durationMs',
          '| sort @timestamp desc',
          '| limit 100',
        ],
        width: 24,
        height: 8,
      }),
    );
  }
}
