# Testes rápidos do scripts\resolver-conflitos-agente.ps1, sem chamar o Claude
# Code (o agente é o agente-falso.ps1). Cada cenário monta um repositório git
# descartável em %TEMP% e usa um -StateDir próprio, então não toca no estado
# real do auto-update.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\testes-resolver-conflitos\testar-resolver-conflitos.ps1
#
# Exit = número de verificações que falharam (0 = tudo certo).
param([switch]$Manter)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$resolvedor = Join-Path (Split-Path -Parent $PSScriptRoot) 'resolver-conflitos-agente.ps1'
$agenteFalso = Join-Path $PSScriptRoot 'agente-falso.ps1'
$raiz = Join-Path $env:TEMP ('teste-resolver-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force -Path $raiz | Out-Null
$script:falhas = 0
$script:total = 0
$utf8SemBom = New-Object System.Text.UTF8Encoding $false

function Confere([bool]$cond, [string]$msg) {
  $script:total++
  if ($cond) { Write-Host "   ok     $msg" } else { Write-Host "   FALHOU $msg" -ForegroundColor Red; $script:falhas++ }
}

function GitT([string]$dir) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $s = @(& git -C $dir @args 2>&1 | ForEach-Object { "$_" }) } finally { $ErrorActionPreference = $prev }
  if ($s.Count -eq 0) { return '' }
  return ($s -join "`n").Trim()
}

function Escreve([string]$path, [string[]]$linhas, [string]$eol = "`n") {
  [IO.File]::WriteAllText($path, (($linhas -join $eol) + $eol), $utf8SemBom)
}

$dezLinhas = 1..10 | ForEach-Object { "linha $_" }

# Repo com main (base) e minha-versao saindo dela; tudo LF, com o mesmo
# .gitattributes do agent-code e um package.json com typecheck de mentira.
function Novo-Repo([string]$nome) {
  $dir = Join-Path $raiz "$nome\repo"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  [void](GitT $dir init -q -b main)
  [void](GitT $dir config user.name teste)
  [void](GitT $dir config user.email teste@exemplo.invalid)
  [void](GitT $dir config core.autocrlf false)
  Escreve (Join-Path $dir '.gitattributes') @('* text=auto')
  Escreve (Join-Path $dir '.gitignore') @('node_modules/')
  Escreve (Join-Path $dir 'package.json') @('{ "name": "t", "version": "1.0.0", "private": true,', '  "scripts": { "typecheck": "node -e \"process.exit(0)\"" } }')
  Escreve (Join-Path $dir 'package-lock.json') @('{ "name": "t", "version": "1.0.0", "lockfileVersion": 3, "requires": true,', '  "packages": { "": { "name": "t", "version": "1.0.0" } } }')
  Escreve (Join-Path $dir 'a.ts') $dezLinhas
  [void](GitT $dir add -A)
  [void](GitT $dir commit -q -m 'base')
  [void](GitT $dir branch minha-versao)
  return $dir
}

function Commita([string]$dir, [string]$branch, [string]$arquivo, [string[]]$linhas, [string]$msg) {
  [void](GitT $dir checkout -q $branch)
  Escreve (Join-Path $dir $arquivo) $linhas
  [void](GitT $dir add -A)
  [void](GitT $dir commit -q -m $msg)
}

function Roda([string]$dir, [string]$state, [string]$modo, [string[]]$extra = @()) {
  $env:AGENTE_FALSO_MODO = $modo
  $argumentos = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $resolvedor, '-RepoPath', $dir, '-StateDir', $state, '-AgenteDeTeste', $agenteFalso) + $extra
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & powershell @argumentos *> (Join-Path $raiz 'saida-ultima-execucao.txt') } finally { $ErrorActionPreference = $prev }
  $codigo = $LASTEXITCODE
  $rel = Get-Content -LiteralPath (Join-Path $state 'ultima-resolucao.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  Write-Host ("   -> exit {0}, resultado={1}, metodo={2}: {3}" -f $codigo, $rel.resultado, $rel.metodo, $rel.motivo)
  return [pscustomobject]@{ Codigo = $codigo; Rel = $rel }
}

function Chamadas([string]$state) {
  $p = Join-Path $state 'resolucao-agente\decisoes-agente.json.chamadas'
  if (-not (Test-Path -LiteralPath $p)) { return 0 }
  return @(Get-Content -LiteralPath $p).Count
}

function Config([string]$state, [string]$json) {
  New-Item -ItemType Directory -Force -Path $state | Out-Null
  # Com BOM de propósito (Set-Content utf8 no PowerShell 5.1): o resolvedor tolera.
  Set-Content -LiteralPath (Join-Path $state 'resolver-conflitos.json') -Value $json -Encoding utf8
}

