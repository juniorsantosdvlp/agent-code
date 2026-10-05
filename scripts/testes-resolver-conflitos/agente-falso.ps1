# Agente falso para os testes do resolver-conflitos-agente.ps1 (não chama o
# Claude Code). Roda na worktree de resolução, como o agente de verdade.
# O comportamento vem de $env:AGENTE_FALSO_MODO:
#   sentinela - só registra que foi chamado e sai com erro (não deveria ser chamado)
#   marcador  - "resolve" commitando os arquivos COM os marcadores de conflito
#   pula      - pula (git rebase --skip) todo commit que conflitar e registra o motivo
#   dorme     - fica parado (para testar o timeout)
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
  'dorme' { Start-Sleep -Seconds 120; exit 0 }
  default { exit 1 }
}
