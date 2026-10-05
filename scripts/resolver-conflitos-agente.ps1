# Resolve sozinho o conflito do rebase de 'minha-versao' sobre 'main'.
#
# Chamado pelo sincronizar-e-instalar-agent-code.ps1 (passo 4) quando o rebase
# normal para em conflito. Nunca mexe no clone principal enquanto trabalha:
#   0) lê a configuração da máquina ($StateDir\resolver-conflitos.json);
#   1) anti-repetição: o mesmo par (sha do original, sha da minha versão) que já
#      falhou com a mesma política não é tentado de novo (exit 2, "pulado");
#   2) numa worktree isolada ($StateDir\worktree-resolucao, branch temporário
#      auto-resolucao/<data>) tenta o barato: `git rebase -X renormalize`, que
#      some com os falsos conflitos de fim de linha (CRLF x LF);
#   3) se não bastar: `npm ci` e chama o Claude Code headless na worktree, com o
#      prompt de scripts\resolver-conflitos-prompt.md (git push bloqueado);
#   4) confere o resultado SEM confiar no agente: rebase concluído, HEAD em cima
#      do original, árvore limpa, nenhum marcador de conflito no diff, nenhum
#      commit próprio perdido (conforme a política), testes do original intactos
#      (checagens A e B, só com git) e `npm run typecheck` ok;
#   5) só então: tag backup/minha-versao-<data> no sha antigo e move o branch.
#
# Exit: 0 = resolvido (sem -NoApply o BranchRef já aponta para o resultado);
#       1 = desligado; 2 = pulado (mesmo par já falhou); 3 = falhou.
# Em qualquer saída diferente de 0 o BranchRef fica exatamente como estava.
# Relatório sempre em $StateDir\ultima-resolucao.json (a tela do app lê).
#
# Uso manual (dry-run, não mexe em branch nenhum; o branch temporário é apagado
# no fim, a não ser com -ManterBranch):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\resolver-conflitos-agente.ps1 -NoApply
#
# Só as checagens A/B (testes do original) contra um resultado já pronto, sem
# worktree, sem agente e sem gravar relatório (imprime o JSON; exit 0 ou 3):
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\resolver-conflitos-agente.ps1 `
#     -SomenteValidar -Resultado auto-resolucao/<data> -BranchRef backup/minha-versao-<data>
#
# [switch], não [bool]: parâmetros atravessam fronteira de processo.
param(
  [string]$RepoPath = (Split-Path -Parent $PSScriptRoot),
  [string]$BaseRef = 'main',
  [string]$BranchRef = 'minha-versao',
  # Dry-run: não cria tag nem move o BranchRef; o branch temporário é apagado no fim.
  [switch]$NoApply,
  # Com -NoApply: guarda o resultado no branch temporário auto-resolucao/<data>.
  [switch]$ManterBranch,
  # Roda só as checagens A/B contra -Resultado (ref ou sha) e sai.
  [switch]$SomenteValidar,
  [string]$Resultado = '',
  [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'AgentCodeAutoUpdate'),
  # Só para o teste automatizado: roda este .ps1 na worktree no lugar do Claude Code.
  [string]$AgenteDeTeste = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
# Saída do git (assuntos de commit com acento) chega em UTF-8.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false } catch { }

$RepoPath = (Resolve-Path -LiteralPath $RepoPath).Path
$logDir = Join-Path $StateDir 'logs'
$logPath = Join-Path $logDir 'resolver-conflitos.log'
$configPath = Join-Path $StateDir 'resolver-conflitos.json'
$relatorioPath = Join-Path $StateDir 'ultima-resolucao.json'
$wtPath = Join-Path $StateDir 'worktree-resolucao'
# Pasta que o agente pode escrever fora da worktree (só o arquivo de decisões).
$dirAgente = Join-Path $StateDir 'resolucao-agente'
$decisoesPath = Join-Path $dirAgente 'decisoes-agente.json'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$branchTemp = "auto-resolucao/$stamp"
$saidaAgentePath = Join-Path $logDir "resolver-conflitos-agente-$stamp.json"
$erroAgentePath = Join-Path $logDir "resolver-conflitos-agente-$stamp.err.txt"
$promptModelo = Join-Path $PSScriptRoot 'resolver-conflitos-prompt.md'
New-Item -ItemType Directory -Force -Path $StateDir, $logDir, $dirAgente | Out-Null

$utf8SemBom = New-Object System.Text.UTF8Encoding $false
$script:wtCriada = $false
$script:hashLockInstalado = $null

function Note([string]$message) {
  $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $message
  Add-Content -LiteralPath $logPath -Value $line -Encoding utf8
  Write-Host $line
}

function Write-JsonAtomico([string]$path, $object) {
  # .tmp + rename, UTF-8 sem BOM (o app lê com JSON.parse).
  $tmp = "$path.tmp"
  [IO.File]::WriteAllText($tmp, ($object | ConvertTo-Json -Depth 6), $utf8SemBom)
  Move-Item -LiteralPath $tmp -Destination $path -Force
}

function Read-JsonTolerante([string]$path) {
  # Tolera BOM, arquivo vazio e JSON quebrado (vira $null).
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
  try {
    $texto = [IO.File]::ReadAllText($path).TrimStart([char]0xFEFF)
    if (-not $texto.Trim()) { return $null }
    return ($texto | ConvertFrom-Json)
  } catch { return $null }
}

# Lê um campo de objeto vindo de JSON sem estourar no StrictMode.
function Prop($obj, [string]$nome, $padrao) {
  if ($null -eq $obj) { return $padrao }
  $p = $obj.PSObject.Properties[$nome]
  if ($null -eq $p -or $null -eq $p.Value) { return $padrao }
  return $p.Value
}

# git/npm escrevem saída normal no stderr; com EAP=Stop o PowerShell trata isso
# como erro e para o script. EAP vira Continue só durante a chamada e quem
# decide sucesso é $LASTEXITCODE (mesma regra do sincronizar).
function Invoke-Nativo([string]$prefixo, [string]$exe, [string[]]$argumentos, [switch]$Quieto, [int]$MaxLinhasLog = 0) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $saida = @(& $exe @argumentos 2>&1 | ForEach-Object { "$_" })
    $codigo = $LASTEXITCODE
  } finally { $ErrorActionPreference = $prev }
  if (-not $Quieto) {
    $logar = $saida
    if ($MaxLinhasLog -gt 0 -and $saida.Count -gt $MaxLinhasLog) {
      Note "$prefixo`: (... $($saida.Count - $MaxLinhasLog) linhas omitidas)"
      $logar = $saida[($saida.Count - $MaxLinhasLog)..($saida.Count - 1)]
    }
    foreach ($l in $logar) { Note "$prefixo`: $l" }
  }
  return [pscustomobject]@{ Codigo = $codigo; Saida = $saida }
}