# ---------------------------------------------------------------------------
Write-Host '(a) conflito so de fim de linha (CRLF x LF) -> renormalize, sem agente, aplicado'
$dir = Novo-Repo 'a'
$state = Join-Path $raiz 'a\state'
# minha-versao grava a.ts inteiro em CRLF (contornando a normalização, como
# aconteceu com src/shared/api.ts) e muda a linha 2; o original muda a linha 9.
[void](GitT $dir checkout -q minha-versao)
$linhasFork = $dezLinhas.Clone(); $linhasFork[1] = 'linha 2 da minha versao'
Escreve (Join-Path $dir 'a.ts') $linhasFork "`r`n"
$blob = GitT $dir hash-object -w --no-filters a.ts
[void](GitT $dir update-index --cacheinfo "100644,$blob,a.ts")
[void](GitT $dir commit -q -m 'minha versao: linha 2 (arquivo em CRLF)')
$linhasMain = $dezLinhas.Clone(); $linhasMain[8] = 'linha 9 do original'
Commita $dir 'main' 'a.ts' $linhasMain 'original: linha 9'
[void](GitT $dir merge-tree --write-tree main minha-versao)
Confere ($LASTEXITCODE -eq 1) 'pre-condicao: o rebase/merge normal conflita'
$antes = GitT $dir rev-parse minha-versao
$r = Roda $dir $state 'sentinela'
$depois = GitT $dir rev-parse minha-versao
Confere ($r.Codigo -eq 0) 'exit 0'
Confere ($r.Rel.resultado -eq 'resolvido' -and $r.Rel.metodo -eq 'renormalize') 'resultado=resolvido, metodo=renormalize'
Confere ((Chamadas $state) -eq 0) 'o agente NAO foi chamado'
Confere ($depois -ne $antes -and $depois -eq $r.Rel.shaDepois) 'minha-versao foi movida para shaDepois (update-ref)'
Confere ((GitT $dir rev-parse "$($r.Rel.tagBackup)") -eq $antes) "tag de backup $($r.Rel.tagBackup) no sha antigo"
$conteudo = GitT $dir show minha-versao:a.ts
Confere ($conteudo -match 'linha 2 da minha versao' -and $conteudo -match 'linha 9 do original') 'resultado tem a mudanca dos dois lados'
Confere ((GitT $dir branch --list 'auto-resolucao/*') -eq '') 'branch temporario removido'
Confere (-not (Test-Path (Join-Path $state 'worktree-resolucao'))) 'worktree temporaria removida'

# ---------------------------------------------------------------------------
Write-Host '(b) agente "resolve" deixando marcador de conflito -> validacao recusa'
$dir = Novo-Repo 'b'
$state = Join-Path $raiz 'b\state'
$l = $dezLinhas.Clone(); $l[4] = 'linha 5 da minha versao'
Commita $dir 'minha-versao' 'a.ts' $l 'minha versao: linha 5'
$l = $dezLinhas.Clone(); $l[4] = 'linha 5 do original'
Commita $dir 'main' 'a.ts' $l 'original: linha 5'
$antes = GitT $dir rev-parse minha-versao
$r = Roda $dir $state 'marcador' @('-NoApply')
Confere ($r.Codigo -eq 3) 'exit 3'
Confere ($r.Rel.resultado -eq 'falhou' -and $r.Rel.motivo -match 'marcador') 'resultado=falhou por marcador de conflito'
Confere ((Chamadas $state) -eq 1) 'agente chamado 1 vez'
Confere ((GitT $dir rev-parse minha-versao) -eq $antes) 'minha-versao intacta'
Confere ((GitT $dir branch --list 'auto-resolucao/*') -eq '') 'branch temporario removido apos falha'

Write-Host '(d) mesmo par de novo -> pulado, sem chamar o agente'
$r = Roda $dir $state 'marcador' @('-NoApply')
Confere ($r.Codigo -eq 2) 'exit 2'
Confere ($r.Rel.resultado -eq 'pulado') 'resultado=pulado'
Confere ((Chamadas $state) -eq 1) 'agente continua com 1 chamada'
$r = Roda $dir $state 'marcador' @('-NoApply')
Confere ($r.Codigo -eq 2 -and $r.Rel.resultado -eq 'pulado' -and (Chamadas $state) -eq 1) 'terceira vez tambem pulado (pulado nao zera a anti-repeticao)'

