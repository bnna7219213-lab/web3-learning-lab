# b07-gen-local-env.ps1: generate env/.env.local from the consortium validator keys (local only, gitignored)
# NOTE: paths are built from $PSScriptRoot on purpose - a Chinese literal path in a .ps1 gets
#       read as GBK by Windows PowerShell 5.1 and breaks the path.
# Role mapping (the 4 validator accounts double as the 4 lab member accounts):
#   ISSUER   -> issuer / admin (mints + registers members)
#   MEMBER_A -> member A (holder, transfers to MEMBER_B)
#   MEMBER_B -> member B (buyer / redeemer-side)
#   OUTSIDER -> not in the member allowlist (negative case)
$ErrorActionPreference = 'Stop'
$proj = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$keyDir = Join-Path $repo 'shared\consortium-network\networkFiles\keys'
$out = Join-Path $proj 'env\.env.local'

$map = [ordered]@{
    'ISSUER_PRIVATE_KEY'   = '0x240c383184aaf85fa4f12b6846ec5c8c5f48eb8b'
    'MEMBER_A_PRIVATE_KEY' = '0x9de4de69c1b85ec62cd3c65a9ddbabf6f0b18585'
    'MEMBER_B_PRIVATE_KEY' = '0xb4e210662463c6747fd235106995c4f9c50b1728'
    'OUTSIDER_PRIVATE_KEY' = '0xbcc5e353c79963e9f9a8b5cc731ba88e614a4af5'
}

$lines = @('# LOCAL ONLY - gitignored by the .env.* rule. Keys are the consortium local validator keys.')
foreach ($k in $map.Keys) {
    $addrDir = $map[$k]
    $key = ([System.IO.File]::ReadAllText((Join-Path (Join-Path $keyDir $addrDir) 'key'))).Trim().Replace('0x', '')
    $lines += ("{0}=0x{1}   # {2}" -f $k, $key, $addrDir)
}
[System.IO.File]::WriteAllText($out, (($lines -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding($false)))
"written: $out"
Get-Content $out | ForEach-Object { $_ -replace '=(0x)?[0-9a-fA-F]{8,}', '=<redacted>' }
"--- git ignore check ---"
Push-Location $repo
git check-ignore -v 'projects/B07-NFT市场联盟网/env/.env.local'
Pop-Location