function Invoke-Git([string[]]$argumentos, [switch]$Quieto) { return (Invoke-Nativo 'git' 'git' $argumentos -Quieto:$Quieto) }

# Primeira linha da saída de um git que deu certo, ou $null.
function GitValor([string[]]$argumentos) {
  $r = Invoke-Nativo 'git' 'git' $argumentos -Quieto
  if ($r.Codigo -ne 0 -or $r.Saida.Count -eq 0) { return $null }
  return $r.Saida[0].Trim()
}

function Remove-WorktreeResolucao {
  if (Test-Path -LiteralPath $wtPath) {
    [void](Invoke-Git @('-C', $wtPath, 'rebase', '--abort') -Quieto)
    [void](Invoke-Git @('-C', $RepoPath, 'worktree', 'remove', '--force', $wtPath) -Quieto)
    if (Test-Path -LiteralPath $wtPath) {
      # node_modules com caminho longo às vezes resiste ao git; rmdir resolve.
      [void](Invoke-Nativo 'rmdir' 'cmd.exe' @('/c', 'rmdir', '/s', '/q', $wtPath) -Quieto)
    }
  }
  [void](Invoke-Git @('-C', $RepoPath, 'worktree', 'prune') -Quieto)
}

$rel = [ordered]@{
  em = $null; resultado = 'falhou'; metodo = $null; politica = 'nunca-descartar'; motivo = ''
  shaBase = $null; shaAntes = $null; shaDepois = $null; tagBackup = $null; dryRun = [bool]$NoApply
  commitsDescartados = @(); arquivosResolvidos = @(); resumo = ''; log = $logPath
  branchTemporario = $null; saidaAgente = $null
  # Linhas do original removidas pelo resultado em código de produção (checagem
  # B): não recusam, só ficam visíveis para o usuário conferir.
  avisos = @()
  # true quando a falha é do resultado (agente chamado/validação recusou), não
  # de infraestrutura (npm ci, worktree, erro inesperado): só essa conta para
  # a anti-repetição.
  tentativaGasta = $false
}

function Finalizar([string]$resultado, [string]$motivo, [int]$codigo) {
  if ($script:wtCriada) {
    Remove-WorktreeResolucao
    if ($ManterBranch) { $rel.branchTemporario = $branchTemp }
    else { [void](Invoke-Git @('-C', $RepoPath, 'branch', '-D', $branchTemp) -Quieto) }
  }
  $rel.em = (Get-Date).ToUniversalTime().ToString('o')
  $rel.resultado = $resultado
  $rel.motivo = $motivo
  Write-JsonAtomico $relatorioPath $rel
  Note "resultado=$resultado (exit $codigo): $motivo"
  Note '===== fim ====='
  exit $codigo
}

function Install-Dependencias {
  # npm ci só quando o lock mudou desde a última instalação nesta execução.
  $lock = Join-Path $wtPath 'package-lock.json'
  if (-not (Test-Path -LiteralPath $lock -PathType Leaf)) { return $true }
  $hash = (Get-FileHash -LiteralPath $lock -Algorithm SHA256).Hash
  if ($hash -eq $script:hashLockInstalado) { return $true }
  Push-Location $wtPath
  try { $r = Invoke-Nativo 'npm ci' 'npm' @('ci', '--ignore-scripts', '--no-audit', '--no-fund') -MaxLinhasLog 40 }
  finally { Pop-Location }
  if ($r.Codigo -ne 0) { return $false }
  $script:hashLockInstalado = $hash
  return $true
}

function Find-Claude {
  $c = @(Get-Command claude -CommandType Application -ErrorAction SilentlyContinue |
    Sort-Object { if ($_.Source -like '*.exe') { 0 } else { 1 } })
  if ($c.Count -gt 0) { return $c[0].Source }
  foreach ($p in @((Join-Path $env:USERPROFILE '.local\bin\claude.exe'), 'C:\Users\Financeiro\.local\bin\claude.exe')) {
    if (Test-Path -LiteralPath $p -PathType Leaf) { return $p }
  }
  return $null
}

function Format-Arg([string]$a) {
  if ($a -eq '' -or $a -match '[\s"]') { return '"' + ($a -replace '"', '\"') + '"' }
  return $a
}

