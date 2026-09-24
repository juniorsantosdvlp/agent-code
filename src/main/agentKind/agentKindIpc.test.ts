// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { Channels } from '../../shared/ipc'
import { KIND_INPUT_MAX_CHARS, KIND_LIST_MAX, type ClassifyAgentKindReq } from './classifyAgentKind'
import { registerAgentKindIpc, type KindIpcListener } from './agentKindIpc'

function setup(classify: (req: ClassifyAgentKindReq) => Promise<string | null>) {
  const handlers = new Map<string, KindIpcListener>()
  const spy = vi.fn(classify)
  registerAgentKindIpc({ handle: (channel, listener) => handlers.set(channel, listener), classify: spy })
  const call = (payload: unknown): Promise<unknown> =>
    Promise.resolve(handlers.get(Channels.agentKindClassify)!(null, payload))
  return { handlers, spy, call }
}

describe('agentKind:classify', () => {
  it('registra o canal e devolve { ok: true, kind }', async () => {
    const { handlers, spy, call } = setup(async () => 'seguranca')
    expect(Channels.agentKindClassify).toBe('agentKind:classify')
    expect(handlers.has(Channels.agentKindClassify)).toBe(true)
    await expect(call({ description: 'audita o login', existing: ['dados'] })).resolves.toEqual({
      ok: true,
      kind: 'seguranca'
    })
    expect(spy).toHaveBeenCalledWith({ description: 'audita o login', existing: ['dados'] })
  })

  it('payload inválido é recusado na fronteira, sem chamar o modelo', async () => {
    const { spy, call } = setup(async () => 'x')
    const bad = [
      undefined,
      null,
      'texto solto',
      { description: 'a' },
      { existing: [] },
      { description: 42, existing: [] },
      { description: 'a', existing: 'dados' },
      { description: 'a', existing: [1, 2] },
      { description: 'a', existing: [], extra: true },
      { description: '   ', existing: [] },
      { description: 'a', existing: Array.from({ length: KIND_LIST_MAX + 1 }, (_, i) => `k${i}`) }
    ]
    for (const payload of bad) {
      await expect(call(payload)).resolves.toEqual({ ok: false })
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('corta a descrição em KIND_INPUT_MAX_CHARS e cada tipo em 30', async () => {
    const { spy, call } = setup(async () => 'dados')
    const existing = Array.from({ length: KIND_LIST_MAX }, () => 'y'.repeat(80))
    await call({ description: 'b'.repeat(KIND_INPUT_MAX_CHARS + 500), existing })
    const sent = spy.mock.calls[0][0]
    expect(sent.description).toHaveLength(KIND_INPUT_MAX_CHARS)
    expect(sent.existing).toHaveLength(KIND_LIST_MAX)
    for (const k of sent.existing) expect(k).toHaveLength(30)
  })

  it('sem tipo ou com exceção → { ok: false }, nunca lança', async () => {
    const ok = { description: 'oi', existing: [] }
    await expect(setup(async () => null).call(ok)).resolves.toEqual({ ok: false })
    await expect(setup(async () => '').call(ok)).resolves.toEqual({ ok: false })
    await expect(
      setup(async () => {
        throw new Error('boom')
      }).call(ok)
    ).resolves.toEqual({ ok: false })
  })
})
