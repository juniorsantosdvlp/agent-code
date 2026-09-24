import { describe, it, expect } from 'vitest'
import {
  LABEL_PRIORITY,
  boundsOf,
  deskPriority,
  fitFrustum,
  resolveLabels,
  shortIslandSummary,
  showsFullBalloon,
  type Bounds2,
  type Frustum,
  type LabelBox,
  type Padding,
  type Size2
} from './officeLayout'

/** Ponto do espaço da câmera → pixel do canvas (y para baixo), como a projeção ortográfica faz. */
function toPx(f: Frustum, size: Size2, x: number, y: number): { x: number; y: number } {
  return {
    x: ((x - f.left) / (f.right - f.left)) * size.w,
    y: ((f.top - y) / (f.top - f.bottom)) * size.h
  }
}

function corners(b: Bounds2): Array<{ x: number; y: number }> {
  return [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.minX, y: b.maxY },
    { x: b.maxX, y: b.maxY }
  ]
}

describe('boundsOf', () => {
  it('caixa dos pontos; vazio é null', () => {
    expect(boundsOf([])).toBeNull()
    expect(
      boundsOf([
        { x: 1, y: -2 },
        { x: -3, y: 4 },
        { x: 0, y: 0 }
      ])
    ).toEqual({ minX: -3, maxX: 1, minY: -2, maxY: 4 })
  })
})

describe('fitFrustum', () => {
  const pad: Padding = { top: 56, right: 14, bottom: 34, left: 14 }
  const box: Bounds2 = { minX: -20, maxX: 12, minY: -9, maxY: 15 }

  it.each([
    ['420 de largura', { w: 420, h: 825 }],
    ['700 de largura', { w: 700, h: 825 }],
    ['1200 de largura (limitado pela altura)', { w: 1200, h: 500 }],
    ['380 com o painel de detalhe aberto', { w: 200, h: 825 }]
  ])('a caixa inteira cabe dentro do canvas menos o padding — %s', (_, size) => {
    const f = fitFrustum(box, size, pad)
    for (const c of corners(box)) {
      const p = toPx(f, size, c.x, c.y)
      expect(p.x).toBeGreaterThanOrEqual(pad.left - 1e-6)
      expect(p.x).toBeLessThanOrEqual(size.w - pad.right + 1e-6)
      expect(p.y).toBeGreaterThanOrEqual(pad.top - 1e-6)
      expect(p.y).toBeLessThanOrEqual(size.h - pad.bottom + 1e-6)
    }
  })

  it('pixel quadrado: a mesma escala nos dois eixos, e o frustum tem a proporção do canvas', () => {
    const size = { w: 640, h: 480 }
    const f = fitFrustum(box, size, pad)
    expect((f.right - f.left) / size.w).toBeCloseTo(f.unitsPerPx, 9)
    expect((f.top - f.bottom) / size.h).toBeCloseTo(f.unitsPerPx, 9)
  })

  it('encosta no eixo apertado e centra a sobra no folgado', () => {
    // Canvas alto e estreito: a largura manda; sobra vertical dividida ao meio.
    const size = { w: 300, h: 900 }
    const f = fitFrustum(box, size, pad)
    const left = toPx(f, size, box.minX, 0).x
    const right = toPx(f, size, box.maxX, 0).x
    expect(left).toBeCloseTo(pad.left, 6)
    expect(right).toBeCloseTo(size.w - pad.right, 6)
    const top = toPx(f, size, 0, box.maxY).y
    const bottom = toPx(f, size, 0, box.minY).y
    expect(top - pad.top).toBeCloseTo(size.h - pad.bottom - bottom, 6)
  })

  it('canvas maior aproxima (menos unidades por pixel); painel abrindo afasta', () => {
    const wide = fitFrustum(box, { w: 900, h: 700 }, pad)
    const narrow = fitFrustum(box, { w: 300, h: 700 }, pad)
    expect(narrow.unitsPerPx).toBeGreaterThan(wide.unitsPerPx)
  })

  it('padding maior que o canvas encolhe em vez de inverter a cena', () => {
    const size = { w: 40, h: 40 }
    const f = fitFrustum(box, size, { top: 100, right: 100, bottom: 100, left: 100 })
    expect(f.unitsPerPx).toBeGreaterThan(0)
    for (const c of corners(box)) {
      const p = toPx(f, size, c.x, c.y)
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(size.w)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(size.h)
    }
  })

  it('caixa degenerada (um ponto só) dá escala finita, centrada no ponto', () => {
    const size = { w: 200, h: 100 }
    const f = fitFrustum({ minX: 3, maxX: 3, minY: 2, maxY: 2 }, size, { top: 0, right: 0, bottom: 0, left: 0 })
    expect(Number.isFinite(f.unitsPerPx)).toBe(true)
    const p = toPx(f, size, 3, 2)
    expect(p.x).toBeCloseTo(100, 6)
    expect(p.y).toBeCloseTo(50, 6)
  })
})