# Push impossível no processo do agente, sem gravar nada na config do
# repositório: GIT_CONFIG_COUNT/KEY_n/VALUE_n valem como `git -c` para todo git
# que ele (e os filhos dele) rodar. pushurl inválido nos remotes conhecidos e
# pushInsteadOf para push direto em URL. Soma às entradas que já existirem.
$script:destinoBloqueado = 'no-push://bloqueado'
function Set-BloqueioPush {
  $n = 0
  if ("$env:GIT_CONFIG_COUNT" -match '^\d+$') { $n = [int]$env:GIT_CONFIG_COUNT }
  $pares = @(
    @('remote.origin.pushurl', $script:destinoBloqueado),
    @('remote.upstream.pushurl', $script:destinoBloqueado)
  )
  foreach ($prefixo in @('https://', 'http://', 'ssh://', 'git://', 'git@')) {
    $pares += , @("url.$($script:destinoBloqueado)/.pushInsteadOf", $prefixo)
  }
  foreach ($p in $pares) {
    Set-Item -LiteralPath "env:GIT_CONFIG_KEY_$n" -Value $p[0]
    Set-Item -LiteralPath "env:GIT_CONFIG_VALUE_$n" -Value $p[1]
    $n++
  }
  $env:GIT_CONFIG_COUNT = "$n"
  Note "push bloqueado no processo do agente (GIT_CONFIG_COUNT=$n)"
}

function Clear-BloqueioPush([string]$countAntes) {
  $inicio = 0
  if ($countAntes -match '^\d+$') { $inicio = [int]$countAntes }
  $fim = 0
  if ("$env:GIT_CONFIG_COUNT" -match '^\d+$') { $fim = [int]$env:GIT_CONFIG_COUNT }
  for ($i = $inicio; $i -lt $fim; $i++) {
    Remove-Item -LiteralPath "env:GIT_CONFIG_KEY_$i", "env:GIT_CONFIG_VALUE_$i" -ErrorAction SilentlyContinue
  }
  if ($countAntes) { $env:GIT_CONFIG_COUNT = $countAntes } else { Remove-Item -LiteralPath 'env:GIT_CONFIG_COUNT' -ErrorAction SilentlyContinue }
}

# Roda o agente com o prompt pelo stdin (sem limite de linha de comando) e
# mata o processo E a árvore se passar do tempo.
function Invoke-Agente([string]$exe, [string[]]$argumentos, [string]$entrada, [double]$minutos) {
  $linha = ($argumentos | ForEach-Object { Format-Arg $_ }) -join ' '
  Note "agente: $exe $linha (timeout $minutos min)"
  $p = Start-Process -FilePath $exe -ArgumentList $linha -WorkingDirectory $wtPath -NoNewWindow -PassThru `
    -RedirectStandardInput $entrada -RedirectStandardOutput $saidaAgentePath -RedirectStandardError $erroAgentePath
  $null = $p.Handle  # sem isso o ExitCode volta vazio no PowerShell 5.1
  if (-not $p.WaitForExit([int]($minutos * 60000))) {
    Note "agente passou de $minutos min -- matando o processo e a arvore"
    [void](Invoke-Nativo 'taskkill' 'taskkill.exe' @('/PID', "$($p.Id)", '/T', '/F'))
    return [pscustomobject]@{ Codigo = -1; Estourou = $true }
  }
  $p.WaitForExit()
  return [pscustomobject]@{ Codigo = $p.ExitCode; Estourou = $false }
}

# Linhas acrescentadas no diff com marcador de conflito. '=======' sozinho
# existe legitimamente em markdown/texto, então lá só vale <<<<<<< e >>>>>>>.
function Find-Marcadores([string]$de) {
  $r = Invoke-Git @('-C', $wtPath, '-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', "$de..HEAD") -Quieto
  $achados = New-Object System.Collections.Generic.List[string]
  $arquivo = ''; $noCabecalho = $true
  foreach ($linha in $r.Saida) {
    if ($linha.StartsWith('diff --git ')) { $noCabecalho = $true; continue }
    if ($noCabecalho) {
      if ($linha.StartsWith('+++ ')) { $arquivo = $linha.Substring(4) -replace '^b/', '' }
      elseif ($linha.StartsWith('@@')) { $noCabecalho = $false }
      continue
    }
    if (-not $linha.StartsWith('+')) { continue }
    $c = $linha.Substring(1).TrimEnd("`r")
    $ehTexto = $arquivo -match '\.(md|mdx|markdown|txt|rst|adoc)$'
    if ($c -match '^(<<<<<<<|>>>>>>>)( |$)' -or (-not $ehTexto -and $c -eq '=======')) { $achados.Add("${arquivo}: $c") }
  }
  return , $achados.ToArray()
}

# Commits da minha versão que não estão no original (git cherry "+") e que
# sumiram do resultado: nem equivalente por patch, nem mesmo assunto, nem
# mudanças já presentes no HEAD (patch reverso aplica = conteúdo absorvido).
function Get-Descartados([string]$shaDepois, $decisoes) {
  $candidatos = @((Invoke-Git @('-C', $wtPath, 'cherry', $shaBase, $shaAntes) -Quieto).Saida |
    Where-Object { $_ -like '+ *' } | ForEach-Object { $_.Substring(2).Trim() })
  $sinal = @{}
  foreach ($l in (Invoke-Git @('-C', $wtPath, 'cherry', $shaDepois, $shaAntes) -Quieto).Saida) {
    if ($l -match '^([+-]) ([0-9a-f]+)') { $sinal[$Matches[2]] = $Matches[1] }
  }
  $assuntos = @{}
  foreach ($s in (Invoke-Git @('-C', $wtPath, 'log', '--format=%s', "$shaBase..$shaDepois") -Quieto).Saida) { $assuntos[$s] = $true }
  $infoAgente = @(Prop $decisoes 'descartados' @())
  $patch = Join-Path $dirAgente "patch-$stamp.diff"
  $lista = @()
  foreach ($sha in $candidatos) {
    if ($sinal.ContainsKey($sha) -and $sinal[$sha] -eq '-') { continue }
    $titulo = GitValor @('-C', $wtPath, 'log', '-1', '--format=%s', $sha)
    if ($titulo -and $assuntos.ContainsKey($titulo)) { continue }
    $r = Invoke-Git @('-C', $wtPath, 'diff', '--binary', "--output=$patch", "$sha^", $sha) -Quieto
    if ($r.Codigo -eq 0 -and (Get-Item -LiteralPath $patch).Length -gt 0) {
      $r = Invoke-Git @('-C', $wtPath, 'apply', '--check', '-R', '--ignore-whitespace', $patch) -Quieto
      if ($r.Codigo -eq 0) { Note "commit $($sha.Substring(0,7)) '$titulo' sumiu como commit, mas o conteudo ja esta no resultado"; continue }
    }
    $motivo = 'sem motivo informado pelo agente'
    foreach ($d in $infoAgente) {
      $dSha = [string](Prop $d 'sha' ''); $dTit = [string](Prop $d 'titulo' '')
      if (($dSha.Length -ge 7 -and $sha.StartsWith($dSha)) -or ($dTit -and $dTit -eq $titulo)) { $motivo = [string](Prop $d 'motivo' $motivo); break }
    }
    $lista += [ordered]@{ sha = $sha; titulo = $titulo; motivo = $motivo }
  }
  Remove-Item -LiteralPath $patch -Force -ErrorAction SilentlyContinue
  return , $lista
}

