import type { CrewState } from '../crew'

/**
 * Geometria 2D da cena do escritório, sem three.js e sem DOM: enquadramento da
 * câmera ortográfica e arrumação dos rótulos HTML por cima do canvas. Funções
 * puras, para as regras serem testáveis sem WebGL.
 */

export interface Bounds2 {
  minX: number
  maxX: number
  minY: number
  maxY: number
}

export interface Size2 {
  w: number
  h: number
}

export interface Padding {
  top: number
  right: number
  bottom: number
  left: number
}

/** Frustum de uma câmera ortográfica, no espaço da câmera. */
export interface Frustum {
  left: number
  right: number
  top: number
  bottom: number
  /** Unidades de mundo por pixel (igual nos dois eixos: pixel quadrado). */
  unitsPerPx: number
}

/** Caixa dos pontos (x, y); `null` sem pontos. */
export function boundsOf(points: ReadonlyArray<{ x: number; y: number }>): Bounds2 | null {
  if (points.length === 0) return null
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { minX, maxX, minY, maxY }
}

/**
 * Frustum que faz a caixa (no espaço da câmera, y para cima) caber no canvas
 * `size`, deixando `pad` pixels livres em cada borda para os rótulos HTML.
 * A escala é a mesma nos dois eixos; a sobra do eixo folgado é dividida ao
 * meio, então a cena fica centrada na área útil.
 *
 * Se o padding não couber (canvas minúsculo), ele encolhe na proporção até
 * sobrar pelo menos metade do canvas para a cena — melhor rótulo apertado que
 * ilha cortada.
 */
export function fitFrustum(box: Bounds2, size: Size2, pad: Padding): Frustum {
  const w = Math.max(1, size.w)
  const h = Math.max(1, size.h)
  const shrinkX = Math.min(1, (w * 0.5) / Math.max(1e-6, pad.left + pad.right))
  const shrinkY = Math.min(1, (h * 0.5) / Math.max(1e-6, pad.top + pad.bottom))
  const pl = pad.left * shrinkX
  const pr = pad.right * shrinkX
  const pt = pad.top * shrinkY
  const pb = pad.bottom * shrinkY
  const aw = w - pl - pr
  const ah = h - pt - pb

  // Caixa degenerada (um ponto só) ainda precisa de uma escala finita.
  const bw = Math.max(box.maxX - box.minX, 1e-3)
  const bh = Math.max(box.maxY - box.minY, 1e-3)
  const unitsPerPx = Math.max(bw / aw, bh / ah)

  // O centro da caixa vai para o centro da área útil (canvas menos padding).
  const cx = (box.minX + box.maxX) / 2
  const cy = (box.minY + box.maxY) / 2
  const left = cx - ((pl + w - pr) / 2) * unitsPerPx
  const top = cy + ((pt + h - pb) / 2) * unitsPerPx
  return { left, right: left + w * unitsPerPx, top, bottom: top - h * unitsPerPx, unitsPerPx }
}

// ---------------------------------------------------------------------------
// Rótulos
// ---------------------------------------------------------------------------

/** Balão completo só para quem pede o olho; parado vira marcador compacto. */
export function showsFullBalloon(state: CrewState, selected: boolean): boolean {
  return selected || state !== 'idle'
}

/** Prioridade na disputa por espaço: maior fica, menor sai do caminho. */
export const LABEL_PRIORITY = {
  attention: 5,
  selected: 4,
  working: 3,
  island: 2,
  idle: 1
} as const

export function deskPriority(state: CrewState, selected: boolean): number {
  if (state === 'asking' || state === 'failed') return LABEL_PRIORITY.attention
  if (selected) return LABEL_PRIORITY.selected
  if (state === 'working') return LABEL_PRIORITY.working
  return LABEL_PRIORITY.idle
}

/** Resumo curto para o rótulo da ilha em cena: "2 ativos · 1 alerta". */
export function shortIslandSummary(working: number, attention: number): string {
  const parts: string[] = []
  if (working > 0) parts.push(`${working} ${working > 1 ? 'ativos' : 'ativo'}`)
  if (attention > 0) parts.push(`${attention} ${attention > 1 ? 'alertas' : 'alerta'}`)
  return parts.length > 0 ? parts.join(' · ') : 'ociosa'
}

