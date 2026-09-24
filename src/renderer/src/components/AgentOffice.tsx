import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import type { TrackMap } from '../agentTracks'
import type { CrewState } from '../crew'
import { MAX_DESKS, PRINCIPAL_KIND, type OfficeDesk, type OfficeIsland } from '../office'
import { AgentOfficeDetail, STATE_TEXT } from './AgentOfficeDetail'
import {
  LABEL_PRIORITY,
  boundsOf,
  deskPriority,
  fitFrustum,
  resolveLabels,
  shortIslandSummary,
  showsFullBalloon,
  type Bounds2,
  type LabelBox
} from './officeLayout'

/**
 * O ESCRITÓRIO em cena: uma ilha isométrica por tipo de trabalho, ligada por
 * caminhos à ilha do agente principal no centro, com uma mesa por agente.
 *
 * Tudo é procedural (caixas, cilindros e esferas — nenhum asset) e desenhado
 * sob demanda: só há quadros enquanto alguém trabalha (animação) ou quando
 * algo mudou (ilhas, seleção, tamanho). Os rótulos são HTML por cima do canvas,
 * reposicionados projetando pontos 3D a cada quadro — texto nítido, acessível e
 * clicável sem textura nenhuma.
 *
 * Sem WebGL (testes em jsdom, máquina sem suporte, contexto perdido) o mesmo
 * conteúdo vira uma lista HTML simples.
 */

const needsAttention = (s: CrewState): boolean => s === 'asking' || s === 'failed'

/** Hash estável (FNV-1a) do tipo → matiz: a ilha "seguranca" tem sempre a mesma cor. */
export function kindHue(kind: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < kind.length; i++) {
    h ^= kind.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return ((h >>> 0) % 360) / 360
}

function canUseWebGL(): boolean {
  return typeof window !== 'undefined' && typeof WebGLRenderingContext !== 'undefined'
}

// ---------------------------------------------------------------------------
// Rótulos (compartilhados entre a cena e o modo HTML)
// ---------------------------------------------------------------------------

/** `compact`: a versão da cena — resumo curto, o completo fica no title. */
function IslandLabel({ island, compact = false }: { island: OfficeIsland; compact?: boolean }): JSX.Element {
  const total = `${island.total} ${island.total === 1 ? 'agente' : 'agentes'}`
  return (
    <div
      className={`office-island-label${island.attention > 0 ? ' has-attention' : ''}${compact ? ' is-compact' : ''}`}
      title={compact ? `${island.label} · ${total} · ${island.summary}` : undefined}
    >
      <span className="office-island-name">{island.label}</span>
      <span className="office-island-meta">
        <span className="office-island-total">{total}</span>
        <span className="office-island-summary">
          {compact ? shortIslandSummary(island.working, island.attention) : island.summary}
        </span>
        {island.overflow > 0 && (
          <span className="office-island-more" title={`${island.overflow} mesas não aparecem`}>
            +{island.overflow}
          </span>
        )}
      </span>
    </div>
  )
}

function DeskBalloon({
  desk,
  selected,
  onPick
}: {
  desk: OfficeDesk
  selected: boolean
  onPick: (id: string) => void
}): JSX.Element {
  const warn = needsAttention(desk.state)
  const doing = desk.tool ?? STATE_TEXT[desk.state]
  return (
    <button
      type="button"
      className={`office-balloon state-${desk.state}${selected ? ' is-selected' : ''}`}
      aria-pressed={selected}
      aria-label={`${desk.name}: ${doing}${warn ? ', precisa de atenção' : ''}`}
      title={desk.label || desk.name}
      onClick={() => onPick(desk.id)}
    >
      {warn && (
        <span className="office-warn" aria-hidden="true">
          ⚠
        </span>
      )}
      <span className="office-balloon-name">{desk.name}</span>
      <span className="office-balloon-tool">{doing}</span>
    </button>
  )
}

