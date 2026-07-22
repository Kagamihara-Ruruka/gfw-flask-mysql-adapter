[CmdletBinding()]
param(
    [string]$DeploymentProfilePath = "",
    [string]$SshTarget = "",
    [string]$Namespace = "",
    [string]$SparkTarget = "",
    [int]$RemoteBridgePort = 0,
    [int]$LocalTunnelPort = 0,
    [int]$ExpectedYarnNodes = 0,
    [int]$HttpPort = 0,
    [int]$DeveloperPort = 0,
    [int]$BridgeTimeoutSeconds = 360,
    [int]$StartupTimeoutSeconds = 900,
    [switch]$SkipTunnel,
    [switch]$NoBuild,
    [switch]$SkipSmoke
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
$HttpPort = if ($HttpPort) { $HttpPort } else { [int]$deploymentProfile.ports.host_http }
$DeveloperPort = if ($DeveloperPort) { $DeveloperPort } else { [int]$deploymentProfile.ports.host_developer }
$profileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $DeploymentProfilePath).Hash.ToLowerInvariant()
if (
    $env:BDDE38_DEPLOYMENT_PROFILE_HASH `
    -and $env:BDDE38_DEPLOYMENT_PROFILE_HASH -ne "unmanaged" `
    -and $env:BDDE38_DEPLOYMENT_PROFILE_HASH -ne $profileHash
) {
    throw "The controller and PowerShell deployment profile hashes differ."
}
$env:BDDE38_DEPLOYMENT_PROFILE_HASH = $profileHash
$env:BDDE38_DEPLOYMENT_ENVIRONMENT = [string]$deploymentProfile.cluster.environment
$env:BDDE38_DEPLOYMENT_TARGET = $SshTarget
$runtimeDir = Join-Path $repoRoot ".runtime"
$wrapperPidPath = Join-Path $runtimeDir "presentation-bridge.pid"
$readyPath = Join-Path $runtimeDir "presentation-bridge.ready"
$ownerStatePath = Join-Path $runtimeDir "presentation-bridge-owner.json"
$runtimeConfigStatePath = Join-Path $runtimeDir "presentation\runtime-config-state.json"
$smokeStatePath = Join-Path $runtimeDir "presentation-smoke-state.json"
$bridgeScript = Join-Path $PSScriptRoot "presentation-bridge.ps1"
$composePath = Join-Path $repoRoot "compose.presentation.yaml"
$bootstrapContainerName = "bdde38-presentation-eez-bootstrap"
$script:FailureExitCode = 2

trap {
    Write-Host ("BDDE38_STAGE {0} failed {1}" -f $script:FailureStage, $_.Exception.Message) -ForegroundColor Red
    exit $script:FailureExitCode
}

function Test-TcpPort {
    param([string]$HostName, [int]$Port, [int]$TimeoutMilliseconds = 750)
    $client = [System.Net.Sockets.TcpClient]::new()
    try {
        $pending = $client.BeginConnect($HostName, $Port, $null, $null)
        return $pending.AsyncWaitHandle.WaitOne($TimeoutMilliseconds) -and $client.Connected
    }
    catch {
        return $false
    }
    finally {
        $client.Dispose()
    }
}

function Wait-BridgeReady {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$TimeoutSeconds,
        [string]$ExpectedOwnerToken
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($Process.HasExited) {
            throw "The presentation bridge exited before it became ready. Review .runtime/presentation-bridge-transcript.txt."
        }
        if (Test-Path -LiteralPath $readyPath -PathType Leaf) {
            $readyLine = Get-Content -LiteralPath $readyPath -Raw -Encoding UTF8
            $expectedMarker = "owner_token=$ExpectedOwnerToken"
            if (
                $readyLine.Contains($expectedMarker) `
                -and (Test-TcpPort -HostName "127.0.0.1" -Port $LocalTunnelPort)
            ) {
                Start-Sleep -Seconds 1
                if (
                    -not $Process.HasExited `
                    -and (Test-TcpPort -HostName "127.0.0.1" -Port $LocalTunnelPort)
                ) {
                    return
                }
            }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "SSH authentication, Spark validation, or port forwarding did not finish within $TimeoutSeconds seconds."
}

function Wait-HttpReady {
    param([string]$Url, [int]$TimeoutSeconds)
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 8
            if ($response.StatusCode -eq 200) {
                return $true
            }
        }
        catch {
            # The first EEZ bootstrap can take several minutes.
        }
        Start-Sleep -Seconds 2
    }
    return $false
}

function Stop-ProcessTree {
    param([int]$ProcessId)
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
        Stop-ProcessTree -ProcessId ([int]$child.ProcessId)
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
}

