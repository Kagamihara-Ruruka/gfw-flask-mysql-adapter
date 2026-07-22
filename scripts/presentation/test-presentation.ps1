[CmdletBinding()]
param(
    [string]$DeploymentProfilePath = "",
    [int]$HttpPort = 0,
    [int]$DeveloperPort = 0,
    [int]$TunnelPort = 0,
    [int]$RequestTimeoutSeconds = 360
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
$HttpPort = if ($HttpPort) { $HttpPort } else { [int]$deploymentProfile.ports.host_http }
$DeveloperPort = if ($DeveloperPort) { $DeveloperPort } else { [int]$deploymentProfile.ports.host_developer }
$TunnelPort = if ($TunnelPort) { $TunnelPort } else { [int]$deploymentProfile.ports.local_tunnel }
$profileHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $DeploymentProfilePath).Hash.ToLowerInvariant()
$servingStart = [string]$deploymentProfile.data.serving_start
$servingEnd = [string]$deploymentProfile.data.serving_end
$crossMonthDates = @("2022-01-31", "2022-02-01")
$queryDates = @($servingStart) + $crossMonthDates + @($servingEnd) | Select-Object -Unique
$runtimeDir = Join-Path $repoRoot ".runtime"
$transcriptPath = Join-Path $runtimeDir "presentation-smoke-transcript.txt"
$smokeStatePath = Join-Path $runtimeDir "presentation-smoke-state.json"
$baseUrl = "http://127.0.0.1:$HttpPort"
$developerUrl = "http://127.0.0.1:$DeveloperPort/"

function Assert-True {
    param([bool]$Condition, [string]$Message)
    if (-not $Condition) {
        throw $Message
    }
}