describe('hierarquia dos rótulos', () => {
  it('balão completo para working/asking/failed e para o selecionado; parado vira marcador', () => {
    expect(showsFullBalloon('working', false)).toBe(true)
    expect(showsFullBalloon('asking', false)).toBe(true)
    expect(showsFullBalloon('failed', false)).toBe(true)
    expect(showsFullBalloon('idle', false)).toBe(false)
    expect(showsFullBalloon('idle', true)).toBe(true)
  })

  it('prioridade: asking/failed > selecionado > working > ilha > idle', () => {
    expect(deskPriority('asking', false)).toBe(LABEL_PRIORITY.attention)
    expect(deskPriority('failed', true)).toBe(LABEL_PRIORITY.attention)
    expect(deskPriority('working', true)).toBe(LABEL_PRIORITY.selected)
    expect(deskPriority('idle', true)).toBe(LABEL_PRIORITY.selected)
    expect(deskPriority('working', false)).toBe(LABEL_PRIORITY.working)
    expect(deskPriority('idle', false)).toBe(LABEL_PRIORITY.idle)
    expect(LABEL_PRIORITY.attention).toBeGreaterThan(LABEL_PRIORITY.selected)
    expect(LABEL_PRIORITY.selected).toBeGreaterThan(LABEL_PRIORITY.working)
    expect(LABEL_PRIORITY.working).toBeGreaterThan(LABEL_PRIORITY.island)
    expect(LABEL_PRIORITY.island).toBeGreaterThan(LABEL_PRIORITY.idle)
  })

  it('resumo curto da ilha', () => {
    expect(shortIslandSummary(0, 0)).toBe('ociosa')
    expect(shortIslandSummary(1, 0)).toBe('1 ativo')
    expect(shortIslandSummary(3, 2)).toBe('3 ativos · 2 alertas')
    expect(shortIslandSummary(0, 1)).toBe('1 alerta')
  })
})

