# Agente falso para os testes do resolver-conflitos-agente.ps1 (não chama o
# Claude Code). Roda na worktree de resolução, como o agente de verdade.
# O comportamento vem de $env:AGENTE_FALSO_MODO:
#   sentinela - só registra que foi chamado e sai com erro (não deveria ser chamado)
#   marcador  - "resolve" commitando os arquivos COM os marcadores de conflito
#   pula      - pula (git rebase --skip) todo commit que conflitar e registra o motivo
#   dorme     - fica parado (para testar o timeout)
#   theirs    - resolve todo conflito ficando com o lado da versão do usuário
#               (o erro do caso real: trocar o teste do original pelo do usuário);
#               com $env:AGENTE_FALSO_APAGAR = 'arquivo|trecho', depois do rebase
#               ainda apaga as linhas com o trecho e commita "Ajustes pos-rebase"
#   push      - tenta git push (origin, upstream e URL direta) e grava o código e
#               a saída de cada tentativa em <decisoes>.push; não resolve nada
$ErrorActionPreference = 'Continue'
Add-Content -LiteralPath "$env:RESOLVER_DECISOES.chamadas" -Value (Get-Date -Format o)
$base = $env:RESOLVER_BASE_SHA

function Em-Rebase {
  foreach ($n in 'rebase-merge', 'rebase-apply') {
    $p = (git rev-parse --git-path $n).Trim()
    if (Test-Path -LiteralPath $p) { return $true }
  }
  return $false
}

switch ($env:AGENTE_FALSO_MODO) {
  'marcador' {
    git rebase -X renormalize $base 2>&1 | Out-Null
    while (Em-Rebase) {
      git add -A 2>&1 | Out-Null
      git -c core.editor=true rebase --continue 2>&1 | Out-Null
    }
    exit 0
  }
  'pula' {
    $descartados = @()
    git rebase -X renormalize $base 2>&1 | Out-Null
    while (Em-Rebase) {
      $sha = (git rev-parse REBASE_HEAD).Trim()
      $titulo = (git log -1 --format=%s REBASE_HEAD).Trim()
      $descartados += [ordered]@{ sha = $sha.Substring(0, 9); titulo = $titulo; motivo = 'o original ja tem a mesma coisa' }
      git rebase --skip 2>&1 | Out-Null
    }
    $dec = [ordered]@{ resumo = 'pulei os commits superados'; arquivos = @('a.ts'); descartados = $descartados }
    # Com BOM de propósito: o resolvedor precisa tolerar.
    $dec | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $env:RESOLVER_DECISOES -Encoding utf8
    exit 0
  }
  'theirs' {
    git rebase -X renormalize $base 2>&1 | Out-Null
    while (Em-Rebase) {
      # Durante o rebase, "theirs" = o commit da versão do usuário.
      foreach ($f in @(git diff --name-only --diff-filter=U)) { git checkout --theirs -- $f 2>&1 | Out-Null }
      git add -A 2>&1 | Out-Null
      git -c core.editor=true rebase --continue 2>&1 | Out-Null
    }
    if ($env:AGENTE_FALSO_APAGAR) {
      $arq, $trecho = $env:AGENTE_FALSO_APAGAR -split '\|', 2
      $linhas = @(Get-Content -LiteralPath $arq -Encoding UTF8 | Where-Object { $_ -notlike "*$trecho*" })
      [IO.File]::WriteAllText((Join-Path (Get-Location) $arq), (($linhas -join "`n") + "`n"), (New-Object System.Text.UTF8Encoding $false))
      git add -A 2>&1 | Out-Null
      git commit -q -m 'Ajustes pos-rebase: apaguei um teste' 2>&1 | Out-Null
    }
    exit 0
  }
  'push' {
    $log = "$env:RESOLVER_DECISOES.push"
    $tentativas = [ordered]@{
      origin   = @('push', 'origin', 'HEAD:refs/heads/vazou')
      upstream = @('push', 'upstream', 'HEAD:refs/heads/vazou')
      url      = @('push', 'https://example.invalid/repo.git', 'HEAD:refs/heads/vazou')
    }
    foreach ($nome in $tentativas.Keys) {
      $a = $tentativas[$nome]
      $saida = (& git @a 2>&1 | ForEach-Object { "$_" }) -join ' / '
      Add-Content -LiteralPath $log -Value "$nome=$LASTEXITCODE|$saida"
    }
    # Config herdada de quem chamou (GIT_CONFIG_COUNT pré-existente) continua valendo?
    Add-Content -LiteralPath $log -Value "herdada=$((git config --get teste.herdada) -join '')"
    exit 1
  }
  'dorme' { Start-Sleep -Seconds 120; exit 0 }
  default { exit 1 }
}