export interface LabelBox {
  id: string
  /** Canto superior esquerdo onde o rótulo iria sem ajuste, em px do canvas. */
  x: number
  y: number
  w: number
  h: number
  priority: number
  /** Nunca escondido (⚠ e a mesa selecionada): no pior caso, fica onde está. */
  pinned?: boolean
  /** Para onde fugir de uma colisão: -1 sobe (balões), 1 desce (rótulo de ilha). */
  dir?: -1 | 1
  /** Degraus próprios deste rótulo (senão, o de `ResolveOptions`). */
  maxShifts?: number
}

export interface LabelPlacement {
  x: number
  y: number
  hidden: boolean
}

export interface ResolveOptions {
  /** Espaço mínimo entre dois rótulos e até a borda. */
  gap?: number
  /** Quantos degraus (de uma altura do rótulo) tentar antes de desistir. */
  maxShifts?: number
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Retângulo sem área (rótulo ainda não medido) não ocupa espaço. */
function hits(a: Rect, b: Rect, gap: number): boolean {
  if (a.w <= 0 || a.h <= 0 || b.w <= 0 || b.h <= 0) return false
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap
}

function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Anticolisão gulosa por prioridade. Os rótulos são colocados do mais
 * importante para o menos; cada um fica no lugar natural (preso na horizontal
 * dentro do canvas) ou, se bater em alguém já colocado, tenta meio rótulo
 * para cada lado e depois degraus na sua direção de fuga. Sem lugar livre:
 * escondido — a não ser que seja `pinned`, que fica no lugar natural mesmo
 * sobreposto. Empate de prioridade respeita a ordem de entrada.
 *
 * Um rótulo deslocado evita, se puder, o lugar natural de quem ainda não foi
 * colocado: senão um balão empurrado para cima toma o lugar do nome da ilha
 * vizinha, que nem estava no caminho de ninguém. É só preferência — sem
 * alternativa, a prioridade maior leva o espaço.
 */
export function resolveLabels(
  items: ReadonlyArray<LabelBox>,
  bounds: Size2,
  opts: ResolveOptions = {}
): Map<string, LabelPlacement> {
  const gap = opts.gap ?? 3
  const maxShifts = opts.maxShifts ?? 2
  const order = items.map((item, i) => ({ item, i })).sort((a, b) => b.item.priority - a.item.priority || a.i - b.i)
  const placed: Rect[] = []
  const out = new Map<string, LabelPlacement>()

  const clampX = (x: number, w: number): number => {
    const maxX = bounds.w - w - gap
    return maxX < gap ? gap : Math.min(Math.max(x, gap), maxX)
  }
  const natural = new Map<string, Rect>(
    items.map((it) => [it.id, { x: clampX(it.x, it.w), y: it.y, w: it.w, h: it.h }])
  )

  for (const { item } of order) {
    natural.delete(item.id)
    const x = clampX(item.x, item.w)
    const dir = item.dir ?? -1
    const step = item.h + gap
    // Em cada degrau: o lugar natural, depois meio rótulo para cada lado —
    // ainda perto da âncora, mas fora do caminho de quem já está ali.
    const nudges = [0, -item.w / 2, item.w / 2]
    const candidates: Rect[] = []
    const shifts = item.maxShifts ?? maxShifts
    for (let k = 0; k <= shifts; k++) {
      const y = item.y + dir * step * k
      // Degrau fora do canvas não é lugar (a posição natural sempre vale).
      if (k > 0 && (y < 0 || y + item.h > bounds.h)) break
      for (const dx of nudges) candidates.push({ x: clampX(item.x + dx, item.w), y, w: item.w, h: item.h })
    }
    const free = candidates.filter((r) => !placed.some((p) => hits(r, p, gap)))
    const pending = [...natural.values()]
    // Lugar natural livre é sempre dele; deslocado, prefere não invadir o
    // lugar natural de quem ainda vem.
    const naturalFree = free[0] === candidates[0] ? free[0] : undefined
    let spot: Rect | null =
      naturalFree ?? free.find((r) => !pending.some((p) => hits(r, p, gap))) ?? free[0] ?? null
    // Fixo sem lugar livre: o candidato que menos cobre quem já está lá.
    if (!spot && item.pinned) {
      spot = { x, y: item.y, w: item.w, h: item.h }
      let best = Infinity
      for (const r of candidates) {
        const cost = placed.reduce((sum, p) => sum + overlapArea(r, p), 0)
        if (cost < best) {
          best = cost
          spot = r
        }
      }
    }
    if (spot) {
      placed.push(spot)
      out.set(item.id, { x: spot.x, y: spot.y, hidden: false })
    } else {
      out.set(item.id, { x, y: item.y, hidden: true })
    }
  }
  return out
}