function Get-OwnedBridgeProcess {
    if (-not (Test-Path $wrapperPidPath)) {
        return $null
    }

    $savedPid = 0
    if (-not [int]::TryParse((Get-Content -Raw $wrapperPidPath).Trim(), [ref]$savedPid)) {
        return $null
    }

    $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
    if ($null -eq $processInfo) {
        return $null
    }

    $bridgePattern = [regex]::Escape($bridgeScript)
    $isPowerShell = [System.IO.Path]::GetFileName($processInfo.ExecutablePath) -ieq "powershell.exe"
    if (-not $isPowerShell -or $processInfo.CommandLine -notmatch $bridgePattern) {
        return $null
    }
    return $processInfo
}

function Get-BridgeOwnerToken {
    if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
        throw "The presentation bridge readiness file is missing."
    }
    $readyLine = Get-Content -LiteralPath $readyPath -Raw
    $match = [regex]::Match($readyLine, 'owner_token=([A-Za-z0-9_.-]{16,128})')
    if (-not $match.Success) {
        throw "The presentation bridge readiness file has no owner token. Stop the old bridge and start again."
    }
    return $match.Groups[1].Value
}

function Read-BridgeOwnerToken {
    if (-not (Test-Path -LiteralPath $readyPath -PathType Leaf)) {
        return ""
    }
    $readyLine = Get-Content -LiteralPath $readyPath -Raw -Encoding UTF8
    $match = [regex]::Match($readyLine, 'owner_token=([A-Za-z0-9_.-]{16,128})')
    if (-not $match.Success) {
        return ""
    }
    return $match.Groups[1].Value
}

function Read-PersistedBridgeOwnerToken {
    if (-not (Test-Path -LiteralPath $ownerStatePath -PathType Leaf)) {
        return ""
    }

    try {
        $state = Get-Content -LiteralPath $ownerStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        if (
            [string]$state.schema -ne "bdde38.presentation.bridge_owner.v1" `
            -or [string]$state.owner_token -notmatch '^[A-Za-z0-9_.-]{16,128}$' `
            -or [string]$state.profile_hash -ne $profileHash `
            -or [string]$state.ssh_target -ne $SshTarget `
            -or [string]$state.namespace -ne $Namespace `
            -or [string]$state.spark_target -ne $SparkTarget `
            -or [int]$state.remote_bridge_port -ne $RemoteBridgePort `
            -or [int]$state.local_tunnel_port -ne $LocalTunnelPort
        ) {
            Write-Warning "Ignoring presentation bridge owner evidence that does not match the active deployment profile."
            return ""
        }
        return [string]$state.owner_token
    }
    catch {
        Write-Warning "Ignoring unreadable presentation bridge owner evidence: $($_.Exception.Message)"
        return ""
    }
}

function Read-EffectiveRuntimeBridgeOwnerToken {
    if (-not (Test-Path -LiteralPath $runtimeConfigStatePath -PathType Leaf)) {
        return ""
    }

    try {
        $state = Get-Content -LiteralPath $runtimeConfigStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $effective = $state.effective
        if (
            $null -eq $effective `
            -or [string]$effective.bridge_owner_token -notmatch '^[A-Za-z0-9_.-]{16,128}$' `
            -or [string]$effective.deployment_profile_hash -ne $profileHash `
            -or [string]$effective.deployment_target -ne $SshTarget `
            -or [string]$effective.deployment_environment -ne [string]$deploymentProfile.cluster.environment `
            -or [string]$effective.managed_by -ne "presentationctl"
        ) {
            return ""
        }
        Write-Host "Using owner evidence from the last accepted Runtime generation for bridge recovery."
        return [string]$effective.bridge_owner_token
    }
    catch {
        Write-Warning "Ignoring unreadable effective Runtime owner evidence: $($_.Exception.Message)"
        return ""
    }
}

