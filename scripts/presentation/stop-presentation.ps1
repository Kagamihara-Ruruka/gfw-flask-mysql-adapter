[CmdletBinding()]
param(
    [switch]$KeepTunnel,
    [switch]$RemoveVolumes
)

$ErrorActionPreference = "Stop"
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$composePath = Join-Path $repoRoot "compose.presentation.yaml"
$runtimeDir = Join-Path $repoRoot ".runtime"
$deploymentProfilePath = Join-Path $repoRoot "config\presentation\deployment.profile.json"
$wrapperPidPath = Join-Path $runtimeDir "presentation-bridge.pid"
$readyPath = Join-Path $runtimeDir "presentation-bridge.ready"
$ownerStatePath = Join-Path $runtimeDir "presentation-bridge-owner.json"
$smokeStatePath = Join-Path $runtimeDir "presentation-smoke-state.json"
$eezDataPath = Join-Path $repoRoot "data\eez"
$bridgeScript = Join-Path $PSScriptRoot "presentation-bridge.ps1"
$bootstrapContainerName = "bdde38-presentation-eez-bootstrap"
$script:FailureStage = "preflight"
$script:FailureExitCode = 2

$deploymentProfile = Get-Content -LiteralPath $deploymentProfilePath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($deploymentProfile.schema -ne "bdde38.presentation.deployment.v1") {
    throw "Unsupported deployment profile schema: $($deploymentProfile.schema)"
}
$localTunnelPort = [int]$deploymentProfile.ports.local_tunnel
$remoteBridgePort = [int]$deploymentProfile.ports.remote_bridge
$namespace = [string]$deploymentProfile.cluster.namespace
$sparkTarget = [string]$deploymentProfile.cluster.spark_target

trap {
    Write-Host ("BDDE38_STAGE {0} failed {1}" -f $script:FailureStage, $_.Exception.Message) -ForegroundColor Red
    exit $script:FailureExitCode
}

function Stop-ProcessTree {
    param([int]$ProcessId)
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $ProcessId" -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
        Stop-ProcessTree -ProcessId ([int]$child.ProcessId)
    }
    Stop-Process -Id $ProcessId -Force -ErrorAction SilentlyContinue
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

