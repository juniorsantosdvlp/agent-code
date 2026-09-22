# Mantém o executável instalado do Agent Code alinhado com a branch
# 'minha-versao' do fork. Pensado para rodar sozinho, pela Tarefa Agendada
# "AgentCode-SincronizarEInstalar" (ver scripts/instalar-tarefas-agendadas.ps1).
#
# O que faz, nesta ordem, sempre parando (fail-closed) no primeiro problema:
#   1) sincroniza o repo local (main <- origin/main; minha-versao rebaseada);
#   2) decide se há algo novo desde a última instalação (compara SHA);
#   3) só então builda (typecheck obrigatório, test só informativo);
#   4) se -InstalarApp, fecha o app respeitando o guard de ociosidade,
#      instala silenciosamente e reabre — via relaunch-agent-code.ps1.
#
# Nunca escreve em package.json/versão: a automação builda exatamente o que
# está commitado em minha-versao, sem gerar commits "chore" a cada ciclo.
# bump-version.mjs/build-installer.bat continuam sendo o fluxo manual para
# marcar uma versão de verdade.
#
# Uso manual (o mesmo que a tarefa agendada chama):
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\sincronizar-e-instalar-agent-code.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File scripts\sincronizar-e-instalar-agent-code.ps1 -InstalarApp
#
# [switch], não [bool]: presença/ausência da flag, nunca ":$true"/":$false"
# atravessando fronteira de processo (Start-Process -ArgumentList entrega o
# token cru "$false" como STRING pro parâmetro [bool], que rejeita).
param(
  # Fase 2 do rollout: ausente (padrão), sincroniza e builda mas NUNCA
  # fecha/instala/reabre o app — só deixa o instalador pronto em dist\.
  [switch]$InstalarApp,
  # Onde o app instalado vive hoje (atalho do Menu Iniciar aponta pra cá).
  [string]$Exe = "$env:LOCALAPPDATA\Programs\Agent Code\Agent Code.exe",
  [int]$MaxGuardAge = 15
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot
$stateDir = Join-Path $env:LOCALAPPDATA 'AgentCodeAutoUpdate'
$logDir = Join-Path $stateDir 'logs'
$logPath = Join-Path $logDir 'sincronizar-build-instalar.log'
$statePath = Join-Path $stateDir 'estado.json'
$lockPath = Join-Path $stateDir 'instalacao.lock'

function Rotate-Log([string]$path, [long]$maxBytes = 2MB) {
  if ((Test-Path -LiteralPath $path) -and (Get-Item -LiteralPath $path).Length -gt $maxBytes) {
    Move-Item -LiteralPath $path -Destination "$path.old" -Force
  }
}

function Note([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
  Write-Host $line
}

function Write-Json([string]$path, $object) {
  # Escrita atômica: .tmp + rename, para nunca deixar o arquivo pela metade.
  $tmp = "$path.tmp"
  ($object | ConvertTo-Json -Depth 5) | Set-Content -LiteralPath $tmp -Encoding utf8
  Move-Item -LiteralPath $tmp -Destination $path -Force
}

function Read-Json([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try { return Get-Content -LiteralPath $path -Raw -Encoding utf8 | ConvertFrom-Json }
  catch { return $null }
}

# Comandos nativos (git, npm) escrevem saida normal no stderr (ex.: "From
# https://..." de um fetch bem-sucedido). Com $ErrorActionPreference='Stop',
# PowerShell embrulha cada linha de stderr como ErrorRecord e ISSO PARA O
# SCRIPT mesmo quando o comando teve sucesso (exit code 0) -- pegadinha
# classica. Por isso todo comando nativo cujo stderr pode ter chatter passa
# por aqui: EAP vira 'Continue' só durante a chamada, e quem decide falha ou
# sucesso e sempre $LASTEXITCODE, nunca a presenca de texto no stderr.
function Invoke-Logged([string]$prefix, [string]$exe, [string[]]$argumentos) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  $saida = & $exe @argumentos 2>&1
  $codigo = $LASTEXITCODE
  $ErrorActionPreference = $prev
  $saida | ForEach-Object { Note "$prefix`: $_" }
  return $codigo
}

New-Item -ItemType Directory -Force -Path $stateDir, $logDir | Out-Null
Rotate-Log $logPath

Note "===== inicio (InstalarApp=$InstalarApp) ====="

# ---- lock: evita duas execuções desta tarefa em cima uma da outra --------
if (Test-Path -LiteralPath $lockPath -PathType Leaf) {
  $existingLock = Read-Json $lockPath
  $stillAlive = $existingLock -and (Get-Process -Id $existingLock.pid -ErrorAction SilentlyContinue)
  if ($stillAlive) {
    Note "ABORTADO: ja existe uma execucao em andamento (pid=$($existingLock.pid))."
    exit 10
  }
  Note "lock orfao encontrado (pid morto) -- removendo e seguindo"
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
}
Write-Json $lockPath @{ pid = $PID; at = (Get-Date).ToUniversalTime().ToString('o') }

try {
  Push-Location $root
  try {
    # ---- 1) preflight ----------------------------------------------------
    $branch = (git rev-parse --abbrev-ref HEAD).Trim()
    $dirty = (git status --porcelain)
    if ($branch -notin @('main', 'minha-versao')) {
      Note "ABORTADO: branch atual e '$branch' (esperado main ou minha-versao) -- provavel trabalho manual em andamento."
      exit 11
    }
    if ($dirty) {
      Note "ABORTADO: arvore de trabalho suja -- provavel trabalho manual em andamento. Nada foi tocado."
      exit 11
    }

    if ($branch -ne 'minha-versao') {
      [void](Invoke-Logged 'git' 'git' @('checkout', 'minha-versao'))
    }

    # ---- 2) sincroniza main (ff-only a partir do origin) ------------------
    $codigo = Invoke-Logged 'git' 'git' @('fetch', 'origin', 'main:main')
    if ($codigo -ne 0) {
      Note "ABORTADO: fetch de origin/main para main nao foi fast-forward (main local divergiu?). Revisar manualmente."
      exit 12
    }

    # ---- 3) puxa minha-versao do remoto antes de rebasear -----------------
    [void](Invoke-Logged 'git' 'git' @('fetch', 'origin', 'minha-versao'))
    $remoteShaAntes = (git rev-parse origin/minha-versao).Trim()
    $codigo = Invoke-Logged 'git' 'git' @('merge', '--ff-only', 'origin/minha-versao')
    if ($codigo -ne 0) {
      Note "ABORTADO: minha-versao divergiu de origin/minha-versao (alguem reescreveu o remoto?). Resolucao manual."
      exit 13
    }

    # ---- 4) rebase sobre main ---------------------------------------------
    $codigo = Invoke-Logged 'git' 'git' @('rebase', 'main')
    if ($codigo -ne 0) {
      [void](Invoke-Logged 'git' 'git' @('rebase', '--abort'))
      Note "ABORTADO: conflito no rebase de minha-versao sobre main. Rebase desfeito, nada foi construido/instalado."
      exit 14
    }

    $shaAtual = (git rev-parse HEAD).Trim()

    # ---- 5) empurra de volta (force-with-lease no SHA lido no passo 3) ----
    $codigo = Invoke-Logged 'git' 'git' @('push', "--force-with-lease=minha-versao:$remoteShaAntes", 'origin', 'minha-versao')
    if ($codigo -ne 0) {
      Note "AVISO: push rejeitado (alguem empurrou minha-versao nesse meio-tempo). Local segue sincronizado; proxima execucao tenta de novo."
    }

    Note "sync ok: minha-versao em $shaAtual"

    # ---- 6) decide se builda -----------------------------------------------
    $estado = Read-Json $statePath
    if (-not $estado) {
      $estado = [pscustomobject]@{
        shaInstalado = ''; versaoInstalada = ''; instaladoEm = ''
        shaEmpacotado = ''; caminhoInstalador = ''; empacotadoEm = ''
      }
    }

    $instaladorPronto = $estado.caminhoInstalador -and (Test-Path -LiteralPath $estado.caminhoInstalador -PathType Leaf)

    if ($shaAtual -eq $estado.shaInstalado) {
      Note "nada novo: SHA atual ja e o instalado ($shaAtual). Fim."
      $precisaBuildar = $false
    } elseif ($shaAtual -eq $estado.shaEmpacotado -and $instaladorPronto) {
      Note "SHA atual ja foi empacotado antes ($shaAtual) -- reaproveitando o instalador existente, sem rebuildar."
      $precisaBuildar = $false
    } else {
      $precisaBuildar = $true
    }

    if ($precisaBuildar) {
      Note "build necessario: $shaAtual"
      $codigo = Invoke-Logged 'typecheck' 'npm' @('run', 'typecheck')
      if ($codigo -ne 0) {
        Note "ABORTADO: typecheck falhou -- isso e regressao real (baseline e limpa). Nao builda, nao instala."
        exit 15
      }
      $codigo = Invoke-Logged 'test' 'npm' @('test')
      if ($codigo -ne 0) {
        Note "AVISO: npm test com falhas -- so informativo (baseline ja tem falhas pre-existentes conhecidas). Build continua."
      } else {
        Note "npm test ok"
      }

      $codigo = Invoke-Logged 'package:win' 'npm' @('run', 'package:win')
      $artefato = Join-Path $root 'dist\AgentCode-setup.exe'
      if ($codigo -ne 0 -or -not (Test-Path -LiteralPath $artefato -PathType Leaf)) {
        Note "ABORTADO: package:win falhou ou nao gerou dist\AgentCode-setup.exe."
        exit 16
      }

      $estado.shaEmpacotado = $shaAtual
      $estado.caminhoInstalador = $artefato
      $estado.empacotadoEm = (Get-Date).ToUniversalTime().ToString('o')
      Write-Json $statePath $estado
      Note "build ok: $artefato"
    }

    # ---- 7) instala, se autorizado -----------------------------------------
    if (-not $InstalarApp) {
      Note "InstalarApp=false -- sincronizado/buildado, mas nao mexo no app instalado. Fim."
      exit 0
    }

    if ($estado.shaEmpacotado -ne $shaAtual -or -not $estado.caminhoInstalador) {
      Note "nada para instalar agora (nenhum build pendente para $shaAtual). Fim."
      exit 0
    }

    if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
      Note "app nunca instalado nesta maquina -- instalando direto (sem guard, nao ha processo para fechar)."
      $proc = Start-Process -FilePath $estado.caminhoInstalador -ArgumentList '/S' -PassThru -Wait
      if ($proc.ExitCode -ne 0) {
        Note "ABORTADO: instalador saiu com codigo $($proc.ExitCode) na primeira instalacao."
        exit 17
      }
      Start-Process -FilePath $Exe | Out-Null
      $estado.shaInstalado = $shaAtual
      $estado.versaoInstalada = (Get-Item -LiteralPath $Exe).VersionInfo.ProductVersion
      $estado.instaladoEm = (Get-Date).ToUniversalTime().ToString('o')
      Write-Json $statePath $estado
      Note "primeira instalacao concluida."
      exit 0
    }

    $relaunch = Join-Path $root 'scripts\relaunch-agent-code.ps1'
    Note "chamando relaunch-agent-code.ps1 (fecha respeitando o guard, instala, reabre)"
    & powershell -NoProfile -ExecutionPolicy Bypass -File $relaunch `
      -Exe $Exe -InstallerPath $estado.caminhoInstalador -InstallerArgs '/S' -MaxGuardAge $MaxGuardAge
    $codigoRelaunch = $LASTEXITCODE
    Note "relaunch-agent-code.ps1 saiu com codigo $codigoRelaunch"

    switch ($codigoRelaunch) {
      0 {
        $estado.shaInstalado = $shaAtual
        $estado.versaoInstalada = (Get-Item -LiteralPath $Exe).VersionInfo.ProductVersion
        $estado.instaladoEm = (Get-Date).ToUniversalTime().ToString('o')
        Write-Json $statePath $estado
        Note "instalacao e reabertura concluidas. shaInstalado=$shaAtual"
      }
      2 { Note "guard ausente/velho -- nao instalei agora. Instalador fica pronto para a proxima execucao." }
      3 { Note "guard indica agente ocupado -- nao instalei agora. Instalador fica pronto para a proxima execucao." }
      default { Note "AVISO: relaunch-agent-code.ps1 falhou (codigo $codigoRelaunch). estado nao atualizado; proxima execucao tenta de novo." }
    }
  } finally {
    Pop-Location
  }
} finally {
  Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  Note "===== fim ====="
}
