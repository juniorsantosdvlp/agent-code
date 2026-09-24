import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, cleanup, fireEvent, within, act } from '@testing-library/react'
import * as THREE from 'three'
import { AgentOffice } from './AgentOffice'
import { formatStepInput } from './AgentOfficeDetail'
import type { OfficeDesk, OfficeIsland } from '../office'
import type { AgentTrack, TrackMap } from '../agentTracks'

// O renderer WebGL de verdade não existe no jsdom; no bloco "cena" ele é
// trocado por um falso que só registra as chamadas. O resto do three (cena,
// geometrias, materiais, câmera) é o real.
const fake = vi.hoisted(() => ({ renderers: [] as Array<Record<string, unknown>> }))
vi.mock('three', async (importOriginal) => {
  const actual = await importOriginal<typeof import('three')>()
  class FakeRenderer {
    domElement = document.createElement('canvas')
    outputColorSpace = ''
    setPixelRatio = vi.fn()
    setClearColor = vi.fn()
    setSize = vi.fn()
    render = vi.fn()
    dispose = vi.fn()
    forceContextLoss = vi.fn()
    constructor() {
      fake.renderers.push(this as unknown as Record<string, unknown>)
    }
  }
  return { ...actual, WebGLRenderer: FakeRenderer }
})

afterEach(cleanup)

function desk(over: Partial<OfficeDesk> & { id: string; name: string }): OfficeDesk {
  return { label: '', kind: 'seguranca', state: 'idle', stepCount: 0, ...over }
}

function island(kind: string, label: string, desks: OfficeDesk[], over: Partial<OfficeIsland> = {}): OfficeIsland {
  const working = desks.filter((d) => d.state === 'working').length
  const attention = desks.filter((d) => d.state === 'asking' || d.state === 'failed').length
  return { kind, label, desks, overflow: 0, total: desks.length, working, attention, summary: 'ociosa', ...over }
}

const track: AgentTrack = {
  id: 't1',
  label: 'executor: blindar a rota',
  subagentType: 'executor',
  tipo: 'seguranca',
  status: 'running',
  startedAt: 1,
  stepCount: 3,
  steps: [
    { id: 's1', name: 'Grep', input: { pattern: 'token', path: 'src' }, startedAt: 2, endedAt: 3, result: 'src/auth.ts:12' },
    {
      id: 's2',
      name: 'Edit',
      input: { file_path: 'C:\\proj\\src\\auth.ts', old_string: 'const ttl = 0', new_string: 'const ttl = 3600' },
      startedAt: 4,
      endedAt: 5,
      result: 'ok'
    },
    { id: 's3', name: 'Bash', input: { command: 'npm test' }, startedAt: 6, endedAt: 7, isError: true, result: '1 falhou' }
  ]
}
const tracks: TrackMap = { t1: track }

function fixture(): OfficeIsland[] {
  return [
    island('principal', 'Principal', [
      desk({ id: 'principal', name: 'Principal', kind: 'principal', state: 'working', label: 'lendo o plano' })
    ]),
    island(
      'seguranca',
      'Segurança',
      [
        desk({ id: 'track:t1', trackId: 't1', name: 'executor', state: 'working', tool: 'Edit', stepCount: 3 }),
        desk({ id: 'track:t2', trackId: 't2', name: 'critico', state: 'asking' }),
        desk({ id: 'track:t3', trackId: 't3', name: 'memoria', state: 'failed' }),
        desk({ id: 'track:t4', trackId: 't4', name: 'navegador', state: 'idle' })
      ],
      { overflow: 3, total: 7, summary: '1 trabalhando · 2 precisam de atenção' }
    ),
    island('dados', 'Dados', [desk({ id: 'track:t5', trackId: 't5', name: 'analista', kind: 'dados' })])
  ]
}

const balloon = (name: string): HTMLElement => screen.getByRole('button', { name: new RegExp(`^${name}:`) })