# ---- checagens A e B: testes do original intactos (só git) -------------
# Caso real que motivou: o agente trocou o RightPaneTabs.test.tsx do original
# pelo da minha versão; typecheck e marcadores não pegam isso.
$script:reArquivoTeste = '\.(test|spec)\.[^/\\]+$'
# it( / test( / describe( (também .only/.skip/.todo/.concurrent/.each(...)) e o
# 1º argumento quando é string com aspas simples, duplas ou crase.
$script:reTitulo = '(?<![\w.$])(?:it|test|describe)(?:\.(?:only|skip|todo|concurrent|each\s*\([^)]*\)))*\s*\(\s*(?:''((?:\\.|[^''\\])*)''|"((?:\\.|[^"\\])*)"|`((?:\\.|[^`\\])*)`)'

function Get-ConteudoNoCommit([string]$dir, [string]$sha, [string]$caminho) {
  $r = Invoke-Git @('-C', $dir, 'show', "${sha}:$caminho") -Quieto
  if ($r.Codigo -ne 0) { return $null }
  return ($r.Saida -join "`n")
}

function Get-Titulos([string]$texto) {
  $t = New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($m in [regex]::Matches("$texto", $script:reTitulo)) {
    foreach ($g in 1..3) { if ($m.Groups[$g].Success) { [void]$t.Add($m.Groups[$g].Value); break } }
  }
  return , $t
}

# Conteúdo comparável de uma linha: sem espaços nas pontas; linha vazia ou só
# de chaves/parênteses/pontuação não conta.
function Format-LinhaComparavel([string]$linha) {
  $t = $linha.Trim()
  if ($t -match '^[{}()\[\];,]*$') { return $null }
  return $t
}

# Linhas '+' (pelo caminho do lado novo) e '-' (pelo caminho do lado antigo) de
# um diff, contadas por conteúdo: @{ arquivo = Dictionary[conteúdo, vezes] }.
function Get-LinhasDiff([string]$dir, [string]$de, [string]$ate) {
  $r = Invoke-Git @('-C', $dir, '-c', 'core.quotepath=off', 'diff', '--no-color', '--no-ext-diff', '--no-renames', '-U0', "$de..$ate") -Quieto
  $mais = @{}; $menos = @{}
  $velho = ''; $novo = ''; $noCabecalho = $true
  foreach ($linha in $r.Saida) {
    if ($linha.StartsWith('diff --git ')) { $noCabecalho = $true; continue }
    if ($noCabecalho) {
      if ($linha.StartsWith('--- ')) { $velho = ($linha.Substring(4) -replace '^a/', '').TrimEnd("`t") }
      elseif ($linha.StartsWith('+++ ')) { $novo = ($linha.Substring(4) -replace '^b/', '').TrimEnd("`t") }
      elseif ($linha.StartsWith('@@')) { $noCabecalho = $false }
      continue
    }
    if ($linha.StartsWith('@@')) { continue }
    if ($linha.StartsWith('+')) { $alvo = $mais; $arq = $novo }
    elseif ($linha.StartsWith('-')) { $alvo = $menos; $arq = $velho }
    else { continue }
    $c = Format-LinhaComparavel $linha.Substring(1)
    if ($null -eq $c) { continue }
    if (-not $alvo.ContainsKey($arq)) { $alvo[$arq] = New-Object 'System.Collections.Generic.Dictionary[string,int]' }
    $d = $alvo[$arq]
    if ($d.ContainsKey($c)) { $d[$c]++ } else { $d[$c] = 1 }
  }
  return [pscustomobject]@{ Mais = $mais; Menos = $menos }
}

function Format-Lista([string[]]$itens, [int]$max) {
  $texto = ($itens | Select-Object -First $max) -join '; '
  if ($itens.Count -gt $max) { $texto += " (e mais $($itens.Count - $max))" }
  return $texto
}