function Write-BridgeOwnerEvidence {
    param(
        [string]$OwnerToken,
        [int]$BridgeProcessId
    )

    $state = [ordered]@{
        schema = "bdde38.presentation.bridge_owner.v1"
        owner_token = $OwnerToken
        profile_hash = $profileHash
        ssh_target = $SshTarget
        namespace = $Namespace
        spark_target = $SparkTarget
        remote_bridge_port = $RemoteBridgePort
        local_tunnel_port = $LocalTunnelPort
        bridge_pid = $BridgeProcessId
        updated_at = [DateTime]::UtcNow.ToString("o")
    }
    $temporaryPath = "$ownerStatePath.$PID.tmp"
    [System.IO.File]::WriteAllText(
        $temporaryPath,
        ($state | ConvertTo-Json -Depth 4),
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryPath -Destination $ownerStatePath -Force
}

New-Item -ItemType Directory -Force $runtimeDir | Out-Null
Remove-Item -LiteralPath $smokeStatePath -Force -ErrorAction SilentlyContinue
$script:FailureStage = "preflight"
$script:FailureExitCode = 2

if ($env:BDDE38_RUNTIME_GENERATION -notmatch '^[1-9][0-9]*$') {
    throw "BDDE38_RUNTIME_GENERATION is missing. Run this adapter through presentationctl.py."
}
if ([string]::IsNullOrWhiteSpace($env:BDDE38_RUNTIME_INSTANCE_ID) -or $env:BDDE38_RUNTIME_INSTANCE_ID -eq "unmanaged") {
    throw "BDDE38_RUNTIME_INSTANCE_ID is missing. Run this adapter through presentationctl.py."
}
if ([string]::IsNullOrWhiteSpace($env:BDDE38_COMPOSE_HASH) -or $env:BDDE38_COMPOSE_HASH -eq "unmanaged") {
    $env:BDDE38_COMPOSE_HASH = (Get-FileHash -Algorithm SHA256 -LiteralPath $composePath).Hash.ToLowerInvariant()
}

Write-Host "BDDE38_STAGE preflight running Checking local presentation prerequisites."
if (-not (Test-Path -LiteralPath $composePath -PathType Leaf)) {
    throw "Missing Compose file: $composePath"
}
Get-Command docker -ErrorAction Stop | Out-Null
Get-Command ssh.exe -ErrorAction Stop | Out-Null
Get-Command powershell.exe -ErrorAction Stop | Out-Null
& docker compose version | Out-Null
if ($LASTEXITCODE -ne 0) {
    throw "Docker Compose is unavailable."
}
Write-Host "BDDE38_STAGE preflight ok Local presentation prerequisites are available."

$script:FailureStage = "cluster_access"
$script:FailureExitCode = 10
Write-Host "BDDE38_STAGE cluster_access running Establishing the interactive cluster bridge."
$bridgeProcess = $null
$tunnelOpen = Test-TcpPort -HostName "127.0.0.1" -Port $LocalTunnelPort
if ($SkipTunnel) {
    if (-not $tunnelOpen) {
        throw "-SkipTunnel was supplied, but port 127.0.0.1:$LocalTunnelPort is not listening."
    }
    if ([string]::IsNullOrWhiteSpace($env:BDDE38_BRIDGE_OWNER_TOKEN) -or $env:BDDE38_BRIDGE_OWNER_TOKEN -eq "unmanaged") {
        throw "-SkipTunnel requires BDDE38_BRIDGE_OWNER_TOKEN for deployment evidence."
    }
    Write-Host "Using the caller-owned Spark tunnel on 127.0.0.1:$LocalTunnelPort."
}
elseif ($tunnelOpen) {
    $ownedBridge = Get-OwnedBridgeProcess
    if (-not (Test-Path $readyPath) -or $null -eq $ownedBridge) {
        throw "Port 127.0.0.1:$LocalTunnelPort is occupied by an unowned process. Stop it or rerun with -SkipTunnel after validating it."
    }
    Write-Host "Reusing the existing presentation bridge on 127.0.0.1:$LocalTunnelPort."
}
else {
    $reclaimOwnerToken = Read-PersistedBridgeOwnerToken
    if ([string]::IsNullOrWhiteSpace($reclaimOwnerToken)) {
        $reclaimOwnerToken = Read-BridgeOwnerToken
    }
    if ([string]::IsNullOrWhiteSpace($reclaimOwnerToken)) {
        $reclaimOwnerToken = Read-EffectiveRuntimeBridgeOwnerToken
    }
    Remove-Item -LiteralPath $wrapperPidPath -Force -ErrorAction SilentlyContinue

    $powerShellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
    $requestedOwnerToken = if (
        [string]::IsNullOrWhiteSpace($env:BDDE38_BRIDGE_OWNER_TOKEN) `
        -or $env:BDDE38_BRIDGE_OWNER_TOKEN -eq "unmanaged"
    ) {
        "bdde38-presentation-$([Guid]::NewGuid().ToString('N'))"
    }
    else {
        $env:BDDE38_BRIDGE_OWNER_TOKEN
    }
    $quotedBridgeScript = '"' + $bridgeScript.Replace('"', '""') + '"'
    $quotedDeploymentProfile = '"' + $DeploymentProfilePath.Replace('"', '""') + '"'
    $bridgeArguments = @(
        "-NoLogo",
        "-NoProfile",
        "-ExecutionPolicy", "Bypass",
        "-File", $quotedBridgeScript,
        "-DeploymentProfilePath", $quotedDeploymentProfile,
        "-SshTarget", $SshTarget,
        "-Namespace", $Namespace,
        "-SparkTarget", $SparkTarget,
        "-RemoteBridgePort", [string]$RemoteBridgePort,
        "-LocalTunnelPort", [string]$LocalTunnelPort,
        "-ExpectedYarnNodes", [string]$ExpectedYarnNodes,
        "-OwnerToken", $requestedOwnerToken
    )
    if (-not [string]::IsNullOrWhiteSpace($reclaimOwnerToken)) {
        $bridgeArguments += @("-ReclaimOwnerToken", $reclaimOwnerToken)
    }

    $managedBackgroundBridge = (
        -not [string]::IsNullOrWhiteSpace($env:SSH_ASKPASS) `
        -and $env:SSH_ASKPASS_REQUIRE -eq "force"
    )
    if ($managedBackgroundBridge) {
        $bridgeArguments += "-Headless"
        Write-Host "Starting the managed SSH bridge in the background."
        $bridgeProcess = Start-Process `
            -FilePath $powerShellPath `
            -ArgumentList $bridgeArguments `
            -WindowStyle Hidden `
            -PassThru
    }
    else {
        Write-Host "Opening a visible SSH bridge window. Enter the password there when prompted and keep it open."
        $bridgeProcess = Start-Process -FilePath $powerShellPath -ArgumentList $bridgeArguments -PassThru
    }
    [System.IO.File]::WriteAllText(
        $wrapperPidPath,
        [string]$bridgeProcess.Id,
        [System.Text.UTF8Encoding]::new($false)
    )

    try {
        Wait-BridgeReady `
            -Process $bridgeProcess `
            -TimeoutSeconds $BridgeTimeoutSeconds `
            -ExpectedOwnerToken $requestedOwnerToken
    }
    catch {
        if ($bridgeProcess.HasExited -and $bridgeProcess.ExitCode -in @(10, 11, 12, 13)) {
            $script:FailureExitCode = $bridgeProcess.ExitCode
            $script:FailureStage = switch ($bridgeProcess.ExitCode) {
                11 { "hdfs_yarn" }
                12 { "spark_thrift" }
                13 { "ssh_tunnel" }
                default { "cluster_access" }
            }
        }
        if (-not $bridgeProcess.HasExited) {
            Stop-ProcessTree -ProcessId $bridgeProcess.Id
        }
        if ((Read-BridgeOwnerToken) -eq $requestedOwnerToken) {
            Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
        }
        Remove-Item -LiteralPath $wrapperPidPath -Force -ErrorAction SilentlyContinue
        throw
    }
}
$env:BDDE38_BRIDGE_OWNER_TOKEN = if ($SkipTunnel) {
    $env:BDDE38_BRIDGE_OWNER_TOKEN
}
else {
    Get-BridgeOwnerToken
}
if (-not $SkipTunnel) {
    $activeBridge = Get-OwnedBridgeProcess
    if ($null -eq $activeBridge) {
        throw "The presentation bridge became ready without a matching owned process."
    }
    Write-BridgeOwnerEvidence `
        -OwnerToken $env:BDDE38_BRIDGE_OWNER_TOKEN `
        -BridgeProcessId ([int]$activeBridge.ProcessId)
}
Write-Host "BDDE38_STAGE cluster_access ok SSH authentication and remote cluster access succeeded."
Write-Host "BDDE38_STAGE hdfs_yarn ok HDFS warehouse and YARN worker validation succeeded."
Write-Host "BDDE38_STAGE spark_thrift ok Spark Thrift and the Iceberg catalog are queryable."
Write-Host "BDDE38_STAGE ssh_tunnel ok Spark tunnel is listening on 127.0.0.1:$LocalTunnelPort."

$env:PRESENTATION_HTTP_PORT = [string]$HttpPort
$env:PRESENTATION_DEVELOPER_PORT = [string]$DeveloperPort

Push-Location $repoRoot
try {
    $script:FailureStage = "docker_postgis"
    $script:FailureExitCode = 20
    Write-Host "BDDE38_STAGE docker_postgis running Building the presentation image and starting PostGIS."
    if (-not $NoBuild) {
        & docker compose -f $composePath --profile bootstrap build app eez-bootstrap
        if ($LASTEXITCODE -ne 0) {
            throw "Docker Compose image build failed with exit code $LASTEXITCODE."
        }
    }
    $presentationImage = if ($env:PRESENTATION_IMAGE) {
        $env:PRESENTATION_IMAGE
    }
    else {
        "bdde38-presentation:local"
    }
    $imageDigest = (& docker image inspect --format '{{.Id}}' $presentationImage).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($imageDigest)) {
        throw "Unable to resolve the immutable image identity for $presentationImage."
    }
    $env:BDDE38_IMAGE_DIGEST = $imageDigest
    & docker compose -f $composePath up -d postgis
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose could not start PostGIS; exit code $LASTEXITCODE."
    }
    Write-Host "BDDE38_STAGE docker_postgis ok PostGIS is healthy and ready for spatial bootstrap."

    $script:FailureStage = "spatial_dependencies"
    $script:FailureExitCode = 23
    Write-Host "BDDE38_STAGE spatial_dependencies running Checking, importing, and prewarming EEZ spatial assets."
    & docker compose -f $composePath stop app
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose could not stop the previous application generation; exit code $LASTEXITCODE."
    }
    $existingBootstrap = & docker ps -aq --filter "name=^/$bootstrapContainerName$"
    if ($existingBootstrap) {
        $existingProject = (& docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' $existingBootstrap).Trim()
        $existingService = (& docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' $existingBootstrap).Trim()
        if ($existingProject -ne "bdde38-presentation" -or $existingService -ne "eez-bootstrap") {
            throw "Refusing to remove unowned container named $bootstrapContainerName."
        }
        & docker rm -f $existingBootstrap | Out-Null
    }
    & docker compose -f $composePath --profile bootstrap run --rm --name $bootstrapContainerName eez-bootstrap
    if ($LASTEXITCODE -ne 0) {
        throw "EEZ spatial dependency bootstrap failed with exit code $LASTEXITCODE."
    }
    Write-Host "BDDE38_STAGE spatial_dependencies ok EEZ source, PostGIS tables, topology, and persistent domain tiles are ready."

    $script:FailureStage = "docker_app"
    $script:FailureExitCode = 20
    Write-Host "BDDE38_STAGE docker_app running Starting the application container and core.py."
    & docker compose -f $composePath up -d app
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose could not start the application; exit code $LASTEXITCODE."
    }
    Write-Host "BDDE38_STAGE docker_app ok The application container and core.py were started."

    $script:FailureStage = "application_health"
    $script:FailureExitCode = 21
    $livenessUrl = "http://127.0.0.1:$HttpPort/api/runtime/identity"
    $developerUrl = "http://127.0.0.1:$DeveloperPort/"
    Write-Host "BDDE38_STAGE application_health running Waiting for the consumer Runtime and developer service."
    Write-Host "Waiting for the presentation Runtime at $livenessUrl ..."
    if (-not (Wait-HttpReady -Url $livenessUrl -TimeoutSeconds $StartupTimeoutSeconds)) {
        & docker compose -f $composePath ps
        & docker compose -f $composePath logs --tail 120 app
        throw "Presentation service did not become ready within $StartupTimeoutSeconds seconds."
    }
    if (-not (Wait-HttpReady -Url $developerUrl -TimeoutSeconds $StartupTimeoutSeconds)) {
        & docker compose -f $composePath ps
        & docker compose -f $composePath logs --tail 120 app
        throw "Developer service did not become ready within $StartupTimeoutSeconds seconds."
    }
    Write-Host "BDDE38_STAGE application_health ok Runtime services are responding on ports $HttpPort and $DeveloperPort."

    if (-not $SkipSmoke) {
        $script:FailureStage = "smoke_test"
        $script:FailureExitCode = 22
        Write-Host "BDDE38_STAGE smoke_test running Querying all five Iceberg metrics through the application."
        & (Join-Path $PSScriptRoot "test-presentation.ps1") `
            -DeploymentProfilePath $DeploymentProfilePath `
            -HttpPort $HttpPort `
            -DeveloperPort $DeveloperPort `
            -TunnelPort $LocalTunnelPort
        if ($LASTEXITCODE -ne 0) {
            throw "Presentation smoke test failed with exit code $LASTEXITCODE."
        }
        Write-Host "BDDE38_STAGE smoke_test ok All five Iceberg metrics and all presentation endpoints passed."
    }
    else {
        Write-Host "BDDE38_STAGE smoke_test info Smoke validation was explicitly skipped; full readiness is not asserted."
    }
}
finally {
    Pop-Location
}

Write-Host "Official site: http://127.0.0.1:$HttpPort/"
Write-Host "Dashboard:     http://127.0.0.1:$HttpPort/dashboard/"
Write-Host "Developer:     http://127.0.0.1:$DeveloperPort/"
if (-not $SkipSmoke) {
    Write-Host "BDDE38_STAGE ready ok Presentation environment is fully ready."
}
