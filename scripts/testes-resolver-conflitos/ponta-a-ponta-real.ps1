# Ponta a ponta REAL (chama o Claude Code de verdade, gasta a conta da máquina)
# em modo dry-run: resolve o par <BaseRef> x <BranchRef> numa worktree isolada,
# com -StateDir numa pasta temporária, e não move branch nem cria tag.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\testes-resolver-conflitos\ponta-a-ponta-real.ps1 `
#     -BranchRef backup/minha-versao-2026-10-05 -Politica descartar-e-avisar
#
# O relatório fica em <StateDir>\ultima-resolucao.json e o log em <StateDir>\logs.
param(
  [string]$RepoPath = (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)),
  [string]$BaseRef = 'main',
  [string]$BranchRef = 'backup/minha-versao-2026-10-05',
  [string]$Politica = 'descartar-e-avisar',
  [string]$Modelo = '',
  [int]$TimeoutMinutos = 40,
  [string]$StateDir = (Join-Path $env:TEMP 'e2e-resolver-conflitos')
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null
# Começa limpo: sem relatório anterior (a anti-repetição pularia o par).
Remove-Item -LiteralPath (Join-Path $StateDir 'ultima-resolucao.json') -Force -ErrorAction SilentlyContinue
$cfg = [ordered]@{ ativo = $true; politicaCommitSuperado = $Politica; modelo = $Modelo; timeoutMinutos = $TimeoutMinutos }
[IO.File]::WriteAllText((Join-Path $StateDir 'resolver-conflitos.json'), ($cfg | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))

$resolvedor = Join-Path (Split-Path -Parent $PSScriptRoot) 'resolver-conflitos-agente.ps1'
& powershell -NoProfile -ExecutionPolicy Bypass -File $resolvedor -RepoPath $RepoPath -BaseRef $BaseRef -BranchRef $BranchRef -NoApply -StateDir $StateDir
$codigo = $LASTEXITCODE
Write-Host "resolvedor saiu com $codigo; relatorio: $(Join-Path $StateDir 'ultima-resolucao.json')"
exit $codigo