# ---------------------------------------------------------------------------
Write-Host '(c) agente descarta commit (rebase --skip) com politica nunca-descartar -> recusa'
$dir = Novo-Repo 'c'
$state = Join-Path $raiz 'c\state'
Commita $dir 'minha-versao' 'b.ts' @('export const b = 1') 'minha versao: arquivo b'
$l = $dezLinhas.Clone(); $l[4] = 'linha 5 do escritorio antigo'
Commita $dir 'minha-versao' 'a.ts' $l 'minha versao: escritorio antigo'
$l = $dezLinhas.Clone(); $l[4] = 'linha 5 do escritorio do original'
Commita $dir 'main' 'a.ts' $l 'original: escritorio novo'
[void](GitT $dir checkout -q minha-versao)
$antes = GitT $dir rev-parse minha-versao
$r = Roda $dir $state 'pula'
Confere ($r.Codigo -eq 3) 'exit 3'
Confere ($r.Rel.resultado -eq 'falhou' -and $r.Rel.motivo -match 'nunca descartar') 'resultado=falhou pela politica'
$d = @($r.Rel.commitsDescartados)
Confere ($d.Count -eq 1 -and $d[0].titulo -eq 'minha versao: escritorio antigo') 'relatorio lista o commit descartado'
Confere ((GitT $dir rev-parse minha-versao) -eq $antes) 'minha-versao intacta'

Write-Host '(c2) mesmo par com descartar-e-avisar (config com BOM) -> aceita, registra e aplica com reset --keep'
Config $state '{ "ativo": true, "politicaCommitSuperado": "descartar-e-avisar", "modelo": "", "timeoutMinutos": 40 }'
$r = Roda $dir $state 'pula'
Confere ($r.Codigo -eq 0) 'exit 0 (politica mudou, entao nao e pulado)'
Confere ($r.Rel.resultado -eq 'resolvido' -and $r.Rel.metodo -eq 'agente' -and $r.Rel.politica -eq 'descartar-e-avisar') 'resultado=resolvido, metodo=agente'
$d = @($r.Rel.commitsDescartados)
Confere ($d.Count -eq 1 -and $d[0].sha -eq (GitT $dir rev-parse "$antes") -and $d[0].motivo -eq 'o original ja tem a mesma coisa') 'descartado com sha completo e motivo vindo do agente'
Confere ((GitT $dir rev-parse HEAD) -eq $r.Rel.shaDepois -and (GitT $dir rev-parse minha-versao) -eq $r.Rel.shaDepois) 'clone (minha-versao em checkout) movido com reset --keep'
Confere ((GitT $dir status --porcelain) -eq '') 'clone continua limpo'
Confere (Test-Path (Join-Path $dir 'b.ts')) 'commit nao conflitante (arquivo b) preservado'
Confere ((GitT $dir rev-parse "$($r.Rel.tagBackup)") -eq $antes) 'tag de backup no sha antigo'
Confere (@($r.Rel.arquivosResolvidos) -contains 'a.ts') 'arquivosResolvidos veio das decisoes do agente'

# ---------------------------------------------------------------------------
Write-Host '(e) desligado pela configuracao'
$dir = Novo-Repo 'e'
$state = Join-Path $raiz 'e\state'
Config $state '{ "ativo": false }'
$r = Roda $dir $state 'sentinela' @('-NoApply')
Confere ($r.Codigo -eq 1 -and $r.Rel.resultado -eq 'desligado') 'exit 1, resultado=desligado'

Write-Host '(f) agente estoura o tempo -> processo morto, falhou'
$dir = Novo-Repo 'f'
$state = Join-Path $raiz 'f\state'
$l = $dezLinhas.Clone(); $l[4] = 'x'; Commita $dir 'minha-versao' 'a.ts' $l 'minha versao: x'
$l = $dezLinhas.Clone(); $l[4] = 'y'; Commita $dir 'main' 'a.ts' $l 'original: y'
Config $state '{ "timeoutMinutos": 0.1 }'
$t0 = Get-Date
$r = Roda $dir $state 'dorme' @('-NoApply')
Confere ($r.Codigo -eq 3 -and $r.Rel.motivo -match 'limite') 'exit 3 por tempo'
Confere (((Get-Date) - $t0).TotalSeconds -lt 90) 'nao esperou o agente terminar sozinho (120 s)'

# ---------------------------------------------------------------------------
Write-Host ''
Write-Host ("{0} verificacoes, {1} falha(s). Pasta: {2}" -f $script:total, $script:falhas, $raiz)
if (-not $Manter -and $script:falhas -eq 0) { Remove-Item -LiteralPath $raiz -Recurse -Force -ErrorAction SilentlyContinue }
exit $script:falhas