describe('AgentOffice — modo sem WebGL', () => {
  it('cai no modo HTML no jsdom e mostra ilhas, contagens e mesas', () => {
    const { container } = render(<AgentOffice islands={fixture()} tracks={tracks} />)
    expect(container.querySelector('canvas')).toBeNull()
    expect(container.querySelector('.office-fallback')).not.toBeNull()

    const seg = screen.getByRole('region', { name: 'Segurança' })
    expect(within(seg).getByText('7 agentes')).toBeTruthy()
    expect(within(seg).getByText('1 trabalhando · 2 precisam de atenção')).toBeTruthy()
    expect(within(seg).getAllByRole('button')).toHaveLength(4)
    expect(screen.getByRole('region', { name: 'Principal' })).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Dados' })).toBeTruthy()

    // Balão: nome + ferramenta atual (ou o estado, quando parado).
    expect(within(balloon('executor')).getByText('Edit')).toBeTruthy()
    expect(within(balloon('navegador')).getByText('parado')).toBeTruthy()
  })

  it('⚠ aparece só em asking e failed', () => {
    render(<AgentOffice islands={fixture()} tracks={tracks} />)
    expect(balloon('critico').querySelector('.office-warn')?.textContent).toBe('⚠')
    expect(balloon('memoria').querySelector('.office-warn')?.textContent).toBe('⚠')
    expect(balloon('executor').querySelector('.office-warn')).toBeNull()
    expect(balloon('navegador').querySelector('.office-warn')).toBeNull()
    expect(balloon('Principal').querySelector('.office-warn')).toBeNull()
    expect(document.querySelectorAll('.office-warn')).toHaveLength(2)
  })

  it('"+N" aparece só na ilha com overflow', () => {
    render(<AgentOffice islands={fixture()} tracks={tracks} />)
    expect(within(screen.getByRole('region', { name: 'Segurança' })).getByText('+3')).toBeTruthy()
    expect(within(screen.getByRole('region', { name: 'Dados' })).queryByText(/^\+\d/)).toBeNull()
  })

  it('clicar na mesa abre o detalhe com os passos em ordem e código destacado; clicar de novo fecha', () => {
    const { container } = render(<AgentOffice islands={fixture()} tracks={tracks} />)
    fireEvent.click(balloon('executor'))

    const detail = screen.getByRole('complementary', { name: 'Detalhe de executor' })
    expect(within(detail).getByText('trabalhando')).toBeTruthy()
    expect(within(detail).getByText('3 passos')).toBeTruthy()
    const tools = [...detail.querySelectorAll('.office-step-tool')].map((el) => el.textContent)
    expect(tools).toEqual(['Grep', 'Edit', 'Bash'])

    // Edit: caminho + antes/depois; Bash: o comando; highlight.js em ação.
    expect(within(detail).getByText('C:\\proj\\src\\auth.ts')).toBeTruthy()
    expect(within(detail).getByText('antes')).toBeTruthy()
    expect(within(detail).getByText('depois')).toBeTruthy()
    expect(detail.querySelectorAll('pre.hljs').length).toBeGreaterThanOrEqual(4)
    expect(detail.querySelector('[class^="hljs-"]')).not.toBeNull()

    // Resultado com erro destacado.
    const err = detail.querySelector('.office-step-result.is-error')
    expect(err?.textContent).toContain('1 falhou')
    expect(err?.textContent).toContain('erro')

    fireEvent.click(balloon('executor'))
    expect(container.querySelector('.office-detail')).toBeNull()
  })

  it('o botão de fechar e o Esc tiram a seleção', () => {
    const { container } = render(<AgentOffice islands={fixture()} tracks={tracks} />)
    fireEvent.click(balloon('executor'))
    fireEvent.click(screen.getByRole('button', { name: 'Fechar detalhe' }))
    expect(container.querySelector('.office-detail')).toBeNull()

    fireEvent.click(balloon('executor'))
    fireEvent.keyDown(window, { key: 'Escape' })
    expect(container.querySelector('.office-detail')).toBeNull()
  })

  it('principal (sem trilha) mostra só o estado e a linha', () => {
    render(<AgentOffice islands={fixture()} tracks={tracks} />)
    fireEvent.click(balloon('Principal'))
    const detail = screen.getByRole('complementary', { name: 'Detalhe de Principal' })
    expect(within(detail).getByText('lendo o plano')).toBeTruthy()
    expect(detail.querySelector('.office-steps')).toBeNull()
    expect(within(detail).queryByText(/passos?$/)).toBeNull()
  })

  it('a mesa que some das ilhas leva o detalhe junto', () => {
    const { rerender, container } = render(<AgentOffice islands={fixture()} tracks={tracks} />)
    fireEvent.click(balloon('executor'))
    const without = fixture()
    without[1] = { ...without[1], desks: without[1].desks.slice(1) }
    rerender(<AgentOffice islands={without} tracks={tracks} />)
    expect(container.querySelector('.office-detail')).toBeNull()
  })

  it('desmontar não lança', () => {
    const { unmount } = render(<AgentOffice islands={fixture()} tracks={tracks} />)
    fireEvent.click(balloon('executor'))
    expect(() => unmount()).not.toThrow()
  })
})

