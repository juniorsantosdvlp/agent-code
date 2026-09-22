# Mantém o Agent Code aberto e atualizado sem depender do Agendador de
# Tarefas do Windows. Existe porque, nesta máquina, Register-ScheduledTask
# nega acesso mesmo para o usuário dono (token do UAC filtrado -- ver
# scripts/instalar-tarefas-agendadas.ps1, que fica como caminho preferido
# se algum dia a máquina permitir tarefas agendadas sem elevação).
#
# Iniciado pela pasta Inicializar do Windows (roda como processo comum, sem
# elevação nenhuma), num loop que nunca termina: chama watchdog-agent-code.ps1
# a cada 5 min e sincronizar-e-instalar-agent-code.ps1 a cada 3h -- os dois
# scripts já existentes e testados, sem duplicar a lógica deles aqui.
#
# Uso manual (o mesmo que o atalho da pasta Inicializar chama):
#   powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File scripts\loop-manter-atualizado.ps1
param(
  # [switch], não [bool]: ver o comentário equivalente em
  # sincronizar-e-instalar-agent-code.ps1 -- token booleano não sobrevive
  # atravessando Start-Process -ArgumentList.
  [switch]$InstalarApp,
  [int]$WatchdogIntervalSeconds = 300,   # 5 min
  [int]$SyncIntervalSeconds = 10800      # 3 h
)
$ErrorActionPreference = 'Continue'  # o loop nunca pode morrer por causa de uma iteracao ruim
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $env:LOCALAPPDATA 'AgentCodeAutoUpdate'
$logPath = Join-Path $stateDir 'logs\loop.log'
$loopLockPath = Join-Path $stateDir 'loop.lock'

New-Item -ItemType Directory -Force -Path $stateDir, (Split-Path -Parent $logPath) | Out-Null

function Note([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  try {
    if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 2MB) {
      Move-Item -LiteralPath $logPath -Destination "$logPath.old" -Force
    }
    Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
  } catch { }
}

# ---- so um loop por vez: se ja tem um rodando (pid vivo), este sai -------
if (Test-Path -LiteralPath $loopLockPath -PathType Leaf) {
  try {
    $existing = Get-Content -LiteralPath $loopLockPath -Raw -Encoding utf8 | ConvertFrom-Json
    if ($existing -and (Get-Process -Id $existing.pid -ErrorAction SilentlyContinue)) {
      Note "ja existe um loop rodando (pid=$($existing.pid)) -- saindo."
      exit 0
    }
  } catch { }
}
@{ pid = $PID; at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json |
  Set-Content -LiteralPath $loopLockPath -Encoding utf8

Note "===== loop iniciado (pid=$PID, InstalarApp=$InstalarApp) ====="

$watchdog = Join-Path $root 'scripts\watchdog-agent-code.ps1'
$sync = Join-Path $root 'scripts\sincronizar-e-instalar-agent-code.ps1'
$ultimoSync = [DateTime]::MinValue

try {
  while ($true) {
    try {
      $p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $watchdog) -PassThru -Wait -WindowStyle Hidden
      if ($p.ExitCode -ne 0) { Note "watchdog saiu com codigo $($p.ExitCode)" }
    } catch {
      Note "AVISO: watchdog falhou: $($_.Exception.Message)"
    }

    $agora = Get-Date
    if (($agora - $ultimoSync).TotalSeconds -ge $SyncIntervalSeconds) {
      try {
        $argumentos = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $sync)
        if ($InstalarApp) { $argumentos += '-InstalarApp' }
        $p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argumentos -PassThru -Wait -WindowStyle Hidden
        Note "ciclo de sync+build executado (codigo $($p.ExitCode))"
        # Codigo 20 = instalacao adiada pelo guard (app ocupado/estado
        # desconhecido), nao falha real. NAO avanca $ultimoSync, para o
        # proximo watchdog (5min) tentar de novo -- senao a instalacao
        # pendente ficaria presa ate o proximo ciclo de 3h.
        if ($p.ExitCode -ne 20) { $ultimoSync = $agora }
      } catch {
        Note "AVISO: sincronizar-e-instalar-agent-code.ps1 falhou: $($_.Exception.Message)"
        $ultimoSync = $agora
      }
    }

    Start-Sleep -Seconds $WatchdogIntervalSeconds
  }
} finally {
  Remove-Item -LiteralPath $loopLockPath -Force -ErrorAction SilentlyContinue
  Note "===== loop encerrado ====="
}