describe('resolveLabels', () => {
  const canvas = { w: 400, h: 300 }
  const box = (over: Partial<LabelBox> & { id: string }): LabelBox => ({
    x: 100,
    y: 100,
    w: 80,
    h: 30,
    priority: LABEL_PRIORITY.working,
    ...over
  })
  const overlaps = (a: { x: number; y: number }, aw: number, ah: number, b: { x: number; y: number }, bw: number, bh: number) =>
    a.x < b.x + bw && b.x < a.x + aw && a.y < b.y + bh && b.y < a.y + ah

  it('sem colisão, todo mundo fica no lugar natural', () => {
    const out = resolveLabels([box({ id: 'a', x: 10, y: 10 }), box({ id: 'b', x: 200, y: 200 })], canvas)
    expect(out.get('a')).toEqual({ x: 10, y: 10, hidden: false })
    expect(out.get('b')).toEqual({ x: 200, y: 200, hidden: false })
  })

  it('o de maior prioridade fica; o menor é deslocado — independente da ordem de entrada', () => {
    const out = resolveLabels(
      [box({ id: 'ilha', priority: LABEL_PRIORITY.island, dir: 1 }), box({ id: 'alerta', priority: LABEL_PRIORITY.attention })],
      canvas
    )
    expect(out.get('alerta')).toEqual({ x: 100, y: 100, hidden: false })
    const ilha = out.get('ilha')!
    expect(ilha.hidden).toBe(false)
    expect(overlaps(ilha, 80, 30, { x: 100, y: 100 }, 80, 30)).toBe(false)
  })

  it('balão foge para cima e rótulo de ilha para baixo, em degraus de uma altura', () => {
    // Sem espaço dos lados: o canvas tem a largura do rótulo.
    const narrow = { w: 86, h: 300 }
    const up = resolveLabels(
      [box({ id: 'a', x: 3, priority: 5 }), box({ id: 'b', x: 3, priority: 3, dir: -1 })],
      narrow
    )
    expect(up.get('b')!.y).toBeLessThan(100 - 30)
    const down = resolveLabels(
      [box({ id: 'a', x: 3, priority: 5 }), box({ id: 'b', x: 3, priority: 2, dir: 1 })],
      narrow
    )
    expect(down.get('b')!.y).toBeGreaterThan(100 + 30)
  })

  it('sem lugar livre, o de menor prioridade é escondido', () => {
    const tiny = { w: 86, h: 40 }
    const out = resolveLabels(
      [box({ id: 'a', x: 3, y: 5, priority: 5 }), box({ id: 'b', x: 3, y: 5, priority: 1 })],
      tiny
    )
    expect(out.get('a')!.hidden).toBe(false)
    expect(out.get('b')!.hidden).toBe(true)
  })

  it('pinned (⚠, selecionado) nunca é escondido, mesmo sem lugar', () => {
    const tiny = { w: 86, h: 40 }
    const out = resolveLabels(
      [box({ id: 'a', x: 3, y: 5, priority: 5, pinned: true }), box({ id: 'b', x: 3, y: 5, priority: 5, pinned: true })],
      tiny
    )
    expect(out.get('a')!.hidden).toBe(false)
    expect(out.get('b')!.hidden).toBe(false)
  })

  it('prende na horizontal dentro do canvas', () => {
    const out = resolveLabels([box({ id: 'a', x: -40 }), box({ id: 'b', x: 380, y: 200 })], canvas, { gap: 3 })
    expect(out.get('a')!.x).toBe(3)
    expect(out.get('b')!.x).toBe(400 - 80 - 3)
  })

  it('maxShifts por rótulo: 0 = só desliza de lado ou some', () => {
    const narrow = { w: 86, h: 300 }
    const out = resolveLabels(
      [box({ id: 'a', x: 3, priority: 5 }), box({ id: 'b', x: 3, priority: 2, dir: 1, maxShifts: 0 })],
      narrow
    )
    expect(out.get('b')!.hidden).toBe(true)
  })

  it('deslocado evita o lugar natural de quem ainda vem (o nome da ilha vizinha não é engolido)', () => {
    // 'a' e 'b' (working) disputam o mesmo ponto; logo acima de 'b' fica o
    // rótulo de ilha 'c'. Canvas estreito: só há degraus verticais.
    const narrow = { w: 86, h: 300 }
    const out = resolveLabels(
      [
        box({ id: 'a', x: 3, y: 200, priority: 3 }),
        box({ id: 'b', x: 3, y: 200, priority: 3, dir: -1 }),
        box({ id: 'c', x: 3, y: 167, priority: 2, dir: 1, maxShifts: 0 })
      ],
      narrow
    )
    // 'b' pula o degrau que cobriria 'c' e sobe dois; 'c' fica no lugar natural.
    expect(out.get('c')).toEqual({ x: 3, y: 167, hidden: false })
    expect(out.get('b')!.hidden).toBe(false)
    expect(out.get('b')!.y).toBeLessThan(167 - 30)
  })

  it('nenhum par de visíveis se sobrepõe numa pilha de balões', () => {
    const items = Array.from({ length: 6 }, (_, i) => box({ id: `d${i}`, x: 150 + i * 10, y: 150, priority: 3 }))
    const out = resolveLabels(items, canvas)
    const shown = items.filter((it) => !out.get(it.id)!.hidden)
    for (let i = 0; i < shown.length; i++) {
      for (let j = i + 1; j < shown.length; j++) {
        const a = out.get(shown[i].id)!
        const b = out.get(shown[j].id)!
        expect(overlaps(a, 80, 30, b, 80, 30)).toBe(false)
      }
    }
  })

  it('rótulo sem medida (jsdom, antes do layout) não ocupa espaço', () => {
    const out = resolveLabels(
      [box({ id: 'a', w: 0, h: 0 }), box({ id: 'b', w: 0, h: 0, priority: 1 })],
      canvas
    )
    expect(out.get('a')!.hidden).toBe(false)
    expect(out.get('b')!.hidden).toBe(false)
  })
})
