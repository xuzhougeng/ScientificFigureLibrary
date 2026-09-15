param([switch]$ResolveOnly, [switch]$Mcp, [Parameter(ValueFromRemainingArguments=$true)][string[]]$ServerArguments)
$ErrorActionPreference = 'Stop'
try {
    Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
    Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
    $nodePath = $env:SFL_NODE_BINARY
    if ($nodePath) {
        if (-not [System.IO.Path]::IsPathRooted($nodePath) -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'SFL_NODE_BINARY must name an existing absolute Node.js executable.' }
    } else {
        $found = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $nodePath = $found.Source }
    }
    if (-not $nodePath) { throw 'Node.js 22+ was not found. Install Node.js, set SFL_NODE_BINARY, or download the bundled-Node ZIP.' }
    $version = & $nodePath --version
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) { throw 'Node.js 22+ is required. Upgrade Node.js or download the bundled-Node ZIP.' }
    if ($ResolveOnly) { Write-Output $nodePath; exit 0 }
    $server = Join-Path $PSScriptRoot 'dist\index.js'
    if ($Mcp) { & $nodePath $server @ServerArguments; exit $LASTEXITCODE }
    & $nodePath $server --local --quiet
    exit $LASTEXITCODE
} catch {
    [Console]::Error.WriteLine($_.Exception.Message)
    exit 1
}
