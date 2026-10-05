# Tarefa: reaplicar a minha versão do Agent Code em cima do original

Você está numa cópia ISOLADA do repositório (uma worktree temporária criada só para
isto). O branch atual aponta para `{{BRANCH_REF}}` ({{BRANCH_SHA}}): a versão própria
do usuário, que precisa ser rebaseada sobre o original `{{BASE_REF}}` ({{BASE_SHA}}).
O rebase normal deu conflito. Seu trabalho é concluir esse rebase sem perder nada da
versão do usuário e sem estragar o que veio do original.

Ninguém vai responder perguntas: decida sozinho seguindo as regras abaixo.

## Como fazer

1. Comece com: `git rebase -X renormalize {{BASE_SHA}}`
   (o `-X renormalize` elimina os falsos conflitos de fim de linha CRLF x LF).
2. A cada parada por conflito:
   - Veja qual commit está sendo reaplicado: `git log -1 --format="%h %s" REBASE_HEAD`
     e o que ele mudava: `git show REBASE_HEAD --stat`.
   - Liste os arquivos em conflito: `git diff --name-only --diff-filter=U`.
   - Resolva cada arquivo editando o conteúdo (remova TODOS os marcadores
     `<<<<<<<`, `=======`, `>>>>>>>`) e depois `git add <arquivo>`.
   - Continue com: `git -c core.editor=true rebase --continue`
3. Repita até o rebase terminar.
4. No fim, se o `package-lock.json` mudou em relação ao início, rode
   `npm ci --ignore-scripts --no-audit --no-fund` (o `node_modules` instalado é o da
   versão antiga). Depois rode `npm run typecheck`. Se o merge
   quebrou algo, corrija SÓ o que o merge quebrou e grave num commit separado com a
   mensagem `Ajustes pos-rebase: <o que foi corrigido>`. Erros que não têm relação
   com o rebase não são seus para corrigir.

Atenção a quem é quem DURANTE o rebase:
- "ours" / HEAD = a base: o original ({{BASE_REF}}) mais os commits já reaplicados.
- "theirs" = o commit da versão do usuário que está sendo reaplicado agora.

## Regras de resolução

- Quando os dois lados ACRESCENTARAM coisas no mesmo lugar (imports, campos de
  interface/tipo, itens de lista, casos de switch, mocks de teste, blocos JSX,
  entradas de CSS), mantenha OS DOIS lados, sem duplicar o que for igual.
- Quando os dois lados mudaram a mesma linha de jeitos diferentes, entenda a
  intenção de cada um e combine; na dúvida, preserve o comportamento que a versão
  do usuário acrescentou sem desfazer a correção do original.
- `package.json` / `package-lock.json`: se o original já tem a dependência (mesmo
  em outra versão), fique com o lado do original (`git checkout --ours -- <arquivo>`
  durante o rebase). Se a versão do usuário acrescentou uma dependência que o
  original não tem, mantenha-a no `package.json` e regenere o lock com
  `npm install --package-lock-only --ignore-scripts --no-audit --no-fund`.
- Nunca edite arquivos fora do necessário para resolver o conflito; nunca crie nem
  commite arquivos novos sem relação; nunca reformate arquivos inteiros.
- Nunca use `git push`, nunca mexa em outros branches nem em tags, nunca rode
  `git reset --hard` para fora do rebase, nunca altere configuração do git.

## Commits superados pelo original (política: {{POLITICA}})

Um commit da versão do usuário está SUPERADO quando o original já entrega a mesma
funcionalidade de outro jeito. Sinais típicos:
- o original já tem componente/aba/tela/serviço com o mesmo propósito (mesmo que
  com outro nome ou em outro lugar da interface);
- os dois lados criaram símbolos com o mesmo nome e propósito (ex.: dois ícones ou
  dois componentes "Office"/"Escritorio");
- o original tem teste afirmando o contrário do que o commit faz.

Nesses casos NÃO mantenha as duas versões lado a lado, NÃO renomeie símbolos para
fazê-las conviver e NUNCA apague, enfraqueça ou inverta testes do original para
acomodar a versão do usuário. Aplique a regra abaixo (e trate do mesmo jeito os
commits seguintes que só corrigem ou ajustam esse commit superado):

{{REGRA_DESCARTE}}

## O que o script confere depois (e recusa)

Além de marcadores de conflito, rebase concluído e typecheck, o script compara o
seu resultado com o original ({{BASE_REF}}) e RECUSA o resultado inteiro se:

- **(A)** algum título de `it(`, `test(` ou `describe(` que existe num arquivo
  `*.test.*` / `*.spec.*` do original não existir mais no resultado (teste do
  original apagado ou renomeado);
- **(B)** alguma linha de arquivo de teste que o original acrescentou (desde o ponto
  em que a versão do usuário saiu dele) tiver sido removida no resultado. Em código
  de produção a mesma situação não recusa, mas vira aviso para o usuário conferir.

Ou seja: "ficar com o arquivo de teste da versão do usuário" no lugar do do original
NÃO passa. Junte os testes dos dois lados. Se a única forma de concluir for apagar ou
alterar testes do original, o commit da versão do usuário está superado: aplique a
regra acima (pular e registrar, se a política permitir; senão `git rebase --abort`
e explicar no resumo).

O `git push` também não funciona nesta sessão (o destino de push está bloqueado
pela configuração do processo); não tente contornar.

## Registro das decisões (obrigatório)

Ao terminar (com sucesso ou não), grave este JSON em `{{ARQUIVO_DECISOES}}`:

```json
{
  "resumo": "o que você fez, em português, em 2 a 5 frases",
  "arquivos": ["caminho/de/cada/arquivo/que/teve/conflito/resolvido"],
  "descartados": [{ "sha": "sha do commit pulado", "titulo": "assunto do commit", "motivo": "por que o original já cobre isso" }]
}
```

`descartados` fica `[]` se nenhum commit foi pulado.

## Se não conseguir

Se não der para resolver com segurança (conflito que exige decisão de produto,
typecheck que não fecha, regra acima que impediria continuar), rode
`git rebase --abort`, grave o JSON acima explicando no `resumo` exatamente onde
parou e por quê, e termine. Um "não consegui" honesto é melhor do que um merge
errado: o script confere o resultado e descarta qualquer coisa inválida.