/** Mesa parada em cena: só um ponto clicável; o nome fica no title/aria-label. */
function DeskDot({ desk, onPick }: { desk: OfficeDesk; onPick: (id: string) => void }): JSX.Element {
  return (
    <button
      type="button"
      className={`office-dot state-${desk.state}`}
      aria-pressed={false}
      aria-label={`${desk.name}: ${STATE_TEXT[desk.state]}`}
      title={desk.label ? `${desk.name} — ${desk.label}` : desk.name}
      onClick={() => onPick(desk.id)}
    />
  )
}

// ---------------------------------------------------------------------------
// Modo HTML (sem WebGL)
// ---------------------------------------------------------------------------

function OfficeFallback({
  islands,
  selectedId,
  onPick
}: {
  islands: OfficeIsland[]
  selectedId: string | null
  onPick: (id: string) => void
}): JSX.Element {
  return (
    <div className="office-fallback">
      {islands.map((island) => (
        <section key={island.kind} className="office-fallback-island" aria-label={island.label}>
          <IslandLabel island={island} />
          <div className="office-fallback-desks">
            {island.desks.map((desk) => (
              <DeskBalloon key={desk.id} desk={desk} selected={desk.id === selectedId} onPick={onPick} />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cena three.js
// ---------------------------------------------------------------------------

const DESK_COLS = 3
const DESK_DX = 2.1
const DESK_DZ = 2.3
const ALERT = { asking: 0xe0a458, failed: 0xd97070 } as const

interface Animated {
  head: THREE.Object3D
  baseY: number
  phase: number
}

interface SceneCtx {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.OrthographicCamera
  /** Tudo o que depende de `islands`; descartado e refeito a cada mudança. */
  content: THREE.Group
  marker: THREE.Mesh
  /** Geometrias unitárias, reaproveitadas por todos os objetos (escala por mesh). */
  shared: { box: THREE.BoxGeometry; cyl: THREE.CylinderGeometry; sphere: THREE.SphereGeometry }
  anchors: Map<string, THREE.Vector3>
  deskPos: Map<string, THREE.Vector3>
  animated: Animated[]
  pulse: THREE.MeshLambertMaterial[]
  /** Caixa de tudo o que precisa aparecer, no espaço da câmera; `null` sem ilhas. */
  bounds: Bounds2 | null
  size: { w: number; h: number }
  requestRender: () => void
  /** Rótulos precisam ser reposicionados no próximo quadro (e pede o quadro). */
  invalidateLabels: () => void
  fit: () => void
}

/**
 * Pixels reservados em cada borda do canvas ao enquadrar: em cima cabem os
 * balões (com o ⚠ e a ponta) das mesas mais ao fundo; embaixo, o rótulo da
 * ilha mais à frente. Nas laterais os rótulos são presos para dentro pela
 * anticolisão, então basta um respiro.
 */
const FRAME_PAD = { top: 56, right: 14, bottom: 34, left: 14 }
/** Distância entre a ponta do balão e a cabeça do boneco / entre a base e o rótulo da ilha. */
const BALLOON_TAIL = 7
const ISLAND_LABEL_GAP = 6
/** Quanto o ⚠ sai para fora do balão (ver .office-warn). */
const WARN_OUTSET = { top: 9, right: 8 }

/**
 * Descarta geometrias, materiais e texturas de uma subárvore. `keep` protege as
 * geometrias compartilhadas enquanto a cena vive.
 */
function disposeTree(root: THREE.Object3D, keep?: Set<THREE.BufferGeometry>): void {
  const geometries = new Set<THREE.BufferGeometry>()
  const materials = new Set<THREE.Material>()
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (mesh.geometry && !keep?.has(mesh.geometry)) geometries.add(mesh.geometry)
    const m = mesh.material as THREE.Material | THREE.Material[] | undefined
    if (Array.isArray(m)) m.forEach((x) => materials.add(x))
    else if (m) materials.add(m)
  })
  const textures = new Set<THREE.Texture>()
  materials.forEach((mat) => {
    for (const value of Object.values(mat)) if (value instanceof THREE.Texture) textures.add(value)
  })
  geometries.forEach((g) => g.dispose())
  textures.forEach((t) => t.dispose())
  materials.forEach((m) => m.dispose())
}

/** Assinatura do que a cena desenha: tool/rótulo mudam só o HTML, não a cena. */
function sceneSignature(islands: OfficeIsland[]): string {
  return islands
    .map((i) => `${i.kind}:${i.working}:${i.attention}[${i.desks.map((d) => `${d.id}:${d.state}`).join(',')}]`)
    .join('|')
}

function islandSize(n: number): { w: number; d: number } {
  const cols = Math.max(1, Math.min(n, DESK_COLS))
  const rows = Math.max(1, Math.ceil(Math.min(n, MAX_DESKS) / DESK_COLS))
  return { w: cols * DESK_DX + 1.2, d: rows * DESK_DZ + 1 }
}

/** Elevação da câmera isométrica (30,30,30): o chão encolhe por sen(35,26°) na vertical. */
const GROUND_SQUASH = 1 / Math.sqrt(3)

/**
 * Centros das ilhas: a principal no meio, as outras num anel que cresce para
 * não se tocarem. O anel é redondo NA TELA, não no chão: no chão ele é
 * esticado na direção da câmera, senão a projeção isométrica achata o anel e
 * empilha balões e rótulos das ilhas de cima e de baixo no mesmo vão.
 */
function layoutIslands(islands: OfficeIsland[]): { centers: THREE.Vector3[]; hub: number } {
  const hub = islands.findIndex((i) => i.kind === PRINCIPAL_KIND)
  const ring = islands.filter((_, k) => k !== hub).length
  const radius = ring === 0 ? 0 : Math.max(10, 5.8 / Math.sin(Math.PI / Math.max(ring, 2)))
  let n = 0
  const centers = islands.map((_, k) => {
    if (k === hub) return new THREE.Vector3(0, 0, 0)
    const a = -Math.PI / 2 + (n++ * Math.PI * 2) / ring
    // u: horizontal na tela; v: profundidade no chão (vira vertical encolhida).
    const u = Math.cos(a) * radius
    const v = (Math.sin(a) * radius) / GROUND_SQUASH
    return new THREE.Vector3((u + v) / Math.SQRT2, 0, (v - u) / Math.SQRT2)
  })
  return { centers, hub }
}

function buildContent(ctx: SceneCtx, islands: OfficeIsland[]): void {
  // Descarta o que a construção anterior criou (as geometrias unitárias ficam).
  const { box, cyl, sphere } = ctx.shared
  ctx.scene.remove(ctx.content)
  disposeTree(ctx.content, new Set([box, cyl, sphere]))
  ctx.content = new THREE.Group()
  ctx.scene.add(ctx.content)
  ctx.anchors.clear()
  ctx.deskPos.clear()
  ctx.animated = []
  ctx.pulse = []

  // Um material por cor+papel nesta construção; todos entram no dispose da próxima.
  const cache = new Map<string, THREE.MeshLambertMaterial>()
  const mat = (color: THREE.ColorRepresentation, emissive?: THREE.ColorRepresentation, intensity = 1) => {
    const key = `${new THREE.Color(color).getHex()}:${emissive === undefined ? '-' : new THREE.Color(emissive).getHex()}:${intensity}`
    let m = cache.get(key)
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color })
      if (emissive !== undefined) {
        m.emissive = new THREE.Color(emissive)
        m.emissiveIntensity = intensity
      }
      cache.set(key, m)
    }
    return m
  }
  const block = (
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    material: THREE.Material,
    pos: [number, number, number],
    scale: [number, number, number]
  ): THREE.Mesh => {
    const mesh = new THREE.Mesh(geo, material)
    mesh.position.set(...pos)
    mesh.scale.set(...scale)
    parent.add(mesh)
    return mesh
  }

  const { centers, hub } = layoutIslands(islands)
  const pathMat = mat(0x4a4744)
  // Pontos que o enquadramento precisa mostrar: cantos das plataformas e o
  // alto de cada mesa (onde os balões se apoiam).
  const framePoints: THREE.Vector3[] = []

  islands.forEach((island, k) => {
    const c = centers[k]
    const hue = island.kind === PRINCIPAL_KIND ? 0.04 : kindHue(island.kind)
    const lively = island.working > 0 || island.attention > 0
    const { w, d } = islandSize(island.desks.length)

    // Caminho até a ilha principal (antes da ilha, que fica por cima).
    if (hub >= 0 && k !== hub) {
      const from = centers[hub]
      const len = from.distanceTo(c)
      const path = block(ctx.content, box, pathMat, [(from.x + c.x) / 2, 0.02, (from.z + c.z) / 2], [0.55, 0.06, len])
      path.rotation.y = Math.atan2(c.x - from.x, c.z - from.z)
    }

    // Plataforma: base escura + tampo na cor do tipo (apagado se ninguém trabalha).
    const top = new THREE.Color().setHSL(hue, lively ? 0.38 : 0.16, lively ? 0.34 : 0.26)
    const side = new THREE.Color().setHSL(hue, 0.2, 0.16)
    block(ctx.content, box, mat(side), [c.x, 0.2, c.z], [w, 0.4, d])
    block(ctx.content, box, mat(top), [c.x, 0.43, c.z], [w - 0.3, 0.06, d - 0.3])
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        framePoints.push(new THREE.Vector3(c.x + (sx * w) / 2, 0, c.z + (sz * d) / 2))
        framePoints.push(new THREE.Vector3(c.x + (sx * w) / 2, 0.46, c.z + (sz * d) / 2))
      }
    }
    // Rótulo da ilha abaixo da base, no canto da frente (a câmera olha de
    // +x,+z): é o ponto mais baixo da ilha na tela, longe dos balões.
    ctx.anchors.set(`island:${island.kind}`, new THREE.Vector3(c.x + w / 2, 0, c.z + d / 2))

    const bright = new THREE.Color().setHSL(hue, 0.6, 0.58)
    island.desks.forEach((desk, n) => {
      const col = n % DESK_COLS
      const row = Math.floor(n / DESK_COLS)
      const cols = Math.min(island.desks.length, DESK_COLS)
      const rows = Math.ceil(island.desks.length / DESK_COLS)
      const g = new THREE.Group()
      g.position.set(c.x + (col - (cols - 1) / 2) * DESK_DX, 0.46, c.z + (row - (rows - 1) / 2) * DESK_DZ)
      g.userData.deskId = desk.id
      ctx.content.add(g)

      const idle = desk.state === 'idle'
      const alert = desk.state === 'asking' || desk.state === 'failed' ? ALERT[desk.state] : undefined
      const back = idle ? 0.35 : 0 // parado: cadeira e boneco afastados da mesa

      // Mesa + monitor (o monitor "acende" com o estado).
      block(g, box, mat(idle ? 0x4a4440 : 0x6b5a4a), [0, 0.35, -0.25], [1.3, 0.7, 0.7])
      const screenMat = alert
        ? mat(0x1c1c1c, alert, 0.9)
        : desk.state === 'working'
          ? mat(0x1c1c1c, bright, 0.8)
          : mat(0x2a2a2a)
      if (desk.state === 'working') ctx.pulse.push(screenMat)
      block(g, box, screenMat, [0, 0.95, -0.45], [0.7, 0.45, 0.06])

      // Cadeira.
      const chairMat = mat(idle ? 0x2c3036 : 0x333a44)
      block(g, box, chairMat, [0, 0.42, 0.45 + back], [0.55, 0.08, 0.55])
      block(g, box, chairMat, [0, 0.7, 0.72 + back], [0.55, 0.55, 0.08])

      // Boneco: corpo (cilindro) + cabeça (esfera).
      const bodyColor = alert ?? (idle ? 0x5d5a57 : bright)
      block(g, cyl, mat(bodyColor, alert ? alert : undefined, alert ? 0.35 : 1), [0, 0.8, 0.45 + back], [0.2, 0.55, 0.2])
      const head = block(g, sphere, mat(idle ? 0x9a938c : 0xe8cfb8), [0, 1.22, 0.42 + back], [0.17, 0.17, 0.17])
      if (desk.state === 'working') ctx.animated.push({ head, baseY: head.position.y, phase: n * 1.3 + k })

      const world = g.position.clone()
      ctx.deskPos.set(desk.id, world)
      const perch = world.clone().add(new THREE.Vector3(0, 1.75, 0.45 + back))
      ctx.anchors.set(`desk:${desk.id}`, perch)
      framePoints.push(perch.clone())
    })
  })

  ctx.camera.updateMatrixWorld()
  ctx.bounds = boundsOf(framePoints.map((p) => p.applyMatrix4(ctx.camera.matrixWorldInverse)))
  ctx.fit()
}

function OfficeScene({
  islands,
  selectedId,
  onPick,
  onFail
}: {
  islands: OfficeIsland[]
  selectedId: string | null
  onPick: (id: string) => void
  onFail: () => void
}): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const ctxRef = useRef<SceneCtx | null>(null)
  const islandsRef = useRef(islands)
  islandsRef.current = islands
  const onPickRef = useRef(onPick)
  onPickRef.current = onPick
  const onFailRef = useRef(onFail)
  onFailRef.current = onFail

  // Montagem: renderer, câmera, luzes, laço sob demanda, observadores. A
  // limpeza desfaz TUDO — é um painel que abre e fecha muitas vezes.
  useEffect(() => {
    const host = hostRef.current
    const overlay = overlayRef.current
    if (!host || !overlay) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: 'low-power' })
    } catch {
      onFailRef.current()
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    const canvas = renderer.domElement
    canvas.className = 'office-canvas'
    host.insertBefore(canvas, overlay)

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 200)
    camera.position.set(30, 30, 30) // isométrica: olhando a diagonal de cima
    camera.lookAt(0, 0, 0)
    scene.add(new THREE.HemisphereLight(0xeef2ff, 0x2a2622, 1.6))
    const sun = new THREE.DirectionalLight(0xfff4e6, 1.6)
    sun.position.set(12, 20, 6)
    scene.add(sun)

    const shared = {
      box: new THREE.BoxGeometry(1, 1, 1),
      cyl: new THREE.CylinderGeometry(1, 1, 1, 12),
      sphere: new THREE.SphereGeometry(1, 14, 10)
    }
    // Marcador da mesa selecionada: um só, reposicionado (não reconstrói a cena).
    const marker = new THREE.Mesh(
      shared.box,
      new THREE.MeshBasicMaterial({ color: 0xd97757, transparent: true, opacity: 0.45, depthWrite: false })
    )
    marker.scale.set(1.9, 0.02, 2.1)
    marker.visible = false
    scene.add(marker)

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let raf = 0
    let disposed = false
    // Posições dos rótulos só mudam com câmera, ilhas, tamanho ou conteúdo
    // dos rótulos — não a cada quadro da animação.
    let labelsDirty = true
    const tmp = new THREE.Vector3()

    /**
     * Projeta cada âncora, mede o rótulo e passa tudo pela anticolisão: lê
     * todas as medidas antes de escrever qualquer transform (um reflow só).
     */
    const positionLabels = (): void => {
      const ctx = ctxRef.current
      if (!ctx) return
      const { w, h } = ctx.size
      const boxes: LabelBox[] = []
      const placedEls: Array<{ key: string; el: HTMLElement; lift: number }> = []
      overlay.querySelectorAll<HTMLElement>('[data-anchor]').forEach((el) => {
        const key = el.dataset.anchor ?? ''
        const anchor = ctx.anchors.get(key)
        if (!anchor) {
          el.style.visibility = 'hidden'
          return
        }
        tmp.copy(anchor).project(camera)
        const px = ((tmp.x + 1) / 2) * w
        const py = ((1 - tmp.y) / 2) * h
        const label = el.firstElementChild as HTMLElement | null
        const lw = label?.offsetWidth ?? 0
        const lh = label?.offsetHeight ?? 0
        const island = el.dataset.role === 'island'
        const warn = el.dataset.warn === 'true' ? WARN_OUTSET : { top: 0, right: 0 }
        const y = island ? py + ISLAND_LABEL_GAP : py - lh - BALLOON_TAIL
        boxes.push({
          id: key,
          x: px - lw / 2,
          y: y - warn.top,
          w: lw + warn.right,
          h: lh + warn.top,
          priority: Number(el.dataset.priority) || 0,
          pinned: el.dataset.pinned === 'true',
          // O nome da ilha longe da base cai em cima de outra ilha e engana
          // mais do que ajuda: só desliza de lado, senão some. Quem nunca some
          // (⚠, selecionado) pode subir mais para achar lugar.
          dir: island ? 1 : -1,
          maxShifts: island ? 0 : el.dataset.pinned === 'true' ? 3 : 2
        })
        placedEls.push({ key, el, lift: warn.top })
      })
      const placement = resolveLabels(boxes, { w, h })
      for (const { key, el, lift } of placedEls) {
        const p = placement.get(key)
        if (!p) continue
        el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y + lift)}px)`
        el.style.visibility = p.hidden ? 'hidden' : 'visible'
      }
    }

    const frame = (now: number): void => {
      raf = 0
      const ctx = ctxRef.current
      if (disposed || !ctx) return
      const t = now / 1000
      const animate = !reduceMotion && ctx.animated.length > 0
      if (animate) {
        for (const a of ctx.animated) a.head.position.y = a.baseY + Math.abs(Math.sin(t * 3 + a.phase)) * 0.06
        const glow = 0.65 + Math.sin(t * 2.4) * 0.25
        for (const m of ctx.pulse) m.emissiveIntensity = glow
      }
      renderer.render(scene, camera)
      if (labelsDirty) {
        labelsDirty = false
        positionLabels()
      }
      if (animate && document.visibilityState === 'visible') raf = requestAnimationFrame(frame)
    }

    const requestRender = (): void => {
      if (disposed || raf !== 0 || document.visibilityState !== 'visible') return
      raf = requestAnimationFrame(frame)
    }

    const invalidateLabels = (): void => {
      labelsDirty = true
      requestRender()
    }

    // Enquadramento: a caixa de todas as ilhas (+ folga dos rótulos) cabe no
    // canvas atual. Roda no resize (inclusive o painel de detalhe abrindo) e a
    // cada reconstrução das ilhas.
    const fit = (): void => {
      const ctx = ctxRef.current
      if (!ctx) return
      const box = ctx.bounds ?? { minX: -6, maxX: 6, minY: -6, maxY: 6 }
      const f = fitFrustum(box, ctx.size, FRAME_PAD)
      camera.left = f.left
      camera.right = f.right
      camera.top = f.top
      camera.bottom = f.bottom
      camera.updateProjectionMatrix()
      invalidateLabels()
    }

    const ctx: SceneCtx = {
      renderer,
      scene,
      camera,
      content: new THREE.Group(),
      marker,
      shared,
      anchors: new Map(),
      deskPos: new Map(),
      animated: [],
      pulse: [],
      bounds: null,
      size: { w: host.clientWidth || 1, h: host.clientHeight || 1 },
      requestRender,
      invalidateLabels,
      fit
    }
    ctxRef.current = ctx
    scene.add(ctx.content)

    const resize = (): void => {
      const w = Math.max(1, host.clientWidth)
      const h = Math.max(1, host.clientHeight)
      ctx.size = { w, h }
      renderer.setSize(w, h, false)
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
      fit()
    }
    resize()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null
    ro?.observe(host)

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') requestRender()
      else if (raf) {
        cancelAnimationFrame(raf)
        raf = 0
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    // Clique na mesa (não no balão): raio da câmera até o grupo com deskId.
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const deskAt = (e: PointerEvent | MouseEvent): string | null => {
      const r = canvas.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) return null
      pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      raycaster.setFromCamera(pointer, camera)
      for (const hit of raycaster.intersectObject(ctx.content, true)) {
        let o: THREE.Object3D | null = hit.object
        while (o && o.userData.deskId === undefined) o = o.parent
        if (o) return o.userData.deskId as string
      }
      return null
    }
    const onClick = (e: MouseEvent): void => {
      const id = deskAt(e)
      if (id) onPickRef.current(id)
    }
    const onMove = (e: PointerEvent): void => {
      canvas.style.cursor = deskAt(e) ? 'pointer' : ''
    }
    const onLost = (e: Event): void => {
      e.preventDefault()
      onFailRef.current()
    }
    canvas.addEventListener('click', onClick)
    canvas.addEventListener('pointermove', onMove)
    canvas.addEventListener('webglcontextlost', onLost)

    return () => {
      disposed = true
      if (raf) cancelAnimationFrame(raf)
      raf = 0
      ro?.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      canvas.removeEventListener('click', onClick)
      canvas.removeEventListener('pointermove', onMove)
      canvas.removeEventListener('webglcontextlost', onLost)
      // Cena inteira (conteúdo + marcador) e depois as geometrias unitárias.
      disposeTree(scene)
      shared.box.dispose()
      shared.cyl.dispose()
      shared.sphere.dispose()
      scene.clear()
      renderer.dispose()
      renderer.forceContextLoss()
      canvas.remove()
      ctxRef.current = null
    }
  }, [])

  // Reconstrói as mesas só quando o que a cena desenha mudou.
  const signature = useMemo(() => sceneSignature(islands), [islands])
  useEffect(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    buildContent(ctx, islandsRef.current)
  }, [signature])

  // Seleção: move o marcador; nada é refeito.
  useEffect(() => {
    const ctx = ctxRef.current
    if (!ctx) return
    const pos = selectedId ? ctx.deskPos.get(selectedId) : undefined
    ctx.marker.visible = pos !== undefined
    if (pos) ctx.marker.position.set(pos.x, pos.y + 0.01, pos.z + 0.1)
    ctx.requestRender()
  }, [selectedId, signature])

  // Qualquer render pode ter mudado o tamanho ou a hierarquia dos rótulos
  // (ferramenta nova, seleção, mesa que ficou parada): reposiciona no próximo quadro.
  useLayoutEffect(() => {
    ctxRef.current?.invalidateLabels()
  })

  return (
    <div ref={hostRef} className="office-scene">
      <div ref={overlayRef} className="office-overlay">
        {islands.map((island) => (
          <div
            key={island.kind}
            className="office-anchor office-anchor-island"
            data-anchor={`island:${island.kind}`}
            data-role="island"
            data-priority={LABEL_PRIORITY.island}
            style={{ zIndex: LABEL_PRIORITY.island }}
          >
            <IslandLabel island={island} compact />
          </div>
        ))}
        {islands.flatMap((island) =>
          island.desks.map((desk) => {
            const selected = desk.id === selectedId
            const warn = needsAttention(desk.state)
            const priority = deskPriority(desk.state, selected)
            return (
              <div
                key={desk.id}
                className="office-anchor office-anchor-desk"
                data-anchor={`desk:${desk.id}`}
                data-role="desk"
                data-priority={priority}
                data-pinned={warn || selected ? 'true' : undefined}
                data-warn={warn ? 'true' : undefined}
                style={{ zIndex: priority }}
              >
                {showsFullBalloon(desk.state, selected) ? (
                  <DeskBalloon desk={desk} selected={selected} onPick={onPick} />
                ) : (
                  <DeskDot desk={desk} onPick={onPick} />
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Componente público
// ---------------------------------------------------------------------------

export function AgentOffice({ islands, tracks }: { islands: OfficeIsland[]; tracks: TrackMap }): JSX.Element {
  const [webgl, setWebgl] = useState(canUseWebGL)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const pick = useCallback((id: string) => setSelectedId((cur) => (cur === id ? null : id)), [])
  const close = useCallback(() => setSelectedId(null), [])
  const fail = useCallback(() => setWebgl(false), [])

  // A mesa pode sumir (foi para o "+N" ou a trilha foi descartada): some o detalhe junto.
  const selected = useMemo(() => {
    if (!selectedId) return null
    for (const island of islands) for (const d of island.desks) if (d.id === selectedId) return d
    return null
  }, [islands, selectedId])

  return (
    <div className={`office${selected ? ' has-detail' : ''}`}>
      <div className="office-stage">
        {webgl ? (
          <OfficeScene islands={islands} selectedId={selected?.id ?? null} onPick={pick} onFail={fail} />
        ) : (
          <OfficeFallback islands={islands} selectedId={selected?.id ?? null} onPick={pick} />
        )}
      </div>
      {selected && (
        <AgentOfficeDetail
          desk={selected}
          track={selected.trackId ? tracks[selected.trackId] : undefined}
          onClose={close}
        />
      )}
    </div>
  )
}
