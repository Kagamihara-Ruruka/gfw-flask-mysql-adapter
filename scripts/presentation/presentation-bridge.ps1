[CmdletBinding()]
param(
    [string]$DeploymentProfilePath = "",
    [string]$SshTarget = "",
    [string]$Namespace = "",
    [string]$SparkTarget = "",
    [int]$RemoteBridgePort = 0,
    [int]$LocalTunnelPort = 0,
    [int]$ExpectedYarnNodes = 0,
    [string]$OwnerToken = "",
    [string]$ReclaimOwnerToken = "",
    [switch]$Headless
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
    throw "The formal presentation profile must reuse the existing Spark Thrift Server."
}
$SshTarget = if ($SshTarget) { $SshTarget } else { [string]$deploymentProfile.cluster.ssh_target }
$Namespace = if ($Namespace) { $Namespace } else { [string]$deploymentProfile.cluster.namespace }
$SparkTarget = if ($SparkTarget) { $SparkTarget } else { [string]$deploymentProfile.cluster.spark_target }
$RemoteBridgePort = if ($RemoteBridgePort) { $RemoteBridgePort } else { [int]$deploymentProfile.ports.remote_bridge }
$LocalTunnelPort = if ($LocalTunnelPort) { $LocalTunnelPort } else { [int]$deploymentProfile.ports.local_tunnel }
$ExpectedYarnNodes = if ($ExpectedYarnNodes) { $ExpectedYarnNodes } else { [int]$deploymentProfile.cluster.expected_yarn_nodes }
$KubernetesContext = [string]$deploymentProfile.cluster.kubernetes_context
$SparkServicePort = [int]$deploymentProfile.cluster.spark_service_port
$Warehouse = [string]$deploymentProfile.data.warehouse
$GoldTable = [string]$deploymentProfile.data.table
$ServingStart = [string]$deploymentProfile.data.serving_start
$ServingEnd = [string]$deploymentProfile.data.serving_end
$profileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $DeploymentProfilePath).Hash.ToLowerInvariant()
$runtimeDir = Join-Path $repoRoot ".runtime"
$readyPath = Join-Path $runtimeDir "presentation-bridge.ready"
$transcriptPath = Join-Path $runtimeDir "presentation-bridge-transcript.txt"

