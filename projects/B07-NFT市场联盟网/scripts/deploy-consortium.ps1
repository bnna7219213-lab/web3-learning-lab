# b07-deploy.ps1: deploy LabCredential to the consortium chain (Windows entry point)
# The bash version is script/deploy.sh; this one exists because Git Bash does not inherit the
# Windows PATH here (forge not found), and because the paths contain non-ASCII project names.
$ErrorActionPreference = 'Stop'
$proj = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location $proj

$envFile = Join-Path $proj 'env\consortium.env'
$localEnv = Join-Path $proj 'env\.env.local'
foreach ($f in @($envFile, $localEnv)) {
    if (-not (Test-Path $f)) { throw "missing $f" }
}
# parse KEY=VALUE (ignore comments/blank)
$cfg = @{}
foreach ($f in @($envFile, $localEnv)) {
    foreach ($line in [System.IO.File]::ReadAllLines($f)) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        $i = $t.IndexOf('=')
        if ($i -lt 1) { continue }
        $k = $t.Substring(0, $i).Trim()
        $v = $t.Substring($i + 1).Trim()
        # strip trailing comment
        if ($v -match '^(.*?)\s+#') { $v = $Matches[1].Trim() }
        $cfg[$k] = $v
    }
}
$rpc = $cfg['RPC_URL']
$gasLimit = $cfg['PER_TX_GAS_LIMIT']
$pk = $cfg['ISSUER_PRIVATE_KEY']

"== profile=consortium  rpc=$rpc  gas=zero  evm=london  gasLimit=$gasLimit =="
$env:FOUNDRY_PROFILE = 'consortium'
$env:EVM_VERSION_RECORD = 'london'
$env:NETWORK_PROFILE = 'consortium'
$env:DEPLOYER_PRIVATE_KEY = $pk

& forge build --quiet
if ($LASTEXITCODE -ne 0) { throw "forge build failed" }
"build ok (london)"

& forge script script/Deploy.s.sol:Deploy --rpc-url $rpc --broadcast --slow -vv `
    --private-key $pk --legacy --gas-price 0 --gas-limit $gasLimit
if ($LASTEXITCODE -ne 0) { throw "forge script failed" }

New-Item -ItemType Directory -Force -Path (Join-Path $proj 'abi') | Out-Null
$enc = New-Object System.Text.UTF8Encoding($false)
$abiJson = (& forge inspect LabCredential abi --json) -join "`n"
[System.IO.File]::WriteAllText((Join-Path $proj 'abi\LabCredential.json'), $abiJson, $enc)
$selJson = (& forge inspect LabCredential methodIdentifiers --json) -join "`n"
[System.IO.File]::WriteAllText((Join-Path $proj 'abi\LabCredential.selectors.json'), $selJson, $enc)
"abi exported (no BOM)"
Get-Content (Join-Path $proj 'deployments\latest.json') -Encoding UTF8