describe('formatStepInput', () => {
  it('infere a linguagem pela extensão, bash para Bash e json para o resto', () => {
    expect(formatStepInput('Write', { file_path: 'a/b.py', content: 'x = 1' })).toEqual({
      path: 'a/b.py',
      parts: [{ code: 'x = 1', language: 'python' }]
    })
    expect(formatStepInput('Bash', { command: 'ls' }).parts[0].language).toBe('bash')
    expect(formatStepInput('Grep', { pattern: 'x' }).parts[0]).toEqual({
      code: '{\n  "pattern": "x"\n}',
      language: 'json'
    })
    const multi = formatStepInput('MultiEdit', {
      file_path: 'x.ts',
      edits: [{ old_string: 'a', new_string: 'b' }]
    })
    expect(multi.parts.map((p) => p.label)).toEqual(['edição 1 · antes', 'edição 1 · depois'])
    expect(multi.parts[0].language).toBe('typescript')
  })
})

describe('AgentOffice — cena three.js (renderer falso)', () => {
  let rafQueue: Map<number, FrameRequestCallback>
  let nextRaf: number
  const flushRaf = (): void => {
    const pending = [...rafQueue.entries()]
    rafQueue.clear()
    for (const [, cb] of pending) cb(performance.now())
  }

  beforeEach(() => {
    fake.renderers.length = 0
    rafQueue = new Map()
    nextRaf = 1
    vi.stubGlobal('WebGLRenderingContext', class {})
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      const id = nextRaf++
      rafQueue.set(id, cb)
      return id
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafQueue.delete(id)
    })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    // Volta ao getter do protótipo.
    delete (document as unknown as Record<string, unknown>).visibilityState
  })

  function collect(scene: THREE.Scene): { geometries: Set<THREE.BufferGeometry>; materials: Set<THREE.Material> } {
    const geometries = new Set<THREE.BufferGeometry>()
    const materials = new Set<THREE.Material>()
    scene.traverse((o) => {
      const m = o as THREE.Mesh
      if (m.geometry) geometries.add(m.geometry)
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => materials.add(x))
    })
    return { geometries, materials }
  }

  it('monta o canvas, desenha sob demanda e no unmount descarta tudo, perde o contexto e remove o canvas', () => {
    const geoDispose = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose')
    const matDispose = vi.spyOn(THREE.Material.prototype, 'dispose')

    const { container, unmount } = render(<AgentOffice islands={fixture()} tracks={tracks} />)
    expect(fake.renderers).toHaveLength(1)
    const r = fake.renderers[0] as unknown as {
      domElement: HTMLCanvasElement
      render: ReturnType<typeof vi.fn>
      dispose: ReturnType<typeof vi.fn>
      forceContextLoss: ReturnType<typeof vi.fn>
    }
    expect(container.contains(r.domElement)).toBe(true)
    expect(container.querySelector('.office-fallback')).toBeNull()

    // Nada desenha antes do quadro pedido; um quadro desenha a cena.
    expect(r.render).not.toHaveBeenCalled()
    act(() => flushRaf())
    expect(r.render).toHaveBeenCalledTimes(1)
    const scene = r.render.mock.calls[0][0] as THREE.Scene
    const { geometries, materials } = collect(scene)
    expect(geometries.size).toBeGreaterThan(0)
    expect(materials.size).toBeGreaterThan(3)

    // Rótulos HTML posicionados pela projeção.
    const anchor = container.querySelector<HTMLElement>('[data-anchor="desk:track:t1"]')
    expect(anchor?.style.visibility).toBe('visible')
    expect(anchor?.style.transform).toMatch(/^translate\(/)

    // Há mesa trabalhando: o laço agenda o próximo quadro.
    expect(rafQueue.size).toBe(1)

    unmount()
    expect(rafQueue.size).toBe(0) // cancelAnimationFrame
    expect(r.dispose).toHaveBeenCalledTimes(1)
    expect(r.forceContextLoss).toHaveBeenCalledTimes(1)
    expect(r.domElement.isConnected).toBe(false)
    const disposedGeos = new Set(geoDispose.mock.contexts)
    const disposedMats = new Set(matDispose.mock.contexts)
    for (const g of geometries) expect(disposedGeos.has(g)).toBe(true)
    for (const m of materials) expect(disposedMats.has(m)).toBe(true)
  })

  it('ao mudar as ilhas, descarta os materiais da construção anterior', () => {
    const matDispose = vi.spyOn(THREE.Material.prototype, 'dispose')
    const { rerender } = render(<AgentOffice islands={fixture()} tracks={tracks} />)
    act(() => flushRaf())
    const r = fake.renderers[0] as unknown as { render: ReturnType<typeof vi.fn> }
    const scene = r.render.mock.calls[0][0] as THREE.Scene
    const before = collect(scene).materials

    // Só a ferramenta mudou: a cena não é refeita.
    const toolOnly = fixture()
    toolOnly[1].desks[0] = { ...toolOnly[1].desks[0], tool: 'Bash' }
    rerender(<AgentOffice islands={toolOnly} tracks={tracks} />)
    expect(matDispose).not.toHaveBeenCalled()

    // Uma mesa mudou de estado: refeita, e o que saiu de cena foi descartado.
    const changed = fixture()
    changed[1].desks[0] = { ...changed[1].desks[0], state: 'failed' }
    rerender(<AgentOffice islands={changed} tracks={tracks} />)
    const after = collect(scene).materials
    const disposed = new Set(matDispose.mock.contexts)
    for (const m of before) if (!after.has(m)) expect(disposed.has(m)).toBe(true)
    for (const m of after) expect(disposed.has(m)).toBe(false)
  })

  it('hierarquia em cena: parado vira ponto clicável, balão só para working/asking/failed/selecionado', () => {
    const { container } = render(<AgentOffice islands={fixture()} tracks={tracks} />)
    act(() => flushRaf())
    const anchor = (id: string): HTMLElement => container.querySelector<HTMLElement>(`[data-anchor="desk:${id}"]`)!

    // Parados: ponto com o nome no rótulo acessível, sem balão.
    for (const id of ['track:t4', 'track:t5']) {
      expect(anchor(id).querySelector('.office-balloon')).toBeNull()
      expect(anchor(id).querySelector('.office-dot')).not.toBeNull()
    }
    const dot = screen.getByRole('button', { name: 'navegador: parado' })
    expect(dot.classList.contains('office-dot')).toBe(true)
    expect(dot.getAttribute('title')).toBe('navegador')

    // working / asking / failed: balão completo; ⚠ só nos dois últimos.
    for (const id of ['principal', 'track:t1', 'track:t2', 'track:t3']) {
      expect(anchor(id).querySelector('.office-balloon')).not.toBeNull()
    }
    expect(anchor('track:t2').querySelector('.office-warn')?.textContent).toBe('⚠')
    expect(anchor('track:t3').querySelector('.office-warn')?.textContent).toBe('⚠')
    expect(anchor('track:t1').querySelector('.office-warn')).toBeNull()

    // Prioridade e "nunca esconder" vão no DOM para a anticolisão.
    expect(anchor('track:t2').dataset.priority).toBe('5')
    expect(anchor('track:t2').dataset.pinned).toBe('true')
    expect(anchor('track:t1').dataset.priority).toBe('3')
    expect(anchor('track:t1').dataset.pinned).toBeUndefined()
    expect(anchor('track:t4').dataset.priority).toBe('1')
    const islandAnchor = container.querySelector<HTMLElement>('[data-anchor="island:seguranca"]')!
    expect(islandAnchor.dataset.priority).toBe('2')

    // Clicar no ponto seleciona: vira balão (prioridade de selecionado, fixo) e abre o detalhe.
    fireEvent.click(dot)
    expect(anchor('track:t4').querySelector('.office-balloon.is-selected')).not.toBeNull()
    expect(anchor('track:t4').dataset.priority).toBe('4')
    expect(anchor('track:t4').dataset.pinned).toBe('true')
    expect(screen.getByRole('complementary', { name: 'Detalhe de navegador' })).toBeTruthy()
  })

  it('rótulo da ilha em cena é compacto (resumo curto, completo no title) e mantém o +N', () => {
    const { container } = render(<AgentOffice islands={fixture()} tracks={tracks} />)
    const label = container.querySelector<HTMLElement>('[data-anchor="island:seguranca"] .office-island-label')!
    expect(label.classList.contains('is-compact')).toBe(true)
    expect(label.querySelector('.office-island-name')?.textContent).toBe('Segurança')
    expect(label.querySelector('.office-island-total')?.textContent).toBe('7 agentes')
    expect(label.querySelector('.office-island-summary')?.textContent).toBe('1 ativo · 2 alertas')
    expect(label.querySelector('.office-island-more')?.textContent).toBe('+3')
    expect(label.getAttribute('title')).toBe('Segurança · 7 agentes · 1 trabalhando · 2 precisam de atenção')
  })

  it('rótulos só são reposicionados quando algo muda, não a cada quadro da animação', () => {
    const { container, rerender } = render(<AgentOffice islands={fixture()} tracks={tracks} />)
    act(() => flushRaf())
    const anchor = container.querySelector<HTMLElement>('[data-anchor="desk:track:t1"]')!
    expect(anchor.style.transform).toMatch(/^translate\(/)

    // Quadro de animação (mesa trabalhando) sem mudança: o transform não é reescrito.
    // (valor CSS válido: o jsdom ignora transform inválido)
    const marked = 'translate(999px, 999px)'
    const placed = anchor.style.transform
    anchor.style.transform = marked
    expect(rafQueue.size).toBe(1)
    act(() => flushRaf())
    expect(anchor.style.transform).toBe(marked)

    // O conteúdo dos rótulos mudou (ferramenta nova): reposiciona no próximo quadro.
    const toolOnly = fixture()
    toolOnly[1].desks[0] = { ...toolOnly[1].desks[0], tool: 'Bash' }
    rerender(<AgentOffice islands={toolOnly} tracks={tracks} />)
    act(() => flushRaf())
    expect(anchor.style.transform).toBe(placed)
  })

  it('não agenda quadros com a janela escondida', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    render(<AgentOffice islands={fixture()} tracks={tracks} />)
    expect(rafQueue.size).toBe(0)
  })
})