function Get-BridgeOwnerToken {
    if (Test-Path -LiteralPath $readyPath -PathType Leaf) {
        $readyLine = Get-Content -LiteralPath $readyPath -Raw -Encoding UTF8
        $match = [regex]::Match($readyLine, 'owner_token=([A-Za-z0-9_.-]{16,128})')
        if ($match.Success) {
            return $match.Groups[1].Value
        }
    }

    if (-not (Test-Path -LiteralPath $ownerStatePath -PathType Leaf)) {
        return $null
    }
    try {
        $state = Get-Content -LiteralPath $ownerStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
        $profileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $deploymentProfilePath).Hash.ToLowerInvariant()
        if (
            [string]$state.schema -eq "bdde38.presentation.bridge_owner.v1" `
            -and [string]$state.owner_token -match '^[A-Za-z0-9_.-]{16,128}$' `
            -and [string]$state.profile_hash -eq $profileHash `
            -and [string]$state.ssh_target -eq [string]$deploymentProfile.cluster.ssh_target `
            -and [string]$state.namespace -eq $namespace `
            -and [string]$state.spark_target -eq $sparkTarget `
            -and [int]$state.remote_bridge_port -eq $remoteBridgePort `
            -and [int]$state.local_tunnel_port -eq $localTunnelPort
        ) {
            return [string]$state.owner_token
        }
    }
    catch {
        Write-Warning "Ignoring unreadable presentation bridge owner evidence: $($_.Exception.Message)"
    }
    return $null
}

function Get-OwnedOrphanedSshProcess {
    param([string]$OwnerToken)

    if ([string]::IsNullOrWhiteSpace($OwnerToken)) {
        return $null
    }

    $forwardSpec = "127.0.0.1:${localTunnelPort}:127.0.0.1:${remoteBridgePort}"
    $ownerMarker = "OWNER_TOKEN=`"${OwnerToken}`""
    $remotePortMarker = "REMOTE_BRIDGE_PORT=${remoteBridgePort}"
    $namespaceMarker = "NAMESPACE=`"${namespace}`""
    $targetMarker = "TARGET=`"${sparkTarget}`""
    $matches = @()

    foreach ($processInfo in @(Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction SilentlyContinue)) {
        $commandLine = [string]$processInfo.CommandLine
        if (-not $commandLine.Contains($forwardSpec)) {
            continue
        }

        $encodedMatch = [regex]::Match(
            $commandLine,
            "echo\s+'(?<payload>[A-Za-z0-9+/=]{64,})'\s+\|\s+base64"
        )
        if (-not $encodedMatch.Success) {
            continue
        }

        try {
            $payloadBytes = [Convert]::FromBase64String($encodedMatch.Groups['payload'].Value)
            $payload = [Text.Encoding]::UTF8.GetString($payloadBytes)
        }
        catch {
            continue
        }

        if (
            $payload.Contains($ownerMarker) `
            -and $payload.Contains($remotePortMarker) `
            -and $payload.Contains($namespaceMarker) `
            -and $payload.Contains($targetMarker)
        ) {
            $matches += $processInfo
        }
    }

    if ($matches.Count -gt 1) {
        throw "Multiple SSH processes match the presentation owner evidence; refusing ambiguous cleanup."
    }
    if ($matches.Count -eq 1) {
        return $matches[0]
    }
    return $null
}

function Remove-OwnedBootstrapContainer {
    $containerId = & docker ps -aq --filter "name=^/$bootstrapContainerName$"
    if (-not $containerId) {
        return
    }
    $project = (& docker inspect --format '{{ index .Config.Labels "com.docker.compose.project" }}' $containerId).Trim()
    $service = (& docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' $containerId).Trim()
    if ($project -ne "bdde38-presentation" -or $service -ne "eez-bootstrap") {
        throw "Refusing to stop unowned container named $bootstrapContainerName."
    }
    & docker rm -f $containerId | Out-Null
}

Push-Location $repoRoot
try {
    $script:FailureStage = "docker_app"
    $script:FailureExitCode = 20
    Write-Host "BDDE38_STAGE docker_app running Stopping the owned presentation Compose project."
    Remove-OwnedBootstrapContainer
    $downArguments = @("compose", "-f", $composePath, "down")
    if ($RemoveVolumes) {
        $downArguments += "--volumes"
    }
    & docker @downArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Docker Compose shutdown failed with exit code $LASTEXITCODE."
    }
    Write-Host "BDDE38_STAGE docker_app ok The presentation Compose project is stopped."

    if (Test-Path -LiteralPath $eezDataPath -PathType Container) {
        Get-ChildItem -LiteralPath $eezDataPath -Recurse -File -ErrorAction SilentlyContinue |
            Where-Object { $_.Name.EndsWith(".part") -or $_.Name.EndsWith(".lock") } |
            Remove-Item -Force -ErrorAction SilentlyContinue
    }
}
finally {
    Pop-Location
}

$ownerEvidenceAvailable = -not [string]::IsNullOrWhiteSpace((Get-BridgeOwnerToken))
$bridgeArtifactsAvailable = (Test-Path $wrapperPidPath) -or (Test-Path $readyPath)
$ownedTunnelCandidate = $ownerEvidenceAvailable -and (Test-TcpPort -HostName "127.0.0.1" -Port $localTunnelPort)
if (-not $KeepTunnel -and ($bridgeArtifactsAvailable -or $ownedTunnelCandidate)) {
    $script:FailureStage = "ssh_tunnel"
    $script:FailureExitCode = 13
    Write-Host "BDDE38_STAGE ssh_tunnel running Stopping the owned presentation bridge."
    $bridgeStopped = $false
    $savedPid = 0
    if (
        (Test-Path -LiteralPath $wrapperPidPath -PathType Leaf) `
        -and [int]::TryParse((Get-Content -Raw $wrapperPidPath).Trim(), [ref]$savedPid)
    ) {
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId = $savedPid" -ErrorAction SilentlyContinue
        $bridgePattern = [regex]::Escape($bridgeScript)
        $isOwnedBridge = $null -ne $processInfo `
            -and [System.IO.Path]::GetFileName($processInfo.ExecutablePath) -ieq "powershell.exe" `
            -and $processInfo.CommandLine -match $bridgePattern
        if ($isOwnedBridge) {
            Stop-ProcessTree -ProcessId $savedPid
            $bridgeStopped = $true
            Write-Host "Stopped the presentation bridge process tree (PID $savedPid)."
        }
        elseif ($null -ne $processInfo) {
            Write-Warning "Refusing to stop PID $savedPid because it is not the owned presentation bridge."
        }
    }

    if (-not $bridgeStopped) {
        $ownerToken = Get-BridgeOwnerToken
        $orphanedSsh = Get-OwnedOrphanedSshProcess -OwnerToken $ownerToken
        if ($null -ne $orphanedSsh) {
            Stop-ProcessTree -ProcessId ([int]$orphanedSsh.ProcessId)
            $bridgeStopped = $true
            Write-Host "Stopped the owner-verified orphaned SSH bridge (PID $($orphanedSsh.ProcessId))."
        }
    }

    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        if (-not (Test-TcpPort -HostName "127.0.0.1" -Port $localTunnelPort)) {
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (Test-TcpPort -HostName "127.0.0.1" -Port $localTunnelPort) {
        throw "Port 127.0.0.1:$localTunnelPort remains occupied without sufficient owner evidence; refusing to stop an unowned process."
    }
    Remove-Item -LiteralPath $wrapperPidPath, $readyPath -Force -ErrorAction SilentlyContinue
    Write-Host "BDDE38_STAGE ssh_tunnel ok Active bridge state was removed; owner evidence was retained for safe recovery."
}
elseif ($KeepTunnel) {
    Write-Host "BDDE38_STAGE ssh_tunnel info The caller requested that the tunnel remain running."
}

Remove-Item -LiteralPath $smokeStatePath -Force -ErrorAction SilentlyContinue