# (A) título de it/test/describe que existe no original e sumiu do resultado;
# (B) linha que o original acrescentou desde o ponto em que a minha versão saiu
#     dele (merge-base) e que o resultado removeu: em teste recusa, em produção
#     só vira aviso. Exceção da A: título que a própria minha versão já tinha
#     tirado (existia no merge-base e não existe no sha antigo) não conta.
# Devolve Falha ($null ou motivo) e Avisos.
function Test-TestesDoOriginal([string]$dir, [string]$base, [string]$antes, [string]$resultado) {
  $falhas = @(); $avisos = @()
  $mb = GitValor @('-C', $dir, 'merge-base', $base, $antes)
  $arquivosTeste = @((Invoke-Git @('-C', $dir, '-c', 'core.quotepath=off', 'diff', '--name-only', '--no-renames', "$base..$resultado") -Quieto).Saida |
    Where-Object { $_ -match $script:reArquivoTeste })

  $sumidos = @()
  foreach ($arq in $arquivosTeste) {
    $txtBase = Get-ConteudoNoCommit $dir $base $arq
    if ($null -eq $txtBase) { continue }  # arquivo de teste novo da minha versão
    $tBase = Get-Titulos $txtBase
    if ($tBase.Count -eq 0) { continue }
    $tRes = Get-Titulos (Get-ConteudoNoCommit $dir $resultado $arq)
    $tMb = $null; $tAntes = $null
    if ($mb) { $tMb = Get-Titulos (Get-ConteudoNoCommit $dir $mb $arq); $tAntes = Get-Titulos (Get-ConteudoNoCommit $dir $antes $arq) }
    foreach ($t in $tBase) {
      if ($tRes.Contains($t)) { continue }
      if ($null -ne $tMb -and $tMb.Contains($t) -and -not $tAntes.Contains($t)) {
        Note "checagem A: '$t' em $arq foi tirado pela propria minha versao -- nao conta"
        continue
      }
      $sumidos += "${arq}: `"$t`""
    }
  }
  foreach ($s in $sumidos) { Note "checagem A: teste do original sumiu -- $s" }
  if ($sumidos.Count -gt 0) {
    $falhas += "O resultado tirou $($sumidos.Count) teste(s) do original: $(Format-Lista $sumidos 3)."
  }

  if ($mb) {
    $doOriginal = (Get-LinhasDiff $dir $mb $base).Mais
    $doResultado = Get-LinhasDiff $dir $base $resultado
    $emTeste = @()
    foreach ($arq in @($doResultado.Menos.Keys | Sort-Object)) {
      if (-not $doOriginal.ContainsKey($arq)) { continue }
      $acrescentadas = $doOriginal[$arq]
      $removidas = $doResultado.Menos[$arq]
      $readicionadas = $null
      if ($doResultado.Mais.ContainsKey($arq)) { $readicionadas = $doResultado.Mais[$arq] }
      $n = 0; $exemplos = @()
      foreach ($c in @($removidas.Keys)) {
        if (-not $acrescentadas.ContainsKey($c)) { continue }
        # Removida aqui e acrescentada igual em outro ponto do mesmo arquivo = mudou de lugar.
        $liquido = $removidas[$c]
        if ($null -ne $readicionadas -and $readicionadas.ContainsKey($c)) { $liquido -= $readicionadas[$c] }
        if ($liquido -le 0) { continue }
        $n += [Math]::Min($liquido, $acrescentadas[$c])
        if ($exemplos.Count -lt 2) { $exemplos += "``$($c.Substring(0, [Math]::Min(100, $c.Length)))``" }
      }
      if ($n -eq 0) { continue }
      $txt = "${arq}: $n linha(s) que o original acrescentou foram removidas no resultado (ex.: $($exemplos -join ', '))"
      Note "checagem B: $txt"
      if ($arq -match $script:reArquivoTeste) { $emTeste += $txt } else { $avisos += $txt }
    }
    if ($emTeste.Count -gt 0) {
      $falhas += "O resultado apagou linhas de teste que o original acrescentou: $(Format-Lista $emTeste 3)."
    }
  } else { Note 'checagem B: sem merge-base entre original e minha versao -- nao se aplica' }

  $falha = $null
  if ($falhas.Count -gt 0) { $falha = $falhas -join ' ' }
  return [pscustomobject]@{ Falha = $falha; Avisos = $avisos }
}

# Validação feita pelo script. Devolve $null se o resultado presta, ou o motivo.
function Test-Resultado($decisoes) {
  foreach ($n in @('rebase-merge', 'rebase-apply')) {
    $p = GitValor @('-C', $wtPath, 'rev-parse', '--git-path', $n)
    if ($p -and -not [IO.Path]::IsPathRooted($p)) { $p = Join-Path $wtPath $p }
    if ($p -and (Test-Path -LiteralPath $p)) { return 'O rebase ficou pela metade (ainda em andamento).' }
  }
  $shaDepois = GitValor @('-C', $wtPath, 'rev-parse', 'HEAD')
  $rel.shaDepois = $shaDepois
  if ((Invoke-Git @('-C', $wtPath, 'merge-base', '--is-ancestor', $shaBase, 'HEAD') -Quieto).Codigo -ne 0) {
    return 'O resultado não ficou em cima do original (rebase não concluído).'
  }
  $sujo = @((Invoke-Git @('-C', $wtPath, 'status', '--porcelain') -Quieto).Saida | Where-Object { $_ })
  if ($sujo.Count -gt 0) { Note "arvore suja: $($sujo -join ' | ')"; return 'Sobraram alterações não commitadas na cópia de trabalho.' }
  $marcadores = Find-Marcadores $shaBase
  if ($marcadores.Count -gt 0) {
    $marcadores | Select-Object -First 20 | ForEach-Object { Note "marcador: $_" }
    return "Sobrou marcador de conflito em $($marcadores.Count) linha(s) (ex.: $($marcadores[0]))."
  }
  $descartados = Get-Descartados $shaDepois $decisoes
  $rel.commitsDescartados = $descartados
  foreach ($d in $descartados) { Note "descartado: $($d.sha.Substring(0,7)) '$($d.titulo)' -- $($d.motivo)" }
  if ($descartados.Count -gt 0 -and $politica -eq 'nunca-descartar') {
    return "O resultado tirou $($descartados.Count) commit(s) da minha versão e a política é nunca descartar."
  }
  $chk = Test-TestesDoOriginal $wtPath $shaBase $shaAntes $shaDepois
  $rel.avisos = @($chk.Avisos)
  if ($chk.Falha) { return $chk.Falha }
  if (Test-Path -LiteralPath (Join-Path $wtPath 'package.json') -PathType Leaf) {
    if (-not (Install-Dependencias)) { return 'npm ci falhou na cópia de trabalho; não deu para conferir o typecheck.' }
    Push-Location $wtPath
    try { $r = Invoke-Nativo 'typecheck' 'npm' @('run', 'typecheck') -MaxLinhasLog 60 } finally { Pop-Location }
    if ($r.Codigo -ne 0) { return 'O typecheck falhou depois da resolução.' }
  } else { Note 'sem package.json na raiz -- typecheck nao se aplica' }
  return $null
}

# ======================================================================
if ((Test-Path -LiteralPath $logPath) -and (Get-Item -LiteralPath $logPath).Length -gt 2MB) {
  Move-Item -LiteralPath $logPath -Destination "$logPath.old" -Force
}
Get-ChildItem -LiteralPath $logDir -Filter 'resolver-conflitos-agente-*' -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 | Remove-Item -Force -ErrorAction SilentlyContinue
Note "===== inicio (RepoPath=$RepoPath BaseRef=$BaseRef BranchRef=$BranchRef NoApply=$NoApply) ====="

try {
  # ---- só as checagens A/B contra um resultado pronto (-SomenteValidar) --
  # Não cria worktree, não chama agente, não grava o relatório nem mexe na
  # anti-repetição: imprime o JSON e sai (0 = passou, 3 = recusado).
  if ($SomenteValidar) {
    $shaBase = GitValor @('-C', $RepoPath, 'rev-parse', '--verify', "$BaseRef^{commit}")
    $shaAntes = GitValor @('-C', $RepoPath, 'rev-parse', '--verify', "$BranchRef^{commit}")
    $shaRes = $null
    if ($Resultado) { $shaRes = GitValor @('-C', $RepoPath, 'rev-parse', '--verify', "$Resultado^{commit}") }
    if (-not $shaBase -or -not $shaAntes -or -not $shaRes) {
      Note "SomenteValidar: nao encontrei '$BaseRef', '$BranchRef' ou -Resultado '$Resultado'"
      exit 3
    }
    Note "SomenteValidar: base=$shaBase antes=$shaAntes resultado=$shaRes"
    $chk = Test-TestesDoOriginal $RepoPath $shaBase $shaAntes $shaRes
    $saida = [ordered]@{
      resultado = $(if ($chk.Falha) { 'falhou' } else { 'aprovado' }); motivo = "$($chk.Falha)"
      avisos = @($chk.Avisos); shaBase = $shaBase; shaAntes = $shaAntes; shaDepois = $shaRes
    }
    Write-Output ($saida | ConvertTo-Json -Depth 4)
    Note "SomenteValidar: $($saida.resultado) $($saida.motivo)"
    if ($chk.Falha) { exit 3 } else { exit 0 }
  }

  # ---- 0) configuração da máquina (a tela grava; defaults se faltar) -----
  $cfg = Read-JsonTolerante $configPath
  $ativo = ("$(Prop $cfg 'ativo' $true)").ToLower() -ne 'false'
  $politica = [string](Prop $cfg 'politicaCommitSuperado' 'nunca-descartar')
  if ($politica -notin @('nunca-descartar', 'descartar-e-avisar')) {
    Note "AVISO: politica desconhecida '$politica' -- usando nunca-descartar"
    $politica = 'nunca-descartar'
  }
  $modelo = [string](Prop $cfg 'modelo' '')
  $timeoutMin = 40.0
  try { $timeoutMin = [double](Prop $cfg 'timeoutMinutos' 40) } catch { }
  if ($timeoutMin -le 0) { $timeoutMin = 40.0 }
  $rel.politica = $politica
  Note "config: ativo=$ativo politica=$politica modelo='$modelo' timeoutMinutos=$timeoutMin"
  if (-not $ativo) { Finalizar 'desligado' 'A resolução automática de conflitos está desligada nas configurações.' 1 }

  $shaBase = GitValor @('-C', $RepoPath, 'rev-parse', '--verify', "$BaseRef^{commit}")
  $shaAntes = GitValor @('-C', $RepoPath, 'rev-parse', '--verify', "$BranchRef^{commit}")
  $rel.shaBase = $shaBase; $rel.shaAntes = $shaAntes
  if (-not $shaBase -or -not $shaAntes) { Finalizar 'falhou' "Não encontrei '$BaseRef' ou '$BranchRef' no repositório." 3 }
  $refBranch = GitValor @('-C', $RepoPath, 'rev-parse', '--symbolic-full-name', $BranchRef)
  $refBase = GitValor @('-C', $RepoPath, 'rev-parse', '--symbolic-full-name', $BaseRef)
  if (-not $NoApply -and "$refBranch" -notlike 'refs/heads/*') {
    Finalizar 'falhou' "'$BranchRef' não é um branch local; só dá para aplicar em branch (use -NoApply para testar)." 3
  }
  Note "base=$shaBase ($refBase) branch=$shaAntes ($refBranch)"

  # ---- 1) anti-repetição: mesmo par + mesma política que já falhou ------
  $anterior = Read-JsonTolerante $relatorioPath
  if ($anterior -and (Prop $anterior 'resultado' '') -in @('falhou', 'pulado') -and
      ("$(Prop $anterior 'tentativaGasta' $true)").ToLower() -ne 'false' -and
      (Prop $anterior 'shaBase' '') -eq $shaBase -and (Prop $anterior 'shaAntes' '') -eq $shaAntes -and
      (Prop $anterior 'politica' '') -eq $politica) {
    Note 'anti-repeticao: este par (original, minha versao) ja falhou com a mesma politica -- nao chamo o agente de novo'
    $rel.commitsDescartados = @(Prop $anterior 'commitsDescartados' @())
    $rel.arquivosResolvidos = @(Prop $anterior 'arquivosResolvidos' @())
    $rel.resumo = [string](Prop $anterior 'resumo' '')
    $rel.saidaAgente = Prop $anterior 'saidaAgente' $null
    $rel.tentativaGasta = $true
    $motivoAnterior = [string](Prop $anterior 'motivo' '')
    if ((Prop $anterior 'resultado' '') -eq 'pulado') { $motivo = $motivoAnterior }
    else { $motivo = "Já tentei este mesmo par e falhou; só tento de novo quando o original, a minha versão ou a política mudarem. Falha anterior: $motivoAnterior" }
    Finalizar 'pulado' $motivo 2
  }

  # ---- 2/3) worktree isolada + tentativa barata (renormalize) ------------
  Remove-WorktreeResolucao
  $r = Invoke-Git @('-C', $RepoPath, 'worktree', 'add', '-b', $branchTemp, $wtPath, $shaAntes)
  if ($r.Codigo -ne 0) { Finalizar 'falhou' 'Não consegui criar a cópia isolada (worktree) para resolver.' 3 }
  $script:wtCriada = $true
  $env:GIT_EDITOR = 'true'
  $env:GIT_TERMINAL_PROMPT = '0'

  $decisoes = $null
  $r = Invoke-Git @('-C', $wtPath, 'rebase', '-X', 'renormalize', $shaBase)
  if ($r.Codigo -eq 0) {
    $rel.metodo = 'renormalize'
    Note 'rebase -X renormalize passou sozinho (conflito era so de fim de linha)'
  } else {
    Note 'renormalize nao bastou -- desfazendo e chamando o agente'
    [void](Invoke-Git @('-C', $wtPath, 'rebase', '--abort'))
    $rel.metodo = 'agente'

    # ---- 4) dependências para o typecheck do agente ----------------------
    if (-not (Install-Dependencias)) { Finalizar 'falhou' 'npm ci falhou na cópia de trabalho; o agente não foi chamado.' 3 }

    # ---- 5) agente ------------------------------------------------------
    Remove-Item -LiteralPath $decisoesPath -Force -ErrorAction SilentlyContinue
    if ($politica -eq 'descartar-e-avisar') {
      $regra = "Você PODE usar ``git rebase --skip`` SOMENTE quando o commit da versão do usuário foi superado por algo que o original ($BaseRef) já implementa (a mesma funcionalidade reimplementada lá). Para cada commit pulado, registre sha, título e o motivo em ``descartados``. Em qualquer outro caso, resolva o conflito."
    } else {
      $regra = "É PROIBIDO usar ``git rebase --skip`` ou deixar qualquer commit da versão do usuário de fora. Se um commit estiver superado pelo original (sinais acima) ou não puder ser reaplicado mantendo a intenção dele, rode ``git rebase --abort`` e explique no resumo qual commit e por quê."
    }
    $prompt = [IO.File]::ReadAllText($promptModelo).TrimStart([char]0xFEFF)
    $prompt = $prompt.Replace('{{BASE_REF}}', $BaseRef).Replace('{{BASE_SHA}}', $shaBase).Replace('{{BRANCH_REF}}', $BranchRef).
      Replace('{{BRANCH_SHA}}', $shaAntes).Replace('{{POLITICA}}', $politica).Replace('{{REGRA_DESCARTE}}', $regra).
      Replace('{{ARQUIVO_DECISOES}}', $decisoesPath)
    $promptPath = Join-Path $dirAgente "prompt-$stamp.md"
    [IO.File]::WriteAllText($promptPath, $prompt, $utf8SemBom)

    if ($AgenteDeTeste) {
      $exe = (Get-Command powershell.exe).Source
      $argsAgente = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $AgenteDeTeste)
      $env:RESOLVER_BASE_SHA = $shaBase
      $env:RESOLVER_DECISOES = $decisoesPath
    } else {
      $exe = Find-Claude
      if (-not $exe) { Finalizar 'falhou' 'Não encontrei o Claude Code (claude) nesta máquina.' 3 }
      $argsAgente = @('-p', '--output-format', 'json', '--permission-mode', 'acceptEdits',
        '--setting-sources', 'project', '--strict-mcp-config', '--no-session-persistence',
        '--add-dir', $dirAgente,
        '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(git:*)', 'Bash(npm:*)', 'Bash(npx:*)',
        '--disallowedTools', 'Bash(git push:*)', 'Bash(git tag:*)', 'Bash(git branch:*)', 'Bash(git update-ref:*)',
        'Bash(git worktree:*)', 'Bash(git config:*)')
      if ($modelo) { $argsAgente += @('--model', $modelo) }
    }
    # Quando o app dispara o sincronizar, herdamos variáveis da sessão dele;
    # o Claude Code filho não pode achar que roda dentro de outra sessão.
    foreach ($v in @('CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT')) { Remove-Item "env:$v" -ErrorAction SilentlyContinue }

    $refsAntes = @{}
    foreach ($ref in @($refBase, $refBranch)) { if ($ref) { $refsAntes[$ref] = GitValor @('-C', $RepoPath, 'rev-parse', $ref) } }
    $inicio = Get-Date
    $rel.tentativaGasta = $true
    $countAntes = $env:GIT_CONFIG_COUNT
    Set-BloqueioPush
    try { $exec = Invoke-Agente $exe $argsAgente $promptPath $timeoutMin }
    finally { Clear-BloqueioPush $countAntes }
    $rel.saidaAgente = $saidaAgentePath
    Note ("agente terminou: codigo={0} em {1:N1} min" -f $exec.Codigo, ((Get-Date) - $inicio).TotalMinutes)

    $json = Read-JsonTolerante $saidaAgentePath
    if ($json) {
      Note ("agente: subtype={0} is_error={1} turnos={2} custo_usd={3}" -f (Prop $json 'subtype' '?'), (Prop $json 'is_error' '?'), (Prop $json 'num_turns' '?'), (Prop $json 'total_cost_usd' '?'))
    }
    $textoAgente = [string](Prop $json 'result' '')
    if (-not $textoAgente -and (Test-Path -LiteralPath $saidaAgentePath)) { $textoAgente = [IO.File]::ReadAllText($saidaAgentePath) }
    if ($textoAgente) { Note "agente disse: $($textoAgente.Substring(0, [Math]::Min(3000, $textoAgente.Length)))" }

    $decisoes = Read-JsonTolerante $decisoesPath
    $rel.resumo = [string](Prop $decisoes 'resumo' $textoAgente.Substring(0, [Math]::Min(2000, $textoAgente.Length)))
    $rel.arquivosResolvidos = @(@(Prop $decisoes 'arquivos' @()) | ForEach-Object { [string]$_ })

    # O agente trabalha numa worktree, mas os refs são do repositório todo:
    # se algum branch/base mexeu, desfaz e recusa.
    foreach ($ref in @($refsAntes.Keys)) {
      $agora = GitValor @('-C', $RepoPath, 'rev-parse', $ref)
      if ($agora -ne $refsAntes[$ref]) {
        Note "ALERTA: $ref mudou durante o agente ($($refsAntes[$ref]) -> $agora) -- restaurando"
        [void](Invoke-Git @('-C', $RepoPath, 'update-ref', $ref, $refsAntes[$ref]))
        Finalizar 'falhou' "O agente mexeu em $ref fora da cópia isolada; resultado descartado." 3
      }
    }
    if ($exec.Estourou) { Finalizar 'falhou' "O agente passou do limite de $timeoutMin minutos." 3 }
    if ((GitValor @('-C', $wtPath, 'rev-parse', 'HEAD')) -eq $shaAntes -and $shaAntes -ne $shaBase) {
      Finalizar 'falhou' 'O agente não concluiu o rebase (desistiu ou abortou); veja o resumo.' 3
    }
  }

  # ---- 6) validação pelo script ----------------------------------------
  $falha = Test-Resultado $decisoes
  if ($falha) {
    # npm ci que falha é infraestrutura (rede); o resto é o resultado que não presta.
    if ($falha -notlike 'npm ci*') { $rel.tentativaGasta = $true }
    Finalizar 'falhou' $falha 3
  }
  $shaDepois = $rel.shaDepois
  Note "validacao ok: resultado $shaDepois"
  $n = @($rel.commitsDescartados).Count
  if ($rel.metodo -eq 'renormalize') { $motivo = 'O conflito era só de fim de linha (CRLF x LF); resolvido sem chamar o agente.' }
  else { $motivo = 'Conflitos resolvidos pelo agente e conferidos (sem marcadores, typecheck ok).' }
  if ($n -gt 0) { $motivo += " $n commit(s) da minha versão foram descartados por já estarem cobertos pelo original; confira a lista." }

  # ---- 7) aplica (ou deixa no branch temporário, em -NoApply) -----------
  if ($NoApply) {
    Remove-WorktreeResolucao
    $script:wtCriada = $false
    if ($ManterBranch) {
      [void](Invoke-Git @('-C', $RepoPath, 'branch', '-f', $branchTemp, $shaDepois))
      $rel.branchTemporario = $branchTemp
      Finalizar 'resolvido' "$motivo Modo de teste: nada foi aplicado; o resultado ficou no branch $branchTemp." 0
    }
    # Sem -ManterBranch o branch de teste não fica acumulando no repositório;
    # o commit continua acessível pelo sha (shaDepois) até o git limpar.
    [void](Invoke-Git @('-C', $RepoPath, 'branch', '-D', $branchTemp) -Quieto)
    Finalizar 'resolvido' "$motivo Modo de teste: nada foi aplicado e o branch temporário foi apagado (resultado no commit $($shaDepois.Substring(0, 9)); use -ManterBranch para guardar o branch)." 0
  }

  $tag = 'backup/minha-versao-' + (Get-Date -Format 'yyyyMMdd-HHmm')
  if (GitValor @('-C', $RepoPath, 'rev-parse', '--verify', '-q', "refs/tags/$tag")) { $tag += (Get-Date -Format 'ss') }
  if ((Invoke-Git @('-C', $RepoPath, 'tag', $tag, $shaAntes)).Codigo -ne 0) { Finalizar 'falhou' "Não consegui criar a tag de backup $tag; nada foi aplicado." 3 }
  $rel.tagBackup = $tag
  Note "tag de backup: $tag -> $shaAntes"

  $headRef = GitValor @('-C', $RepoPath, 'symbolic-ref', '-q', 'HEAD')
  if ($headRef -eq $refBranch) {
    # Clone com o branch em checkout (caso do auto-update): reset --keep só
    # anda se não houver alteração local que se perderia.
    $headSha = GitValor @('-C', $RepoPath, 'rev-parse', 'HEAD')
    $sujo = @((Invoke-Git @('-C', $RepoPath, 'status', '--porcelain') -Quieto).Saida | Where-Object { $_ })
    if ($headSha -ne $shaAntes -or $sujo.Count -gt 0) { $codigo = 1; Note 'clone principal mudou ou esta sujo -- nao aplico' }
    else { $codigo = (Invoke-Git @('-C', $RepoPath, 'reset', '--keep', $shaDepois)).Codigo }
  } else {
    # update-ref com valor antigo = troca atômica: só move se ninguém mexeu.
    $codigo = (Invoke-Git @('-C', $RepoPath, 'update-ref', $refBranch, $shaDepois, $shaAntes)).Codigo
  }
  if ($codigo -ne 0) {
    [void](Invoke-Git @('-C', $RepoPath, 'tag', '-d', $tag))
    $rel.tagBackup = $null
    Finalizar 'falhou' "Resolvi, mas não consegui mover '$BranchRef' para o resultado; nada foi aplicado." 3
  }
  Note "$BranchRef agora em $shaDepois (antes $shaAntes)"
  Finalizar 'resolvido' $motivo 0
} catch {
  Note "ERRO inesperado: $($_.Exception.Message) @ $($_.InvocationInfo.PositionMessage)"
  Finalizar 'falhou' "Erro inesperado no resolvedor: $($_.Exception.Message)" 3
}
