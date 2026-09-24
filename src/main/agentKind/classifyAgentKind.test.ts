// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { DEFAULT_KINDS } from '../../shared/agentKind'
import {
  classifyAgentKind,
  KIND_INPUT_MAX_CHARS,
  KIND_LIST_MAX,
  KIND_MODEL,
  KIND_SYSTEM_PROMPT,
  KIND_TIMEOUT_MS,
  type KindQuery
} from './classifyAgentKind'

type Call = { prompt: AsyncIterable<unknown>; options: Options }

function assistant(text: string, extra: Record<string, unknown> = {}): unknown {
  return { type: 'assistant', message: { content: [{ type: 'text', text }] }, ...extra }
}

/** Um `query` falso que devolve as mensagens dadas e guarda a chamada. */
function fakeQuery(messages: unknown[]): { run: KindQuery; calls: Call[] } {
  const calls: Call[] = []
  const run: KindQuery = (args) => {
    calls.push(args as Call)
    return (async function* () {
      for (const m of messages) yield m
    })()
  }
  return { run, calls }
}

/** Todo o texto enviado ao modelo, e quantas mensagens de usuário foram. */
async function promptText(call: Call): Promise<{ text: string; count: number }> {
  let text = ''
  let count = 0
  for await (const m of call.prompt) {
    count++
    const content = (m as { message: { content: Array<{ text: string }> } }).message.content
    text += content.map((c) => c.text).join('')
  }
  return { text, count }
}

/** Teto do prompt: moldura fixa + descrição cortada + até KIND_LIST_MAX tipos de 30. */
const PROMPT_LIMIT = 200 + KIND_INPUT_MAX_CHARS + KIND_LIST_MAX * 32

describe('classifyAgentKind', () => {
  it('sucesso: resposta "Segurança" vira "seguranca", one-shot no Haiku, sem effort e sem thinking', async () => {
    const { run, calls } = fakeQuery([assistant('Segurança'), { type: 'result', is_error: false }])
    const kind = await classifyAgentKind(
      { description: 'Auditar o fluxo de login atrás de injeção de SQL', existing: [] },
      { query: run }
    )
    expect(kind).toBe('seguranca')
    expect(calls).toHaveLength(1)
    const { options } = calls[0]
    expect(options.model).toBe(KIND_MODEL)
    expect(KIND_MODEL).toBe('claude-haiku-4-5')
    expect(KIND_TIMEOUT_MS).toBe(8000)
    expect(options).not.toHaveProperty('effort')
    expect(options.thinking).toEqual({ type: 'disabled' })
    expect(options).not.toHaveProperty('maxThinkingTokens')
    expect(options.tools).toEqual([])
    expect(options.maxTurns).toBe(1)
    expect(options.persistSession).toBe(false)
    expect(options.settings).toEqual({ autoMemoryEnabled: false })
    expect(options.permissionMode).toBe('bypassPermissions')
    expect(options.executable).toBe('node')
    expect(options.systemPrompt).toBe(KIND_SYSTEM_PROMPT)
    expect(options.abortController).toBeInstanceOf(AbortController)
  })

  it('o prompt leva a descrição e a lista de tipos (padrão + existentes), numa única mensagem', async () => {
    const { run, calls } = fakeQuery([assistant('dados')])
    await classifyAgentKind(
      { description: 'Migrar a tabela de pedidos', existing: ['Infraestrutura', 'dados', 'Segurança'] },
      { query: run }
    )
    const { text, count } = await promptText(calls[0])
    expect(count).toBe(1)
    expect(text).toContain('Migrar a tabela de pedidos')
    for (const k of DEFAULT_KINDS) expect(text).toContain(k)
    expect(text).toContain('infraestrutura')
    // "Segurança" e "dados" já estão no padrão: nada de duplicata.
    expect(text.match(/seguranca/g)).toHaveLength(1)
    expect(text.match(/dados/g)).toHaveLength(1)
  })

  it('corta a descrição em KIND_INPUT_MAX_CHARS e o prompt não passa do limite', async () => {
    const { run, calls } = fakeQuery([assistant('testes')])
    const existing = Array.from({ length: 200 }, (_, i) => `tipo inventado numero ${i} ${'x'.repeat(60)}`)
    await classifyAgentKind({ description: `${'a'.repeat(KIND_INPUT_MAX_CHARS)}FIM${'b'.repeat(5000)}`, existing }, { query: run })
    const { text } = await promptText(calls[0])
    expect(text).toContain('a'.repeat(KIND_INPUT_MAX_CHARS))
    expect(text).not.toContain('FIM')
    expect(text).not.toContain('bbb')
    expect(text.length).toBeLessThanOrEqual(PROMPT_LIMIT)
  })

  it('descrição vazia nem chama o modelo', async () => {
    const { run, calls } = fakeQuery([assistant('x')])
    expect(await classifyAgentKind({ description: '   \n ', existing: ['dados'] }, { query: run })).toBeNull()
    expect(calls).toHaveLength(0)
  })

  it('resposta com lixo passa por parseKindReply', async () => {
    const { run } = fakeQuery([assistant('\n**Tipo:** "Front-end"\nPorque mexe na tela.')])
    expect(await classifyAgentKind({ description: 'ajustar o css', existing: [] }, { query: run })).toBe('front-end')
    const empty = fakeQuery([assistant('  "" ... ')])
    expect(await classifyAgentKind({ description: 'x', existing: [] }, { query: empty.run })).toBeNull()
  })

  it('erro classificado pelo SDK (assistant.error) ou result com is_error vira null', async () => {
    const a = fakeQuery([assistant('API Error: 400 effort not supported', { error: 'invalid_request' })])
    expect(await classifyAgentKind({ description: 'oi', existing: [] }, { query: a.run })).toBeNull()
    const b = fakeQuery([assistant('dados'), { type: 'result', is_error: true }])
    expect(await classifyAgentKind({ description: 'oi', existing: [] }, { query: b.run })).toBeNull()
  })

  it('exceção do query (lançada ou no meio do stream) vira null, sem lançar', async () => {
    const throwsNow: KindQuery = () => {
      throw new Error('spawn node ENOENT')
    }
    expect(await classifyAgentKind({ description: 'oi', existing: [] }, { query: throwsNow })).toBeNull()
    const throwsLater: KindQuery = () =>
      (async function* () {
        yield assistant('dados')
        throw new Error('processo morreu')
      })()
    expect(await classifyAgentKind({ description: 'oi', existing: [] }, { query: throwsLater })).toBeNull()
  })

  it('timeout: aborta a chamada e devolve null', async () => {
    vi.useFakeTimers()
    try {
      let signal: AbortSignal | undefined
      const hangs: KindQuery = ({ options }) => {
        signal = options.abortController?.signal
        return (async function* () {
          await new Promise(() => {}) // nunca responde
          yield assistant('tarde demais')
        })()
      }
      const pending = classifyAgentKind({ description: 'oi', existing: [] }, { query: hangs })
      await vi.advanceTimersByTimeAsync(KIND_TIMEOUT_MS - 1)
      expect(signal?.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await expect(pending).resolves.toBeNull()
      expect(signal?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
