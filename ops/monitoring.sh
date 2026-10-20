#!/usr/bin/env bash
# Operator-run after DNS, TLS, host agent and the first off-AWS status report exist.
set -euo pipefail
[[ $# == 3 ]] || { echo "Usage: monitoring.sh API_HOST EC2_INSTANCE_ID RDS_INSTANCE_ID" >&2; exit 2; }
host=$1 ec2=$2 rds=$3
[[ $host =~ ^[a-z0-9.-]+$ && $host == *.* && $ec2 =~ ^i-[a-f0-9]+$ && $rds =~ ^[a-z][a-z0-9-]+$ ]] || {
  echo "Invalid host or instance identifier" >&2; exit 2;
}
export AWS_PAGER=
email=$(aws ssm get-parameter --region ap-south-1 --name /ygo/ops/alarm-email --with-decryption --query Parameter.Value --output text)
[[ -n $email && $email == *@* && $email != *[[:space:]]* ]] || { echo "Invalid alarm email parameter" >&2; exit 1; }

for region in ap-south-1 us-east-1; do
  topic=$(aws sns create-topic --region "$region" --name ygo-operations --query TopicArn --output text)
  # SNS confirmation must be accepted by the owner before alarm activation is complete.
  aws sns subscribe --region "$region" --topic-arn "$topic" --protocol email --notification-endpoint "$email" >/dev/null
  if [[ $region == ap-south-1 ]]; then mumbai_topic=$topic; else health_topic=$topic; fi
done
unset email

for group in /ygo/api/production /ygo/api/staging /ygo/systemd; do
  existing=$(aws logs describe-log-groups --region ap-south-1 --log-group-name-prefix "$group" \
    --query "logGroups[?logGroupName=='$group'].logGroupName | [0]" --output text)
  [[ $existing != None ]] || aws logs create-log-group --region ap-south-1 --log-group-name "$group"
  aws logs put-retention-policy --region ap-south-1 --log-group-name "$group" --retention-in-days 7
done

aws logs put-metric-filter --region ap-south-1 --log-group-name /ygo/api/production \
  --filter-name ygo-completed --filter-pattern '{ $.msg = "request completed" }' \
  --metric-transformations metricName=CompletedRequests,metricNamespace=YGo,metricValue=1,defaultValue=0
aws logs put-metric-filter --region ap-south-1 --log-group-name /ygo/api/production \
  --filter-name ygo-5xx --filter-pattern '{ $.msg = "request completed" && $.res.statusCode >= 500 && $.res.statusCode < 600 }' \
  --metric-transformations metricName=ServerErrors,metricNamespace=YGo,metricValue=1,defaultValue=0
aws logs put-metric-filter --region ap-south-1 --log-group-name /ygo/systemd \
  --filter-name ygo-start-limit --filter-pattern '"Start request repeated too quickly"' \
  --metric-transformations metricName=StartLimitHits,metricNamespace=YGo,metricValue=1

health_id=$(aws route53 list-health-checks --query \
  "HealthChecks[?HealthCheckConfig.FullyQualifiedDomainName=='$host' && HealthCheckConfig.ResourcePath=='/v1/healthz'].Id | [0]" --output text)
if [[ $health_id == None ]]; then
  health_id=$(aws route53 create-health-check --caller-reference "ygo-$host-$(date -u +%s)" \
    --health-check-config "Type=HTTPS,FullyQualifiedDomainName=$host,Port=443,ResourcePath=/v1/healthz,RequestInterval=30,FailureThreshold=3,EnableSNI=true" \
    --query HealthCheck.Id --output text)
fi

alarm() {
  local region=$1 topic=$2 name=$3
  shift 3
  aws cloudwatch put-metric-alarm --region "$region" --alarm-name "ygo-$name" \
    --alarm-actions "$topic" --ok-actions "$topic" "$@"
}
alarm us-east-1 "$health_topic" health --namespace AWS/Route53 --metric-name HealthCheckStatus \
  --dimensions "Name=HealthCheckId,Value=$health_id" --statistic Minimum --period 60 \
  --evaluation-periods 1 --threshold 1 --comparison-operator LessThanThreshold --treat-missing-data breaching

# Numerator: completed production responses with status 500..599. Denominator: all
# completed production responses, including health probes. Low traffic is 0% by policy;
# no log telemetry becomes INSUFFICIENT_DATA and notifies instead of silently passing.
rate_metrics='[{"Id":"all","MetricStat":{"Metric":{"Namespace":"YGo","MetricName":"CompletedRequests"},"Period":300,"Stat":"Sum"},"ReturnData":false},{"Id":"errors","MetricStat":{"Metric":{"Namespace":"YGo","MetricName":"ServerErrors"},"Period":300,"Stat":"Sum"},"ReturnData":false},{"Id":"rate","Expression":"IF(all>=20,100*errors/all,0)","Label":"Production 5xx percent (20 request minimum)","ReturnData":true}]'
alarm ap-south-1 "$mumbai_topic" 5xx-rate --metrics "$rate_metrics" \
  --evaluation-periods 1 --threshold 5 --comparison-operator GreaterThanOrEqualToThreshold \
  --treat-missing-data missing --insufficient-data-actions "$mumbai_topic"

alarm ap-south-1 "$mumbai_topic" ec2-cpu --namespace AWS/EC2 --metric-name CPUUtilization \
  --dimensions "Name=InstanceId,Value=$ec2" --statistic Average --period 300 \
  --evaluation-periods 3 --threshold 80 --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data breaching
alarm ap-south-1 "$mumbai_topic" rds-cpu --namespace AWS/RDS --metric-name CPUUtilization \
  --dimensions "Name=DBInstanceIdentifier,Value=$rds" --statistic Average --period 300 \
  --evaluation-periods 3 --threshold 80 --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data breaching
alarm ap-south-1 "$mumbai_topic" root-disk --namespace CWAgent --metric-name disk_used_percent \
  --dimensions "Name=InstanceId,Value=$ec2" --statistic Average --period 300 \
  --evaluation-periods 2 --threshold 85 --comparison-operator GreaterThanThreshold --treat-missing-data breaching
alarm ap-south-1 "$mumbai_topic" memory --namespace CWAgent --metric-name mem_available_percent \
  --dimensions "Name=InstanceId,Value=$ec2" --statistic Average --period 300 \
  --evaluation-periods 2 --threshold 15 --comparison-operator LessThanThreshold --treat-missing-data breaching
alarm ap-south-1 "$mumbai_topic" crash-loop --namespace YGo --metric-name StartLimitHits \
  --statistic Sum --period 300 --evaluation-periods 1 --threshold 1 \
  --comparison-operator GreaterThanOrEqualToThreshold --treat-missing-data notBreaching
alarm ap-south-1 "$mumbai_topic" off-aws-copy --namespace YGo --metric-name OffAwsCopyHealthy \
  --statistic Minimum --period 86400 --evaluation-periods 1 --threshold 1 \
  --comparison-operator LessThanThreshold --treat-missing-data breaching

echo "Monitoring definitions created. Confirm both SNS email subscriptions before relying on alarms."
