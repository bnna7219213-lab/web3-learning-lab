# deploy-faucet.ps1: deploy LabFaucet to the consortium chain (Windows entry point)
# Chain on the usage of budgets: the daily allowance lives on-chain from here on,
# and both the B03 faucet and the B07 credential-issuing service read the same chain fact.
$ErrorActionPreference = 'Stop'
$proj = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repo = (Resolve-Path (Join-Path $proj '..\..')).Path
Set-Location $proj

function Read-EnvFile([string]$file) {
    $cfg = @{}
    if (-not (Test-Path $file)) { return $cfg }
    foreach ($line in [System.IO.File]::ReadAllLines($file)) {
        $t = $line.Trim()
        if ($t -eq '' -or $t.StartsWith('#')) { continue }
        $i = $t.IndexOf('=')
        if ($i -lt 1) { continue }
        $k = $t.Substring(0, $i).Trim()
        $v = $t.Substring($i + 1).Trim()
        if ($v -match '^(.*?)\s+#') { $v = $Matches[1].Trim() }
        $cfg[$k] = $v
    }
    return $cfg
}

$cfg = @{}
foreach ($f in @((Join-Path $proj 'env\consortium.env'), (Join-Path $repo '.env'))) {
    $part = Read-EnvFile $f
    foreach ($k in $part.Keys) { $cfg[$k] = $part[$k] }
}
$rpc = $cfg['RPC_URL']
$gasLimit = $cfg['PER_TX_GAS_LIMIT']
$pk = $cfg['FAUCET_PK']
$admin = $cfg['CONSORTIUM_ADMIN_ADDRESS']
if (-not $pk) { throw 'root .env is missing FAUCET_PK (deployer + faucet funder)' }
if (-not $admin) { $admin = $pk }

"== profile=consortium  rpc=$rpc  gas=zero  evm=london  gasLimit=$gasLimit =="
$env:FOUNDRY_PROFILE = 'consortium'
$env:EVM_VERSION_RECORD = 'london'
$env:NETWORK_PROFILE = 'consortium'
$env:DEPLOYER_PRIVATE_KEY = $pk
$env:CONTRACT_ADMIN = $admin
$env:FAUCET_DAILY_CAP = '500000000000000000000'
$env:FAUCET_AMOUNT_PER_CLAIM = '10000000000000000000'
$env:FAUCET_COOLDOWN_SECONDS = '60'

& forge build --quiet
if ($LASTEXITCODE -ne 0) { throw 'forge build failed' }
'build ok (london)'

& forge script script/DeployFaucet.s.sol:DeployFaucet --rpc-url $rpc --broadcast --slow -vv `
    --private-key $pk --legacy --gas-price 0 --gas-limit $gasLimit
if ($LASTEXITCODE -ne 0) { throw 'forge script failed' }

# Export ABI (no BOM: Set-Content -Encoding UTF8 writes a BOM under PowerShell 5.1, and JSON.parse chokes on it)
$enc = New-Object System.Text.UTF8Encoding($false)
New-Item -ItemType Directory -Force -Path (Join-Path $proj 'abi') | Out-Null
$abiJson = (& forge inspect LabFaucet abi --json) -join "`n"
[System.IO.File]::WriteAllText((Join-Path $proj 'abi\LabFaucet.json'), $abiJson, $enc)
$selJson = (& forge inspect LabFaucet methodIdentifiers --json) -join "`n"
[System.IO.File]::WriteAllText((Join-Path $proj 'abi\LabFaucet.selectors.json'), $selJson, $enc)

# The B03 faucet service is a separate project: copy the ABI + deployment record over so it stays self-contained.
# NOTE: this file must stay pure ASCII. PowerShell 5.1 reads BOM-less .ps1 as GBK, so a non-ASCII
# project path in the source turns into mojibake and the copy lands in a garbage directory.
# Resolve the target by glob instead.
$b03 = Get-ChildItem (Join-Path $repo 'projects') -Directory |
    Where-Object { $_.Name -like 'B03-*' -and (Test-Path (Join-Path $_.FullName 'faucet\server.js')) } |
    Select-Object -First 1
if (-not $b03) { throw 'B03 faucet project directory not found' }
New-Item -ItemType Directory -Force -Path (Join-Path $b03.FullName 'faucet\abi') | Out-Null
[System.IO.File]::WriteAllText((Join-Path $b03.FullName 'faucet\abi\LabFaucet.json'), $abiJson, $enc)
"copied ABI to $($b03.FullName)\faucet\abi\LabFaucet.json"

node scripts/merge-faucet-deployment.js
if ($LASTEXITCODE -ne 0) { throw 'merge deployment record failed' }

'== funding the faucet contract =='
node scripts/10-fund-faucet.js
if ($LASTEXITCODE -ne 0) { throw 'fund failed' }

'== done =='
Get-Content (Join-Path $proj 'deployments\latest.json') -Encoding UTF8
