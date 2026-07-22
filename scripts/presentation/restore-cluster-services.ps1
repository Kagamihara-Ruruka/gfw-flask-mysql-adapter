[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "High")]
param(
    [string]$DeploymentProfilePath = "",
    [string]$SshTarget = "",
    [string]$Namespace = "",
    [switch]$AcknowledgeSharedClusterMutation
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
$SshTarget = if ($SshTarget) { $SshTarget } else { [string]$deploymentProfile.cluster.ssh_target }
$Namespace = if ($Namespace) { $Namespace } else { [string]$deploymentProfile.cluster.namespace }
$kubernetesContext = [string]$deploymentProfile.cluster.kubernetes_context
$sparkTarget = [string]$deploymentProfile.cluster.spark_target
$warehouse = [string]$deploymentProfile.data.warehouse
$runtimeDir = Join-Path $repoRoot ".runtime"
$transcriptPath = Join-Path $runtimeDir "cluster-restore-transcript.txt"

if (-not $AcknowledgeSharedClusterMutation) {
    throw "This command starts missing HDFS/YARN daemons in the shared cluster. Rerun with -AcknowledgeSharedClusterMutation after obtaining operator approval."
}
if (-not $PSCmdlet.ShouldProcess(
    "$SshTarget namespace $Namespace",
    "Start only missing HDFS and YARN daemons without formatting or deleting storage"
)) {
    return
}
if ($Namespace -notmatch '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$') {
    throw "Invalid Kubernetes namespace: $Namespace"
}

New-Item -ItemType Directory -Force $runtimeDir | Out-Null
Remove-Item -LiteralPath $transcriptPath -Force -ErrorAction SilentlyContinue

$remoteScript = @'
set -Eeuo pipefail
NAMESPACE="__NAMESPACE__"
TARGET="__TARGET__"
KUBERNETES_CONTEXT="__KUBERNETES_CONTEXT__"
WAREHOUSE="__WAREHOUSE__"

ACTUAL_CONTEXT=$(kubectl config current-context 2>/dev/null || true)
if [ "$ACTUAL_CONTEXT" != "$KUBERNETES_CONTEXT" ]; then
  echo "Expected context $KUBERNETES_CONTEXT; found ${ACTUAL_CONTEXT:-none}" >&2
  exit 1
fi

echo "=== Verify the existing NameNode storage identity ==="
kubectl -n "$NAMESPACE" exec dtm-0 -- bash -lc '
set -Eeuo pipefail
test -f /home/bigred/nn/current/VERSION
grep -E "^(namespaceID|clusterID|cTime|storageType)=" /home/bigred/nn/current/VERSION
'

echo "=== Start missing HDFS masters ==="
kubectl -n "$NAMESPACE" exec dtm-0 -- bash -lc '
set -Eeuo pipefail
export USER=bigred
export HADOOP_HOME=/opt/zfs/sys/hadoop-3.5.0
export HADOOP_CONF_DIR="$HADOOP_HOME/etc/hadoop"
export HADOOP_LOG_DIR=/tmp
export HADOOP_PID_DIR=/tmp/presentation-hadoop-pids
export PATH="$HADOOP_HOME/bin:$HADOOP_HOME/sbin:$PATH"
mkdir -p "$HADOOP_PID_DIR"
jps -l | grep -q "org.apache.hadoop.hdfs.server.namenode.NameNode$" || hdfs --daemon start namenode
jps -l | grep -q "org.apache.hadoop.hdfs.server.namenode.SecondaryNameNode$" || hdfs --daemon start secondarynamenode
'

echo "=== Start missing DataNodes and NodeManagers ==="
for POD in dtw-0 dtw-1 dtw-2; do
  kubectl -n "$NAMESPACE" exec "$POD" -- bash -lc '
set -Eeuo pipefail
export USER=bigred
export HADOOP_HOME=/opt/zfs/sys/hadoop-3.5.0
export HADOOP_CONF_DIR="$HADOOP_HOME/etc/hadoop"
export YARN_CONF_DIR="$HADOOP_CONF_DIR"
export HADOOP_LOG_DIR=/tmp
export HADOOP_PID_DIR=/tmp/presentation-hadoop-pids
export YARN_LOG_DIR=/tmp
export YARN_PID_DIR=/tmp/presentation-hadoop-pids
export PATH="$HADOOP_HOME/bin:$HADOOP_HOME/sbin:$PATH"
mkdir -p "$HADOOP_PID_DIR"
jps -l | grep -q "org.apache.hadoop.hdfs.server.datanode.DataNode$" || hdfs --daemon start datanode
jps -l | grep -q "org.apache.hadoop.yarn.server.nodemanager.NodeManager$" || yarn --daemon start nodemanager
'
done

echo "=== Start missing ResourceManager ==="
kubectl -n "$NAMESPACE" exec dtm-1 -- bash -lc '
set -Eeuo pipefail
export USER=bigred
export HADOOP_HOME=/opt/zfs/sys/hadoop-3.5.0
export HADOOP_CONF_DIR="$HADOOP_HOME/etc/hadoop"
export YARN_CONF_DIR="$HADOOP_CONF_DIR"
export HADOOP_LOG_DIR=/tmp
export HADOOP_PID_DIR=/tmp/presentation-hadoop-pids
export YARN_LOG_DIR=/tmp
export YARN_PID_DIR=/tmp/presentation-hadoop-pids
export PATH="$HADOOP_HOME/bin:$HADOOP_HOME/sbin:$PATH"
mkdir -p "$HADOOP_PID_DIR"
jps -l | grep -q "org.apache.hadoop.yarn.server.resourcemanager.ResourceManager$" || yarn --daemon start resourcemanager
'

echo "=== Wait for shared services ==="
READY=0
for _ in $(seq 1 60); do
  HDFS_READY=0
  YARN_READY=0
  kubectl -n "$NAMESPACE" exec dtm-0 -- bash -lc 'ss -lnt | grep -q ":8020 "' && HDFS_READY=1
  kubectl -n "$NAMESPACE" exec dtm-1 -- bash -lc 'ss -lnt | grep -q ":8088 "' && YARN_READY=1
  if [ "$HDFS_READY" -eq 1 ] && [ "$YARN_READY" -eq 1 ]; then
    READY=1
    break
  fi
  sleep 2
done
if [ "$READY" -ne 1 ]; then
  echo "HDFS or YARN did not become ready" >&2
  exit 1
fi

kubectl -n "$NAMESPACE" exec "$TARGET" -- env "WAREHOUSE=$WAREHOUSE" bash -lc '
set -Eeuo pipefail
export HADOOP_HOME=/opt/zfs/sys/hadoop-3.5.0
export HADOOP_CONF_DIR="$HADOOP_HOME/etc/hadoop"
export YARN_CONF_DIR="$HADOOP_CONF_DIR"
export PATH="$HADOOP_HOME/bin:$HADOOP_HOME/sbin:$PATH"
timeout 30 hdfs dfs -ls /
timeout 30 hdfs dfs -test -e "$WAREHOUSE"
timeout 30 yarn node -list
'

echo "Cluster services restored and validated; no storage format or delete command was executed"
'@

$remoteScript = $remoteScript.Replace("__NAMESPACE__", $Namespace)
$remoteScript = $remoteScript.Replace("__TARGET__", $sparkTarget)
$remoteScript = $remoteScript.Replace("__KUBERNETES_CONTEXT__", $kubernetesContext)
$remoteScript = $remoteScript.Replace("__WAREHOUSE__", $warehouse)
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
$remoteCommand = "echo '$encoded' | base64 -d | bash"

Start-Transcript -Path $transcriptPath -Force
try {
    & ssh.exe -tt $SshTarget $remoteCommand
    if ($LASTEXITCODE -ne 0) {
        throw "Cluster restore failed with exit code $LASTEXITCODE."
    }
}
finally {
    Stop-Transcript
}
