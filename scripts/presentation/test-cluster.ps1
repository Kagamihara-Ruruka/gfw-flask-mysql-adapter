[CmdletBinding()]
param(
    [string]$DeploymentProfilePath = "",
    [string]$SshTarget = "",
    [string]$Namespace = "",
    [string]$SparkTarget = "",
    [int]$ExpectedYarnNodes = 0
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$DeploymentProfilePath = if ([string]::IsNullOrWhiteSpace($DeploymentProfilePath)) {
    Join-Path $repoRoot "config\presentation\deployment.profile.json"
}
else {
    (Resolve-Path -LiteralPath $DeploymentProfilePath).Path
}
$deploymentProfile = Get-Content -LiteralPath $DeploymentProfilePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($deploymentProfile.schema -ne "bdde38.presentation.deployment.v1") {
    throw "Unsupported deployment profile schema: $($deploymentProfile.schema)"
}
if ($deploymentProfile.cluster.spark_lifecycle -ne "reuse_required") {
    throw "Cluster validation must reuse the existing Spark Thrift Server."
}
$SshTarget = if ($SshTarget) { $SshTarget } else { [string]$deploymentProfile.cluster.ssh_target }
$Namespace = if ($Namespace) { $Namespace } else { [string]$deploymentProfile.cluster.namespace }
$SparkTarget = if ($SparkTarget) { $SparkTarget } else { [string]$deploymentProfile.cluster.spark_target }
$ExpectedYarnNodes = if ($ExpectedYarnNodes) { $ExpectedYarnNodes } else { [int]$deploymentProfile.cluster.expected_yarn_nodes }
$kubernetesContext = [string]$deploymentProfile.cluster.kubernetes_context
$sparkServicePort = [int]$deploymentProfile.cluster.spark_service_port
$warehouse = [string]$deploymentProfile.data.warehouse
$goldTable = [string]$deploymentProfile.data.table
$servingStart = [string]$deploymentProfile.data.serving_start
$servingEnd = [string]$deploymentProfile.data.serving_end
$runtimeDir = Join-Path $repoRoot ".runtime"
$transcriptPath = Join-Path $runtimeDir "cluster-state-transcript.txt"

if ($Namespace -notmatch '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$') {
    throw "Invalid Kubernetes namespace: $Namespace"
}
if ($SparkTarget -notmatch '^(deployment|pod|statefulset)/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$') {
    throw "Invalid Kubernetes target: $SparkTarget"
}

New-Item -ItemType Directory -Force $runtimeDir | Out-Null
Remove-Item -LiteralPath $transcriptPath -Force -ErrorAction SilentlyContinue

$remoteScript = @'
set -Eeuo pipefail
NAMESPACE="__NAMESPACE__"
TARGET="__TARGET__"
KUBERNETES_CONTEXT="__KUBERNETES_CONTEXT__"
EXPECTED_YARN_NODES=__EXPECTED_YARN_NODES__
SPARK_SERVICE_PORT=__SPARK_SERVICE_PORT__
WAREHOUSE="__WAREHOUSE__"
GOLD_TABLE="__GOLD_TABLE__"
SERVING_START="__SERVING_START__"
SERVING_END="__SERVING_END__"

ACTUAL_CONTEXT=$(kubectl config current-context 2>/dev/null || true)
if [ "$ACTUAL_CONTEXT" != "$KUBERNETES_CONTEXT" ]; then
  echo "Expected context $KUBERNETES_CONTEXT; found ${ACTUAL_CONTEXT:-none}" >&2
  exit 1
fi

for POD in dtm-0 dtm-1 dtw-0 dtw-1 dtw-2; do
  echo "=== $POD ==="
  kubectl -n "$NAMESPACE" exec "$POD" -- bash -lc '
set -Eeuo pipefail
jps -l | grep -E "NameNode|DataNode|ResourceManager|NodeManager" || true
ss -lnt 2>/dev/null | grep -E ":(8020|8088)([[:space:]]|$)" || true
'
done

echo "=== Spark / client validation ==="
kubectl -n "$NAMESPACE" exec "$TARGET" -- \
  env "EXPECTED_YARN_NODES=$EXPECTED_YARN_NODES" \
      "SPARK_SERVICE_PORT=$SPARK_SERVICE_PORT" \
      "WAREHOUSE=$WAREHOUSE" \
      "GOLD_TABLE=$GOLD_TABLE" \
      "SERVING_START=$SERVING_START" \
      "SERVING_END=$SERVING_END" bash -lc '
set -Eeuo pipefail
export HADOOP_HOME=/opt/zfs/sys/hadoop-3.5.0
export HADOOP_CONF_DIR="$HADOOP_HOME/etc/hadoop"
export YARN_CONF_DIR="$HADOOP_CONF_DIR"
export PATH="$HADOOP_HOME/bin:$HADOOP_HOME/sbin:$PATH"
timeout 30 hdfs dfs -ls /
timeout 30 hdfs dfs -test -e "$WAREHOUSE"
NODE_OUTPUT=$(timeout 30 yarn node -list 2>/dev/null)
RUNNING_NODES=$(printf "%s\n" "$NODE_OUTPUT" | grep -c "[[:space:]]RUNNING[[:space:]]" || true)
if [ "$RUNNING_NODES" -lt "$EXPECTED_YARN_NODES" ]; then
  echo "Expected at least $EXPECTED_YARN_NODES RUNNING YARN nodes; found $RUNNING_NODES" >&2
  exit 1
fi
echo "YARN RUNNING nodes=$RUNNING_NODES"
ss -lnt | grep -q ":${SPARK_SERVICE_PORT} "
pgrep -af "org.apache.spark.sql.hive.thriftserver.HiveThriftServer2"
QUERY_OUTPUT=$(timeout 180 /opt/zfs/sys/spark-3.5.8-bin-hadoop3/bin/beeline \
  -u "jdbc:hive2://127.0.0.1:${SPARK_SERVICE_PORT}/default" \
  -n bigred \
  --silent=true \
  --showHeader=false \
  --outputformat=tsv2 \
  -e "SELECT COUNT(DISTINCT event_date) FROM ${GOLD_TABLE} WHERE event_date IN (DATE '"'"'${SERVING_START}'"'"', DATE '"'"'${SERVING_END}'"'"')")
printf "%s\n" "$QUERY_OUTPUT" | grep -Eq "(^|[[:space:]])2([[:space:]]|$)"
'

echo "Cluster preflight passed"
'@

$remoteScript = $remoteScript.Replace("__NAMESPACE__", $Namespace)
$remoteScript = $remoteScript.Replace("__TARGET__", $SparkTarget)
$remoteScript = $remoteScript.Replace("__KUBERNETES_CONTEXT__", $kubernetesContext)
$remoteScript = $remoteScript.Replace("__EXPECTED_YARN_NODES__", [string]$ExpectedYarnNodes)
$remoteScript = $remoteScript.Replace("__SPARK_SERVICE_PORT__", [string]$sparkServicePort)
$remoteScript = $remoteScript.Replace("__WAREHOUSE__", $warehouse)
$remoteScript = $remoteScript.Replace("__GOLD_TABLE__", $goldTable)
$remoteScript = $remoteScript.Replace("__SERVING_START__", $servingStart)
$remoteScript = $remoteScript.Replace("__SERVING_END__", $servingEnd)
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
$remoteCommand = "echo '$encoded' | base64 -d | bash"

Start-Transcript -Path $transcriptPath -Force
try {
    & ssh.exe -tt $SshTarget $remoteCommand
    if ($LASTEXITCODE -ne 0) {
        throw "Cluster preflight failed with exit code $LASTEXITCODE."
    }
}
finally {
    Stop-Transcript
}