function Test-TcpPort {
    param([string]$HostName, [int]$Port, [int]$TimeoutMilliseconds = 1000)
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

function Get-Json {
    param([string]$Url)
    return Invoke-RestMethod -Uri $Url -TimeoutSec $RequestTimeoutSeconds
}

New-Item -ItemType Directory -Force $runtimeDir | Out-Null
Remove-Item -LiteralPath $smokeStatePath, $transcriptPath -Force -ErrorAction SilentlyContinue
Start-Transcript -Path $transcriptPath -Force
try {
    Write-Host "BDDE38_STAGE smoke_test running Validating all endpoints and five Iceberg metrics."
    Assert-True (Test-TcpPort -HostName "127.0.0.1" -Port $TunnelPort) "Spark SSH tunnel is not reachable on port $TunnelPort."

    $health = Get-Json "$baseUrl/api/health"
    Assert-True ($health.status -in @("ok", "degraded")) "Adapter health endpoint returned an invalid status."
    Assert-True (($health.mapping_errors | Measure-Object).Count -eq 0) "Presentation mappings contain runtime errors."

    $runtimeIdentity = Get-Json "$baseUrl/api/runtime/identity"
    Assert-True ($runtimeIdentity.profile -eq "PRESENTATION") "Consumer Runtime profile is not PRESENTATION."
    Assert-True ($runtimeIdentity.managed_by -eq "presentationctl") "Consumer Runtime is not owned by presentationctl."
    Assert-True ($runtimeIdentity.query_backend -in @("hive", "spark")) "Consumer Runtime is not using Spark Thrift."
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$runtimeIdentity.runtime_instance_id)) "Runtime instance identity is missing."
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$runtimeIdentity.runtime_fingerprint)) "Runtime fingerprint is missing."
    foreach ($field in @(
        "config_bundle_hash",
        "image_digest",
        "compose_hash",
        "bridge_owner_token",
        "deployment_profile_hash",
        "deployment_environment",
        "deployment_target"
    )) {
        $value = [string]$runtimeIdentity.$field
        Assert-True ($value -and $value -notin @("unmanaged", "missing")) "Runtime deployment evidence is missing: $field"
    }
    Assert-True ($runtimeIdentity.deployment_profile_hash -eq $profileHash) "Runtime uses a different deployment profile generation."
    Assert-True ($runtimeIdentity.deployment_environment -eq $deploymentProfile.cluster.environment) "Runtime environment is not the formal deployment environment."
    Assert-True ($runtimeIdentity.deployment_target -eq $deploymentProfile.cluster.ssh_target) "Runtime cluster target differs from the deployment profile."
    Assert-True ($health.runtime_fingerprint -eq $runtimeIdentity.runtime_fingerprint) "Health and Consumer Runtime identities differ."

    $developerIdentity = Get-Json "http://127.0.0.1:$DeveloperPort/api/developer/runtime/identity"
    Assert-True ($developerIdentity.identity_match -eq $true) "Dashboard and Developer Runtime identities differ."
    Assert-True ($developerIdentity.runtime_fingerprint -eq $runtimeIdentity.runtime_fingerprint) "Developer Runtime fingerprint differs from Consumer."

    $hiveRoutes = @(
        $health.routes | Where-Object {
            $_.source_route_group -eq "database" -and $_.backend -in @("hive", "spark")
        }
    )
    Assert-True ($hiveRoutes.Count -gt 0) "Health has no Spark Thrift database route."
    Assert-True (@($hiveRoutes | Where-Object { $_.queryable -eq $true }).Count -gt 0) "Spark Thrift queries work, but health does not report queryable=true."

    $catalog = Get-Json "$baseUrl/api/datasets"
    $expected = @(
        @{ Id = "pipeline_iceberg.chlor_a"; Product = "CHL"; Metric = "chlor_a" },
        @{ Id = "pipeline_iceberg.fishing_hours"; Product = "GFW"; Metric = "fishing_hours" },
        @{ Id = "pipeline_iceberg.ocean_productivity_score"; Product = "PRODUCTIVITY"; Metric = "ocean_productivity_score" },
        @{ Id = "pipeline_iceberg.sea_temperature"; Product = "SST"; Metric = "sea_temperature" },
        @{ Id = "pipeline_iceberg.sustainability_pressure"; Product = "SUSTAINABILITY"; Metric = "sustainability_pressure" }
    )

    $datasetNames = @($catalog.datasets.PSObject.Properties.Name)
    $declaredRanges = @()
    $validatedSamples = @()
    foreach ($item in $expected) {
        Assert-True ($datasetNames -contains $item.Id) "Dataset is missing from the runtime registry: $($item.Id)"

        $datasetId = [Uri]::EscapeDataString($item.Id)
        $schema = Get-Json "$baseUrl/api/datasets/$datasetId/schema?aoi=northwest_pacific"
        $dates = @($schema.dates)
        Assert-True ($dates.Count -gt 0) "Effective Mapping exposes no dates for $($item.Id)."
        $declaredRanges += ,@([string]$dates[0], [string]$dates[-1])

        Assert-True ([string]$dates[0] -eq $servingStart) "Mapping start date differs from the formal deployment profile for $($item.Id)."
        Assert-True ([string]$dates[-1] -eq $servingEnd) "Mapping end date differs from the formal deployment profile for $($item.Id)."
        foreach ($sampleDate in $queryDates) {
            Assert-True ($dates -contains $sampleDate) "Mapping omits required smoke date $sampleDate for $($item.Id)."
            $date = [Uri]::EscapeDataString($sampleDate)
            $recordsUrl = "$baseUrl/api/datasets/$datasetId/records?date=$date&aoi=northwest_pacific&resolution=32&bbox=120,20,121,21&limit=100"
            $records = Get-Json $recordsUrl
            Assert-True ([int]$records.row_count -gt 0) "Spark returned no sampled-grid rows for $($item.Id) on $sampleDate."
            $validatedSamples += [ordered]@{
                dataset_id = $item.Id
                date = $sampleDate
                row_count = [int]$records.row_count
            }
            Write-Host ("PASS {0}: queried {1} sampled rows on {2}" -f $item.Id, $records.row_count, $sampleDate)
        }
        Write-Host ("PASS {0}: declared {1} dates from {2} through {3}" -f $item.Id, $dates.Count, $dates[0], $dates[-1])
    }
    $rangeStarts = @($declaredRanges | ForEach-Object { $_[0] } | Sort-Object -Unique)
    $rangeEnds = @($declaredRanges | ForEach-Object { $_[1] } | Sort-Object -Unique)
    Assert-True ($rangeStarts.Count -eq 1 -and $rangeEnds.Count -eq 1) "Presentation datasets do not share one effective date range."
    Write-Host ("Effective Mapping date range: {0} through {1}." -f $rangeStarts[0], $rangeEnds[0])

    $site = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/" -TimeoutSec $RequestTimeoutSeconds
    $dashboard = Invoke-WebRequest -UseBasicParsing -Uri "$baseUrl/dashboard/" -TimeoutSec $RequestTimeoutSeconds
    $developer = Invoke-WebRequest -UseBasicParsing -Uri $developerUrl -TimeoutSec $RequestTimeoutSeconds
    Assert-True ($site.StatusCode -eq 200) "Official site is unavailable."
    Assert-True ($dashboard.StatusCode -eq 200) "Dashboard is unavailable."
    Assert-True ($developer.StatusCode -eq 200) "Developer service is unavailable."

    $smokeState = [ordered]@{
        schema = "bdde38.presentation.smoke.v2"
        verified_at = [DateTime]::UtcNow.ToString("o")
        tunnel_port = $TunnelPort
        http_port = $HttpPort
        developer_port = $DeveloperPort
        snapshot = [ordered]@{
            start = $rangeStarts[0]
            end = $rangeEnds[0]
            snapshot_id = [string]$deploymentProfile.data.snapshot_id
            aoi = "northwest_pacific"
        }
        deployment_profile = [ordered]@{
            path = $DeploymentProfilePath
            sha256 = $profileHash
            environment = [string]$deploymentProfile.cluster.environment
            target = [string]$deploymentProfile.cluster.ssh_target
        }
        validated_samples = $validatedSamples
        datasets = @($expected | ForEach-Object { $_.Id })
        runtime_identity = $runtimeIdentity
        developer_identity_match = $developerIdentity.identity_match
    }
    $temporaryStatePath = "$smokeStatePath.$PID.tmp"
    $smokeJson = $smokeState | ConvertTo-Json -Depth 5
    [System.IO.File]::WriteAllText(
        $temporaryStatePath,
        $smokeJson + [Environment]::NewLine,
        [System.Text.UTF8Encoding]::new($false)
    )
    Move-Item -LiteralPath $temporaryStatePath -Destination $smokeStatePath -Force

    Write-Host "PASS official site, dashboard, developer service, runtime registry, SSH tunnel, and all five Spark datasets."
    Write-Host "BDDE38_STAGE smoke_test ok Full presentation acceptance passed."
}
finally {
    Stop-Transcript
}