if ($Namespace -notmatch '^[a-z0-9]([-a-z0-9]*[a-z0-9])?$') {
    throw "Invalid Kubernetes namespace: $Namespace"
}
if ($SparkTarget -notmatch '^(deployment|pod|statefulset)/[a-z0-9]([-a-z0-9.]*[a-z0-9])?$') {
    throw "Invalid Kubernetes target: $SparkTarget"
}
if ($RemoteBridgePort -lt 1 -or $RemoteBridgePort -gt 65535) {
    throw "Invalid remote bridge port: $RemoteBridgePort"
}
if ($LocalTunnelPort -lt 1 -or $LocalTunnelPort -gt 65535) {
    throw "Invalid local tunnel port: $LocalTunnelPort"
}
if ($ExpectedYarnNodes -lt 1) {
    throw "ExpectedYarnNodes must be positive."
}
if ([string]::IsNullOrWhiteSpace($OwnerToken)) {
    $OwnerToken = "bdde38-presentation-$([Guid]::NewGuid().ToString('N'))"
}
if ($OwnerToken -notmatch '^[A-Za-z0-9_.-]{16,128}$') {
    throw "Invalid presentation bridge owner token."
}
if (
    -not [string]::IsNullOrWhiteSpace($ReclaimOwnerToken) `
    -and $ReclaimOwnerToken -notmatch '^[A-Za-z0-9_.-]{16,128}$'
) {
    throw "Invalid presentation bridge reclaim token."
}

New-Item -ItemType Directory -Force $runtimeDir | Out-Null
Remove-Item -LiteralPath $transcriptPath -Force -ErrorAction SilentlyContinue

$remoteScript = @'
set -Eeuo pipefail

NAMESPACE="__NAMESPACE__"
TARGET="__TARGET__"
KUBERNETES_CONTEXT="__KUBERNETES_CONTEXT__"
REMOTE_BRIDGE_PORT=__REMOTE_BRIDGE_PORT__
EXPECTED_YARN_NODES=__EXPECTED_YARN_NODES__
SPARK_SERVICE_PORT=__SPARK_SERVICE_PORT__
WAREHOUSE="__WAREHOUSE__"
GOLD_TABLE="__GOLD_TABLE__"
SERVING_START="__SERVING_START__"
SERVING_END="__SERVING_END__"
OWNER_TOKEN="__OWNER_TOKEN__"
RECLAIM_OWNER_TOKEN="__RECLAIM_OWNER_TOKEN__"
FORWARD_PID=""
STATE_DIR="$HOME/.cache/bdde38-presentation"
STATE_FILE="$STATE_DIR/bridge-${REMOTE_BRIDGE_PORT}.state"
LOCK_FILE="$STATE_FILE.lock"
LOCK_HELD=0

read_state_field() {
  local key="$1"
  [ -f "$STATE_FILE" ] || return 0
  sed -n "s/^${key}=//p" "$STATE_FILE" | head -n 1
}

release_lock() {
  if [ "$LOCK_HELD" -eq 1 ]; then
    local lock_pid
    lock_pid=$(sed -n 's/^pid=//p' "$LOCK_FILE" 2>/dev/null | head -n 1 || true)
    if [ "$lock_pid" = "$$" ]; then
      rm -f "$LOCK_FILE"
    fi
    LOCK_HELD=0
  fi
}

acquire_lock() {
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  for _ in $(seq 1 40); do
    if (set -o noclobber; printf 'pid=%s\n' "$$" > "$LOCK_FILE") 2>/dev/null; then
      LOCK_HELD=1
      return 0
    fi
    local lock_pid
    lock_pid=$(sed -n 's/^pid=//p' "$LOCK_FILE" 2>/dev/null | head -n 1 || true)
    if ! printf '%s' "$lock_pid" | grep -Eq '^[1-9][0-9]*$' || ! kill -0 "$lock_pid" 2>/dev/null; then
      rm -f "$LOCK_FILE"
      continue
    fi
    sleep 0.25
  done
  echo "Another presentation bridge is changing remote port ${REMOTE_BRIDGE_PORT}" >&2
  exit 13
}

cleanup() {
  if [ -n "${FORWARD_PID:-}" ]; then
    kill "$FORWARD_PID" 2>/dev/null || true
    wait "$FORWARD_PID" 2>/dev/null || true
  fi
  local state_owner state_pid
  state_owner=$(read_state_field owner_token || true)
  state_pid=$(read_state_field pid || true)
  if [ "$state_owner" = "$OWNER_TOKEN" ] && [ "$state_pid" = "${FORWARD_PID:-}" ]; then
    rm -f "$STATE_FILE"
  fi
  rm -f "$STATE_FILE.${OWNER_TOKEN}.tmp"
  release_lock
}
trap cleanup EXIT INT TERM HUP

echo "BDDE38_STAGE cluster_access running Validating remote Kubernetes access"
if ! command -v kubectl >/dev/null; then
  echo "BDDE38_STAGE cluster_access failed kubectl is unavailable" >&2
  exit 10
fi
ACTUAL_CONTEXT=$(kubectl config current-context 2>/dev/null || true)
if [ "$ACTUAL_CONTEXT" != "$KUBERNETES_CONTEXT" ]; then
  echo "BDDE38_STAGE cluster_access failed Expected context $KUBERNETES_CONTEXT; found ${ACTUAL_CONTEXT:-none}" >&2
  exit 10
fi
if ! kubectl -n "$NAMESPACE" get "$TARGET" >/dev/null; then
  echo "BDDE38_STAGE cluster_access failed Remote Kubernetes access failed" >&2
  exit 10
fi
echo "BDDE38_STAGE cluster_access ok Remote Kubernetes access succeeded"

echo "BDDE38_STAGE hdfs_yarn running Validating HDFS warehouse and YARN workers"
if ! kubectl -n "$NAMESPACE" exec "$TARGET" -- \
  env "EXPECTED_YARN_NODES=$EXPECTED_YARN_NODES" "WAREHOUSE=$WAREHOUSE" bash -lc '
set -Eeuo pipefail
export HADOOP_HOME=/opt/zfs/sys/hadoop-3.5.0
export HADOOP_CONF_DIR="$HADOOP_HOME/etc/hadoop"
export YARN_CONF_DIR="$HADOOP_CONF_DIR"
export PATH="$HADOOP_HOME/bin:$HADOOP_HOME/sbin:$PATH"
timeout 30 hdfs dfs -test -e "$WAREHOUSE"
NODE_OUTPUT=$(timeout 30 yarn node -list 2>/dev/null)
RUNNING_NODES=$(printf "%s\n" "$NODE_OUTPUT" | grep -c "[[:space:]]RUNNING[[:space:]]" || true)
if [ "$RUNNING_NODES" -lt "$EXPECTED_YARN_NODES" ]; then
  echo "Expected at least $EXPECTED_YARN_NODES RUNNING YARN nodes; found $RUNNING_NODES" >&2
  exit 1
fi
echo "HDFS warehouse ready; YARN nodes RUNNING=$RUNNING_NODES"
'; then
  echo "BDDE38_STAGE hdfs_yarn failed HDFS or YARN validation failed" >&2
  exit 11
fi
echo "BDDE38_STAGE hdfs_yarn ok HDFS warehouse and YARN workers are ready"

echo "BDDE38_STAGE spark_thrift running Validating Spark Thrift and Iceberg"
if ! kubectl -n "$NAMESPACE" exec "$TARGET" -- \
  env "SPARK_SERVICE_PORT=$SPARK_SERVICE_PORT" bash -lc '
set -Eeuo pipefail
ss -lnt | grep -q ":${SPARK_SERVICE_PORT} "
pgrep -f "org.apache.spark.sql.hive.thriftserver.HiveThriftServer2" >/dev/null
'; then
  echo "BDDE38_STAGE spark_thrift failed The shared Spark Thrift Server is unavailable; reuse_required forbids starting another owner" >&2
  exit 12
fi
echo "Using the existing shared Spark Thrift Server; this launcher will not start or stop it"

echo "Validating the Iceberg catalog with Beeline"
if ! kubectl -n "$NAMESPACE" exec "$TARGET" -- \
  env "SPARK_SERVICE_PORT=$SPARK_SERVICE_PORT" \
      "GOLD_TABLE=$GOLD_TABLE" \
      "SERVING_START=$SERVING_START" \
      "SERVING_END=$SERVING_END" bash -lc '
set -Eeuo pipefail
QUERY_OUTPUT=$(timeout 180 /opt/zfs/sys/spark-3.5.8-bin-hadoop3/bin/beeline \
  -u "jdbc:hive2://127.0.0.1:${SPARK_SERVICE_PORT}/default" \
  -n bigred \
  --silent=true \
  --showHeader=false \
  --outputformat=tsv2 \
  -e "SELECT CONCAT('"'"'BDDE38_ENDPOINT_COUNT='"'"', CAST(COUNT(DISTINCT event_date) AS STRING)) FROM ${GOLD_TABLE} WHERE event_date IN (DATE '"'"'${SERVING_START}'"'"', DATE '"'"'${SERVING_END}'"'"') AND aoi_id = '"'"'northwest_pacific'"'"'")
ENDPOINT_MARKER=$(printf "%s\n" "$QUERY_OUTPUT" | tr -d "\r" | grep -o '"'"'BDDE38_ENDPOINT_COUNT=[0-9][0-9]*'"'"' | tail -n 1 || true)
if [ "$ENDPOINT_MARKER" != "BDDE38_ENDPOINT_COUNT=2" ]; then
  echo "Formal serving endpoints are not both queryable: ${SERVING_START}, ${SERVING_END}" >&2
  echo "Beeline validation output (tail):" >&2
  printf "%s\n" "$QUERY_OUTPUT" | tail -n 20 >&2
  exit 1
fi
'; then
  echo "BDDE38_STAGE spark_thrift failed Spark Thrift or Iceberg validation failed" >&2
  exit 12
fi
echo "BDDE38_STAGE spark_thrift ok Spark Thrift and Iceberg are queryable"

echo "BDDE38_STAGE ssh_tunnel running Establishing the Kubernetes and SSH port forwards"
acquire_lock

if ss -lntp | grep -q ":${REMOTE_BRIDGE_PORT} "; then
  STATE_OWNER=$(read_state_field owner_token || true)
  STATE_PID=$(read_state_field pid || true)
  STATE_NAMESPACE=$(read_state_field namespace || true)
  STATE_TARGET=$(read_state_field target || true)
  STATE_FORWARD=$(read_state_field forward || true)
  EXPECTED_COMMAND="kubectl -n $NAMESPACE port-forward $TARGET $REMOTE_BRIDGE_PORT:$SPARK_SERVICE_PORT --address=127.0.0.1"
  ACTUAL_COMMAND=""
  if printf '%s' "$STATE_PID" | grep -Eq '^[1-9][0-9]*$'; then
    ACTUAL_COMMAND=$(ps -o args= -p "$STATE_PID" 2>/dev/null || true)
  fi
  if [ -n "$RECLAIM_OWNER_TOKEN" ] \
    && [ "$STATE_OWNER" = "$RECLAIM_OWNER_TOKEN" ] \
    && [ "$STATE_NAMESPACE" = "$NAMESPACE" ] \
    && [ "$STATE_TARGET" = "$TARGET" ] \
    && [ "$STATE_FORWARD" = "$REMOTE_BRIDGE_PORT:$SPARK_SERVICE_PORT" ] \
    && [ "$ACTUAL_COMMAND" = "$EXPECTED_COMMAND" ]; then
    echo "Reclaiming the previous owner-verified presentation port-forward"
    kill "$STATE_PID"
    for _ in $(seq 1 40); do
      if ! kill -0 "$STATE_PID" 2>/dev/null; then
        break
      fi
      sleep 0.25
    done
    if kill -0 "$STATE_PID" 2>/dev/null || ss -lntp | grep -q ":${REMOTE_BRIDGE_PORT} "; then
      echo "The previous owner-verified port-forward did not stop" >&2
      exit 13
    fi
    rm -f "$STATE_FILE"
  else
    echo "Remote port ${REMOTE_BRIDGE_PORT} is occupied without matching owner evidence; refusing to stop it" >&2
    exit 13
  fi
elif [ -f "$STATE_FILE" ]; then
  STATE_PID=$(read_state_field pid || true)
  if printf '%s' "$STATE_PID" | grep -Eq '^[1-9][0-9]*$' && kill -0 "$STATE_PID" 2>/dev/null; then
    echo "Presentation bridge state refers to a live process without its expected listener" >&2
    exit 13
  fi
  rm -f "$STATE_FILE"
fi

kubectl -n "$NAMESPACE" port-forward "$TARGET" \
  "$REMOTE_BRIDGE_PORT:$SPARK_SERVICE_PORT" --address=127.0.0.1 &
FORWARD_PID=$!

FORWARD_READY=0
for _ in $(seq 1 30); do
  if ! kill -0 "$FORWARD_PID" 2>/dev/null; then
    wait "$FORWARD_PID"
    exit 13
  fi
  if ss -lntp | grep ":${REMOTE_BRIDGE_PORT} " | grep -q "pid=${FORWARD_PID},"; then
    FORWARD_READY=1
    break
  fi
  sleep 1
done
if [ "$FORWARD_READY" -ne 1 ]; then
  echo "Kubernetes port-forward did not become ready" >&2
  exit 13
fi
sleep 1
if ! kill -0 "$FORWARD_PID" 2>/dev/null \
  || ! ss -lntp | grep ":${REMOTE_BRIDGE_PORT} " | grep -q "pid=${FORWARD_PID},"; then
  echo "Kubernetes port-forward did not remain stable" >&2
  exit 13
fi

STATE_TEMP="$STATE_FILE.${OWNER_TOKEN}.tmp"
umask 077
{
  echo "schema=bdde38.presentation.remote_bridge.v1"
  echo "owner_token=$OWNER_TOKEN"
  echo "pid=$FORWARD_PID"
  echo "namespace=$NAMESPACE"
  echo "target=$TARGET"
  echo "forward=$REMOTE_BRIDGE_PORT:$SPARK_SERVICE_PORT"
} > "$STATE_TEMP"
mv -f "$STATE_TEMP" "$STATE_FILE"
release_lock

echo "BDDE38_STAGE ssh_tunnel ok Kubernetes port-forward is ready"
echo "BDDE38_BRIDGE_READY local_target=127.0.0.1:${REMOTE_BRIDGE_PORT} owner_token=${OWNER_TOKEN}"
wait "$FORWARD_PID"
'@

$remoteScript = $remoteScript.Replace("__NAMESPACE__", $Namespace)
$remoteScript = $remoteScript.Replace("__TARGET__", $SparkTarget)
$remoteScript = $remoteScript.Replace("__KUBERNETES_CONTEXT__", $KubernetesContext)
$remoteScript = $remoteScript.Replace("__REMOTE_BRIDGE_PORT__", [string]$RemoteBridgePort)
$remoteScript = $remoteScript.Replace("__EXPECTED_YARN_NODES__", [string]$ExpectedYarnNodes)
$remoteScript = $remoteScript.Replace("__SPARK_SERVICE_PORT__", [string]$SparkServicePort)
$remoteScript = $remoteScript.Replace("__WAREHOUSE__", $Warehouse)
$remoteScript = $remoteScript.Replace("__GOLD_TABLE__", $GoldTable)
$remoteScript = $remoteScript.Replace("__SERVING_START__", $ServingStart)
$remoteScript = $remoteScript.Replace("__SERVING_END__", $ServingEnd)
$remoteScript = $remoteScript.Replace("__OWNER_TOKEN__", $OwnerToken)
$remoteScript = $remoteScript.Replace("__RECLAIM_OWNER_TOKEN__", $ReclaimOwnerToken)
$encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
$remoteCommand = "echo '$encoded' | base64 -d | bash"
$sshPath = (Get-Command ssh.exe -ErrorAction Stop).Source
$sshArguments = @(
    "-tt",
    "-o", "ExitOnForwardFailure=yes",
    "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=3",
    "-L", "127.0.0.1:${LocalTunnelPort}:127.0.0.1:${RemoteBridgePort}",
    $SshTarget,
    $remoteCommand
)

Start-Transcript -Path $transcriptPath -Force
$sshExitCode = 1
$script:BridgeEverReady = $false
$script:BridgeReadyThisAttempt = $false
$reconnectAttempt = 0
try {
    if ($Headless) {
        Write-Host "Authenticating SSH through the managed AskPass credential path."
    }
    else {
        Write-Host "Authenticate SSH when prompted. Keep this window open during the presentation."
    }
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    while ($true) {
        Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
        $script:BridgeReadyThisAttempt = $false
        & $sshPath @sshArguments 2>&1 | ForEach-Object {
            $line = [string]$_
            Write-Host $line
            if ($line.Contains("BDDE38_BRIDGE_READY")) {
                $readyEvidence = (
                    "{0} ssh_target={1} local_tunnel=127.0.0.1:{2} " +
                    "remote_bridge=127.0.0.1:{3} profile_hash={4}"
                ) -f $line, $SshTarget, $LocalTunnelPort, $RemoteBridgePort, $profileHash
                [System.IO.File]::WriteAllText(
                    $readyPath,
                    $readyEvidence,
                    [System.Text.UTF8Encoding]::new($false)
                )
                $script:BridgeEverReady = $true
                $script:BridgeReadyThisAttempt = $true
            }
        }
        $sshExitCode = $LASTEXITCODE

        if (-not $Headless -or -not $script:BridgeEverReady) {
            break
        }

        Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
        if ($script:BridgeReadyThisAttempt) {
            $reconnectAttempt = 0
        }
        $reconnectAttempt += 1
        $retryDelaySeconds = [Math]::Min(30, [Math]::Pow(2, [Math]::Min(4, $reconnectAttempt)))
        Write-Host (
            "BDDE38_BRIDGE_RECONNECT tunnel_lost retry_in_seconds={0} attempt={1}" -f `
                $retryDelaySeconds, $reconnectAttempt
        ) -ForegroundColor Yellow
        Start-Sleep -Seconds $retryDelaySeconds
    }
    $ErrorActionPreference = $previousErrorAction
}
finally {
    Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
    Stop-Transcript
}

if ($sshExitCode -ne 0) {
    $contractExitCode = if ($sshExitCode -in @(10, 11, 12, 13)) {
        $sshExitCode
    }
    else {
        10
    }
    Write-Host "Presentation bridge exited with code $contractExitCode (ssh exit $sshExitCode)." -ForegroundColor Red
    if (-not $Headless) {
        Read-Host "Press Enter to close"
    }
    exit $contractExitCode
}
