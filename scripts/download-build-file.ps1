# Bootstrap downloads cannot depend on Node or PowerShell 7.
function Get-BuildDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Uri,
        [Parameter(Mandatory = $true)][string]$OutFile,
        [scriptblock]$Validate
    )
    $Attempts = 5
    $TimeoutSeconds = 1800
    $Partial = "$OutFile.$([guid]::NewGuid().ToString('N')).partial"
    try {
        for ($Attempt = 1; $Attempt -le $Attempts; $Attempt++) {
            Write-Host "[download] $Uri attempt ${Attempt}/${Attempts}, timeout ${TimeoutSeconds}s"
            try {
                Invoke-WebRequest -Uri $Uri -OutFile $Partial -UseBasicParsing -TimeoutSec $TimeoutSeconds
                break
            } catch {
                Remove-Item -LiteralPath $Partial -Force -ErrorAction SilentlyContinue
                $Response = $_.Exception.Response
                $Status = if ($null -ne $Response) { [int]$Response.StatusCode } else { 0 }
                $Transient = $Status -in @(408, 429, 500, 502, 503, 504) -or
                    ($Status -eq 0 -and ($_.Exception -is [System.Net.WebException] -or
                        $_.Exception.GetType().FullName -in @('System.Net.Http.HttpRequestException',
                            'System.Threading.Tasks.TaskCanceledException')))
                if (-not $Transient -or $Attempt -eq $Attempts) {
                    throw "Download failed: $Uri (attempt ${Attempt}/${Attempts}, timeout ${TimeoutSeconds}s): $($_.Exception.Message)"
                }
                Write-Host "[download] transient failure; retry in $Attempt second(s)"
                Start-Sleep -Seconds $Attempt
            }
        }
        if ($Validate -and -not (& $Validate $Partial)) { throw "Downloaded artifact validation failed: $Uri" }
        Move-Item -LiteralPath $Partial -Destination $OutFile -Force
    } finally {
        Remove-Item -LiteralPath $Partial -Force -ErrorAction SilentlyContinue
    }
}
