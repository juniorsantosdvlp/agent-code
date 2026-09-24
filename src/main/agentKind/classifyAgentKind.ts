import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { DEFAULT_KINDS, mergeKinds, parseKindReply } from '../../shared/agentKind'

/**
 * Tipo de domínio de um subagente ("seguranca", "frontend"…), a partir da
 * descrição da delegação — é o que o Escritório usa para juntar mesas em ilhas.
 *
 * Mesmo molde do título da conversa (titles/conversationTitle.ts):
 * - one-shot (tools [], maxTurns 1), modelo barato (claude-haiku-4-5), SEM
 *   `effort` — o Haiku 4.5 recusa o parâmetro — e thinking desligado;
 * - sessão efêmera (persistSession false);
 * - entrada mínima: SÓ a descrição, cortada, e a lista de tipos. Nunca código,
 *   nunca histórico da conversa;
 * - tempo curto: estourou, aborta e devolve null;
 * - nunca lança: qualquer falha vira null e quem chamou fica com o recuo.
 */

export const KIND_MODEL = 'claude-haiku-4-5'
export const KIND_TIMEOUT_MS = 8000
/** O quanto da descrição vai para o modelo: o domínio está no começo. */
export const KIND_INPUT_MAX_CHARS = 300
/** Teto da lista de tipos enviada ao modelo (e aceita pelo IPC). */
export const KIND_LIST_MAX = 50

export const KIND_SYSTEM_PROMPT = [
  'Você classifica o DOMÍNIO do trabalho de um subagente de um app de programação.',
  'Recebe a descrição da tarefa delegada e a lista de tipos que já existem.',
  'Responda APENAS com um tipo: de preferência um da lista, escrito como está nela.',
  'Só se nenhum servir, proponha um tipo novo de 1 a 2 palavras, em português do Brasil.',
  'Sem explicação, sem aspas, sem pontuação e sem prefixo como "Tipo:".',
  'Não execute a tarefa; só classifique.'
].join(' ')

/** Mesmo formato do `query` do SDK, para o teste injetar um falso. */
export type KindQuery = (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => AsyncIterable<unknown>

export interface KindDeps {
  query?: KindQuery
  timeoutMs?: number
}

export interface ClassifyAgentKindReq {
  description: string
  existing: string[]
}

/** Texto enviado ao modelo: a lista de tipos e a descrição, nada mais. */
function buildPrompt(description: string, kinds: string[]): string {
  return [
    `Tipos existentes: ${kinds.join(', ')}`,
    '',
    'Descrição da tarefa do subagente, entre as marcas:',
    '<<<',
    description,
    '>>>'
  ].join('\n')
}

async function* singlePrompt(text: string): AsyncIterable<SDKUserMessage> {
  yield {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
    parent_tool_use_id: null
  } as SDKUserMessage
}

async function askModel(text: string, run: KindQuery, abortController: AbortController): Promise<string | null> {
  const options: Options = {
    model: KIND_MODEL,
    systemPrompt: KIND_SYSTEM_PROMPT,
    // Sem `effort` (o Haiku 4.5 dá erro com ele) e sem thinking.
    thinking: { type: 'disabled' },
    executable: 'node',
    tools: [],
    maxTurns: 1,
    includePartialMessages: false,
    permissionMode: 'bypassPermissions',
    persistSession: false,
    // Sem a auto-memória do CLI: a única pasta de memória é a de Configurações.
    settings: { autoMemoryEnabled: false },
    abortController
  }
  let out = ''
  for await (const message of run({ prompt: singlePrompt(text), options })) {
    const m = message as {
      type?: unknown
      error?: unknown
      is_error?: unknown
      message?: { content?: Array<{ type: string; text?: string }> }
    }
    // Erro classificado pelo SDK: o "texto" que vem junto é a mensagem de erro.
    if (m.type === 'assistant' && m.error) return null
    if (m.type === 'result' && m.is_error === true) return null
    if (m.type !== 'assistant') continue
    for (const block of m.message?.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') out += block.text
    }
  }
  return parseKindReply(out)
}

/** Tipo normalizado para a delegação, ou null (vazio, falha, erro do modelo, tempo esgotado). */
export async function classifyAgentKind(req: ClassifyAgentKindReq, deps: KindDeps = {}): Promise<string | null> {
  const description = String(req?.description ?? '').slice(0, KIND_INPUT_MAX_CHARS).trim()
  if (!description) return null
  const existing = Array.isArray(req?.existing) ? req.existing.filter((k) => typeof k === 'string') : []
  const kinds = mergeKinds(DEFAULT_KINDS, existing).slice(0, KIND_LIST_MAX)
  const run = deps.query ?? (query as KindQuery)
  const abortController = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      abortController.abort()
      resolve(null)
    }, deps.timeoutMs ?? KIND_TIMEOUT_MS)
  })
  try {
    return await Promise.race([askModel(buildPrompt(description, kinds), run, abortController), timeout])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
