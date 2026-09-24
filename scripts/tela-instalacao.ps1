# Tela de instalação mostrada enquanto relaunch-agent-code.ps1 fecha o app,
# roda o instalador silencioso e reabre. Sem ela, entre o app sumir e voltar
# não há nada na tela (no máximo um console) e parece que o app travou.
#
# Processo separado de propósito: o relaunch fica livre para esperar o
# instalador (Start-Process -Wait) sem congelar a janela. Os dois conversam
# por um arquivo JSON: o relaunch grava a etapa, esta tela lê a cada 300 ms.
#
#   { "etapa": "fechando" | "instalando" | "reabrindo" | "concluido" | "erro",
#     "detalhe": "texto opcional" }
#
# Fecha sozinha ~2 s depois de "concluido", 8 s depois de "erro", ou em 5 min
# se o relaunch morrer sem avisar.
param(
  [Parameter(Mandatory)] [string]$Arquivo
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$corFundo = [System.Drawing.Color]::FromArgb(0x1f, 0x1e, 0x1d)
$corTrilho = [System.Drawing.Color]::FromArgb(0x33, 0x32, 0x30)
$corTexto = [System.Drawing.Color]::FromArgb(0xec, 0xe9, 0xe4)
$corApagado = [System.Drawing.Color]::FromArgb(0x85, 0x82, 0x7d)
$corAcento = [System.Drawing.Color]::FromArgb(0xd9, 0x77, 0x57)
$corOk = [System.Drawing.Color]::FromArgb(0x6f, 0xbf, 0x73)
$corErro = [System.Drawing.Color]::FromArgb(0xe0, 0x5d, 0x5d)

$form = New-Object System.Windows.Forms.Form
$form.FormBorderStyle = 'None'
$form.StartPosition = 'CenterScreen'
$form.Size = New-Object System.Drawing.Size(460, 250)
$form.BackColor = $corFundo
$form.TopMost = $true
$form.ShowInTaskbar = $true
$form.Text = 'Atualizando o Agent Code'

# borda discreta
$form.Add_Paint({
  param($s, $e)
  $caneta = New-Object System.Drawing.Pen($corTrilho, 2)
  $e.Graphics.DrawRectangle($caneta, 1, 1, $s.Width - 2, $s.Height - 2)
  $caneta.Dispose()
})

$titulo = New-Object System.Windows.Forms.Label
$titulo.Text = 'Atualizando o Agent Code'
$titulo.Font = New-Object System.Drawing.Font('Segoe UI Semibold', 15)
$titulo.ForeColor = $corTexto
$titulo.AutoSize = $true
$titulo.Location = New-Object System.Drawing.Point(28, 24)
$form.Controls.Add($titulo)

$subtitulo = New-Object System.Windows.Forms.Label
$subtitulo.Text = 'Não feche esta janela — o app reabre sozinho em instantes.'
$subtitulo.Font = New-Object System.Drawing.Font('Segoe UI', 9)
$subtitulo.ForeColor = $corApagado
$subtitulo.AutoSize = $true
$subtitulo.Location = New-Object System.Drawing.Point(30, 58)
$form.Controls.Add($subtitulo)

# etapas
$nomes = [ordered]@{
  fechando   = 'Fechando o Agent Code'
  instalando = 'Instalando a versão nova'
  reabrindo  = 'Reabrindo o Agent Code'
}
$ordem = @($nomes.Keys)
$linhas = @{}
$y = 92
foreach ($chave in $ordem) {
  $marca = New-Object System.Windows.Forms.Label
  $marca.Font = New-Object System.Drawing.Font('Segoe UI Symbol', 11)
  $marca.AutoSize = $true
  $marca.Location = New-Object System.Drawing.Point(30, $y)
  $form.Controls.Add($marca)
  $texto = New-Object System.Windows.Forms.Label
  $texto.Text = $nomes[$chave]
  $texto.Font = New-Object System.Drawing.Font('Segoe UI', 10)
  $texto.AutoSize = $true
  $texto.Location = New-Object System.Drawing.Point(56, ($y + 1))
  $form.Controls.Add($texto)
  $linhas[$chave] = @{ marca = $marca; texto = $texto }
  $y += 28
}

# barra de progresso indeterminada, desenhada à mão (a ProgressBar do
# WinForms ignora a cor do tema)
$trilho = New-Object System.Windows.Forms.Panel
$trilho.BackColor = $corTrilho
$trilho.Location = New-Object System.Drawing.Point(30, 190)
$trilho.Size = New-Object System.Drawing.Size(400, 4)
$form.Controls.Add($trilho)
$bloco = New-Object System.Windows.Forms.Panel
$bloco.BackColor = $corAcento
$bloco.Size = New-Object System.Drawing.Size(110, 4)
$bloco.Location = New-Object System.Drawing.Point(-110, 0)
$trilho.Controls.Add($bloco)

$rodape = New-Object System.Windows.Forms.Label
$rodape.Font = New-Object System.Drawing.Font('Segoe UI', 8.5)
$rodape.ForeColor = $corApagado
$rodape.AutoSize = $true
$rodape.Location = New-Object System.Drawing.Point(30, 206)
$form.Controls.Add($rodape)

$estado = @{ etapa = 'fechando'; detalhe = ''; fimEm = $null; inicio = Get-Date; tique = 0 }

function Pintar {
  $atual = [array]::IndexOf($ordem, $estado.etapa)
  $concluido = $estado.etapa -eq 'concluido'
  $erro = $estado.etapa -eq 'erro'
  for ($i = 0; $i -lt $ordem.Count; $i++) {
    $l = $linhas[$ordem[$i]]
    if ($concluido -or ($atual -ge 0 -and $i -lt $atual)) {
      $l.marca.Text = [string][char]0x2714; $l.marca.ForeColor = $corOk; $l.texto.ForeColor = $corTexto
    } elseif ($i -eq $atual) {
      $l.marca.Text = [string][char]0x25CF; $l.marca.ForeColor = $corAcento; $l.texto.ForeColor = $corTexto
    } else {
      $l.marca.Text = [string][char]0x25CB; $l.marca.ForeColor = $corApagado; $l.texto.ForeColor = $corApagado
    }
  }
  if ($concluido) {
    $titulo.Text = 'Agent Code atualizado'
    $subtitulo.Text = 'Tudo pronto — abrindo a versão nova.'
    $bloco.BackColor = $corOk
  } elseif ($erro) {
    $titulo.Text = 'A atualização não terminou'
    $subtitulo.Text = 'O Agent Code foi reaberto na versão que já estava instalada.'
    $bloco.BackColor = $corErro
  }
  $segundos = [int]((Get-Date) - $estado.inicio).TotalSeconds
  $rodape.Text = if ($estado.detalhe) { "$($estado.detalhe)  ·  ${segundos}s" } else { "${segundos}s" }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 30
$timer.Add_Tick({
  # anima o bloco da barra
  if ($estado.etapa -eq 'concluido' -or $estado.etapa -eq 'erro') {
    $bloco.Left = 0; $bloco.Width = $trilho.Width
  } else {
    $x = $bloco.Left + 5
    if ($x -gt $trilho.Width) { $x = -$bloco.Width }
    $bloco.Left = $x
  }

  # a cada ~300 ms relê o arquivo de etapa
  $estado.tique++
  if ($estado.tique % 10 -eq 0) {
    try {
      if (Test-Path -LiteralPath $Arquivo) {
        $j = Get-Content -LiteralPath $Arquivo -Raw -Encoding utf8 | ConvertFrom-Json
        if ($j.etapa -and $j.etapa -ne $estado.etapa) {
          $estado.etapa = $j.etapa
          if ($j.etapa -eq 'concluido') { $estado.fimEm = (Get-Date).AddSeconds(2) }
          if ($j.etapa -eq 'erro') { $estado.fimEm = (Get-Date).AddSeconds(8) }
        }
        $estado.detalhe = [string]$j.detalhe
      }
    } catch { }
    Pintar
    $limite = $estado.inicio.AddMinutes(5)
    if (($estado.fimEm -and (Get-Date) -ge $estado.fimEm) -or (Get-Date) -ge $limite) {
      $timer.Stop()
      $form.Close()
    }
  }
})

$form.Add_Shown({ Pintar; $timer.Start() })
[void]$form.ShowDialog()
Remove-Item -LiteralPath $Arquivo -Force -ErrorAction SilentlyContinue
