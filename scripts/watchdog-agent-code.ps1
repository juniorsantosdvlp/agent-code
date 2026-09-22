# Garante que o Agent Code está de pé. Roda pela Tarefa Agendada
# "AgentCode-Watchdog" (ver scripts/instalar-tarefas-agendadas.ps1), a cada
# poucos minutos. Não fecha nada, nunca — só abre se não achar nenhum
# processo rodando. Se uma sincronizacao/instalacao estiver em andamento
# (scripts/sincronizar-e-instalar-agent-code.ps1), fica de fora: aquele
# script já cuida de fechar/reabrir com segurança sozinho.
param(
  [string]$Exe = "$env:LOCALAPPDATA\Programs\Agent Code\Agent Code.exe"
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$stateDir = Join-Path $env:LOCALAPPDATA 'AgentCodeAutoUpdate'
$logDir = Join-Path $stateDir 'logs'
$logPath = Join-Path $logDir 'watchdog.log'
$lockPath = Join-Path $stateDir 'instalacao.lock'

function Rotate-Log([string]$path, [long]$maxBytes = 2MB) {
  if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt $maxBytes) {
    Move-Item -LiteralPath $path -Destination "$path.old" -Force
  }
}

function Note([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
}

New-Item -ItemType Directory -Force -Path $stateDir, $logDir | Out-Null
Rotate-Log $logPath

if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
  try {
    $lock = Get-Content -LiteralPath $lockPath -Raw -Encoding utf8 | ConvertFrom-Json
    if (Get-Process -Id $lock.pid -ErrorAction SilentlyContinue) {
      Note "sincronizacao/instalacao em andamento (pid=$($lock.pid)) -- nada a fazer nesta checagem."
      exit 0
    }
  } catch {
    # Lock ilegível: não é motivo para travar o watchdog, segue a checagem normal.
  }
}

$rodando = @(Get-Process -Name 'Agent Code' -ErrorAction SilentlyContinue)
if ($rodando.Count) {
  # Silencioso no caso comum (a cada poucos minutos, para não inflar o log).
  exit 0
}

if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
  Note "app nao esta rodando e o executavel nao existe em '$Exe' -- nada a fazer (ainda nao foi instalado?)."
  exit 1
}

Note "app nao estava rodando -- reabrindo"
try {
  $started = Start-Process -FilePath $Exe -PassThru
  Note "reaberto pid=$($started.Id)"
} catch {
  Note "FALHA ao reabrir: $($_.Exception.Message)"
  exit 1
}
