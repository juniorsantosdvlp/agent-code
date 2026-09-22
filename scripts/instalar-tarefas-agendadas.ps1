# Registra (ou reregistra, idempotente) as duas Tarefas Agendadas que mantêm
# o Agent Code sempre aberto e sempre atualizado a partir de 'minha-versao'.
# Rodar manualmente, uma vez, como o usuário normal (sem elevação -- a
# instalação do app é per-user, então as tarefas também não precisam admin):
#
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\instalar-tarefas-agendadas.ps1
#
# Reexecutável a qualquer momento sem efeito colateral (desregistra e
# registra de novo). Por padrão registra a tarefa pesada com -InstalarApp
# desligado (Fase 1 do rollout) -- ver o plano em scripts/README ou o
# histórico do commit para o porquê da ativação em duas fases.
param(
  [switch]$InstalarApp
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$watchdogScript = Join-Path $root 'scripts\watchdog-agent-code.ps1'
$syncScript = Join-Path $root 'scripts\sincronizar-e-instalar-agent-code.ps1'

function Register-Idempotent {
  param(
    [string]$Name,
    [string]$ScriptPath,
    [string]$Arguments,
    [Microsoft.Management.Infrastructure.CimInstance[]]$Triggers,
    [int]$ExecutionTimeLimitMinutes
  )
  Unregister-ScheduledTask -TaskName $Name -Confirm:$false -ErrorAction SilentlyContinue

  $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$ScriptPath`" $Arguments"
  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes $ExecutionTimeLimitMinutes) `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $Triggers `
    -Settings $settings -Principal $principal | Out-Null
  Write-Host "Registrada: $Name"
}

# ---- Tarefa 1: watchdog leve, a cada 5 min + ao logar ----------------------
$watchdogLogon = New-ScheduledTaskTrigger -AtLogOn
$watchdogLogon.Delay = 'PT1M'
$watchdogDaily = New-ScheduledTaskTrigger -Daily -At '00:05'
$watchdogDaily.Repetition = (New-ScheduledTaskTrigger -Once -At '00:05' -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition

Register-Idempotent -Name 'AgentCode-Watchdog' -ScriptPath $watchdogScript -Arguments '' `
  -Triggers @($watchdogLogon, $watchdogDaily) -ExecutionTimeLimitMinutes 5

# ---- Tarefa 2: sincronizar+build(+instalar), a cada 3h + ao logar ---------
$syncLogon = New-ScheduledTaskTrigger -AtLogOn
$syncLogon.Delay = 'PT2M'
$syncDaily = New-ScheduledTaskTrigger -Daily -At '07:00'
$syncDaily.Repetition = (New-ScheduledTaskTrigger -Once -At '07:00' -RepetitionInterval (New-TimeSpan -Hours 3) -RepetitionDuration (New-TimeSpan -Days 1)).Repetition

# [switch] no script alvo: presenca/ausencia da flag, nunca ":$true"/":$false"
# (esse token nao sobrevive atravessando o Agendador de Tarefas ate o
# processo filho -- chega como a STRING "$false", que o parametro rejeita).
$installArg = if ($InstalarApp) { '-InstalarApp' } else { '' }
Register-Idempotent -Name 'AgentCode-SincronizarEInstalar' -ScriptPath $syncScript -Arguments $installArg `
  -Triggers @($syncLogon, $syncDaily) -ExecutionTimeLimitMinutes 60

Write-Host ""
Write-Host "Fase de instalacao automatica: $(if ($InstalarApp) { 'LIGADA' } else { 'DESLIGADA (so sincroniza/builda)' })"
Write-Host "Para ligar depois de validar 'AgentCode-setup.exe /S' manualmente:"
Write-Host "  pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\instalar-tarefas-agendadas.ps1 -InstalarApp"
