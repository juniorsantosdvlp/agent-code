import { useEffect, useRef } from 'react'
import * as THREE from 'three'

// Agente secreto de terno e maleta preta, sentado numa bicicleta, pensando.
// Cena procedural (sem assets): pensa com a mão no queixo, a cabeça inclina, o
// peito respira, a maleta balança no guidão e a nuvem de pensamento pulsa.
// Fica no canto inferior esquerdo da janela e não intercepta cliques.

const LARGURA = 190
const ALTURA = 170

function cilindroEntre(a: THREE.Vector3, b: THREE.Vector3, raio: number, material: THREE.Material): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a)
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(raio, raio, dir.length(), 10), material)
  mesh.position.copy(a).addScaledVector(dir, 0.5)
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize())
  return mesh
}

function texturaNuvem(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = 128
  canvas.height = 96
  const ctx = canvas.getContext('2d')
  if (ctx) {
    const bolhas: [number, number, number][] = [
      [34, 52, 22],
      [60, 38, 26],
      [90, 48, 22],
      [76, 66, 20],
      [46, 68, 18]
    ]
    ctx.fillStyle = '#f4f6fb'
    ctx.strokeStyle = '#8a93a8'
    ctx.lineWidth = 3
    for (const [x, y, r] of bolhas) {
      ctx.beginPath()
      ctx.arc(x, y, r, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }
    for (const [x, y, r] of bolhas) {
      ctx.beginPath()
      ctx.arc(x, y, r - 2, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.fillStyle = '#3a4258'
    ctx.font = 'bold 40px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('?', 64, 54)
  }
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

export function AgenteSecreto(): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    // jsdom (testes) e máquinas sem WebGL: a decoração some em silêncio.
    if (!host || typeof WebGLRenderingContext === 'undefined') return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true })
    } catch {
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(LARGURA, ALTURA)
    renderer.setClearColor(0x000000, 0)
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(32, LARGURA / ALTURA, 0.1, 50)
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2f3d, 1.1))
    const sol = new THREE.DirectionalLight(0xffffff, 1.6)
    sol.position.set(2, 4, 3)
    scene.add(sol)

    const mat = (cor: number, rugosidade = 0.7): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({ color: cor, roughness: rugosidade, metalness: 0.05 })
    const terno = mat(0x161a24)
    const camisa = mat(0xf1f1ee)
    const gravata = mat(0xa3192b)
    const pele = mat(0xe8b898)
    const preto = mat(0x0b0b0d, 0.5)
    const metal = mat(0x9aa3b2, 0.35)
    const pneu = mat(0x1a1a1e)
    const quadro = mat(0x2f6f8f, 0.45)

    const raiz = new THREE.Group()
    scene.add(raiz)

    // ---- bicicleta (de lado, virada para +x) ----
    const bike = new THREE.Group()
    raiz.add(bike)
    for (const x of [-0.75, 0.75]) {
      const roda = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.045, 10, 36), pneu)
      roda.position.set(x, 0.45, 0)
      bike.add(roda)
      const cubo = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 10), metal)
      cubo.rotation.x = Math.PI / 2
      cubo.position.set(x, 0.45, 0)
      bike.add(cubo)
      for (let i = 0; i < 4; i++) {
        const raio = new THREE.Mesh(new THREE.BoxGeometry(0.84, 0.012, 0.012), metal)
        raio.position.set(x, 0.45, 0)
        raio.rotation.z = (i * Math.PI) / 4
        bike.add(raio)
      }
    }
    const pedalier = new THREE.Vector3(0, 0.5, 0)
    const rodaTras = new THREE.Vector3(-0.75, 0.45, 0)
    const rodaFrente = new THREE.Vector3(0.75, 0.45, 0)
    const canoBanco = new THREE.Vector3(-0.28, 1.1, 0)
    const canoDirecao = new THREE.Vector3(0.55, 1.1, 0)
    const tubos: [THREE.Vector3, THREE.Vector3][] = [
      [pedalier, canoBanco],
      [pedalier, canoDirecao],
      [canoBanco, canoDirecao],
      [canoBanco, rodaTras],
      [pedalier, rodaTras],
      [canoDirecao, rodaFrente]
    ]
    for (const [a, b] of tubos) bike.add(cilindroEntre(a, b, 0.032, quadro))
    const banco = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.06, 0.16), preto)
    banco.position.set(-0.3, 1.16, 0)
    bike.add(banco)
    bike.add(cilindroEntre(new THREE.Vector3(0.55, 1.1, 0), new THREE.Vector3(0.5, 1.36, 0), 0.028, metal))
    const guidao = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 0.5, 8), metal)
    guidao.rotation.x = Math.PI / 2
    guidao.position.set(0.5, 1.36, 0)
    bike.add(guidao)
    const pedal = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.03, 0.09), preto)
    pedal.position.set(0.14, 0.32, 0.16)
    bike.add(pedal)
    bike.add(cilindroEntre(pedalier, new THREE.Vector3(0.14, 0.32, 0.1), 0.02, metal))

    // ---- agente ----
    const agente = new THREE.Group()
    raiz.add(agente)
    const tronco = cilindroEntre(new THREE.Vector3(-0.3, 1.26, 0), new THREE.Vector3(-0.1, 1.98, 0), 0.2, terno)
    agente.add(tronco)
    const peitoCamisa = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.16), camisa)
    peitoCamisa.position.set(0.02, 1.7, 0)
    peitoCamisa.rotation.z = -0.24
    agente.add(peitoCamisa)
    const gravataMesh = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.34, 0.05), gravata)
    gravataMesh.position.set(0.055, 1.66, 0)
    gravataMesh.rotation.z = -0.24
    agente.add(gravataMesh)

    // pernas: coxa até o joelho, canela até o pedal (uma de cada lado da bike)
    const joelho = new THREE.Vector3(0.28, 1.05, 0.13)
    const pe = new THREE.Vector3(0.14, 0.4, 0.14)
    agente.add(cilindroEntre(new THREE.Vector3(-0.3, 1.2, 0.12), joelho, 0.105, terno))
    agente.add(cilindroEntre(joelho, pe, 0.085, terno))
    const sapato = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.09, 0.11), preto)
    sapato.position.set(0.2, 0.34, 0.15)
    agente.add(sapato)
    agente.add(cilindroEntre(new THREE.Vector3(-0.3, 1.2, -0.12), new THREE.Vector3(0.05, 0.98, -0.13), 0.1, terno))
    agente.add(cilindroEntre(new THREE.Vector3(0.05, 0.98, -0.13), new THREE.Vector3(-0.08, 0.62, -0.14), 0.082, terno))

    // braço do lado da câmera: do ombro ao guidão
    const maoGuidao = new THREE.Vector3(0.5, 1.36, 0.14)
    agente.add(cilindroEntre(new THREE.Vector3(-0.1, 1.9, 0.19), new THREE.Vector3(0.28, 1.58, 0.2), 0.075, terno))
    agente.add(cilindroEntre(new THREE.Vector3(0.28, 1.58, 0.2), maoGuidao, 0.065, terno))
    const luva = new THREE.Mesh(new THREE.SphereGeometry(0.07, 10, 8), pele)
    luva.position.copy(maoGuidao)
    agente.add(luva)

    // cabeça (inclina) + pescoço
    const cabeca = new THREE.Group()
    cabeca.position.set(0.02, 2.24, 0)
    agente.add(cabeca)
    cabeca.add(new THREE.Mesh(new THREE.SphereGeometry(0.24, 18, 14), pele))
    const cabelo = new THREE.Mesh(new THREE.SphereGeometry(0.255, 18, 12, 0, Math.PI * 2, 0, Math.PI * 0.52), preto)
    cabelo.rotation.z = 0.12
    cabeca.add(cabelo)
    const oculos = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.07, 0.36), preto)
    oculos.position.set(0.2, 0.03, 0)
    cabeca.add(oculos)
    const pescoco = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.09, 0.14, 10), pele)
    pescoco.position.set(-0.02, 2.05, 0)
    agente.add(pescoco)

    // braço pensando: ombro → cotovelo → mão no queixo
    const ombroD = new THREE.Vector3(-0.1, 1.9, -0.19)
    const cotovelo = new THREE.Vector3(0.12, 1.55, -0.12)
    const queixo = new THREE.Vector3(0.14, 2.06, -0.06)
    agente.add(cilindroEntre(ombroD, cotovelo, 0.075, terno))
    const antebraco = new THREE.Group()
    antebraco.position.copy(cotovelo)
    const ateOQueixo = new THREE.Vector3().subVectors(queixo, cotovelo)
    antebraco.add(cilindroEntre(new THREE.Vector3(0, 0, 0), ateOQueixo, 0.065, terno))
    const maoQueixo = new THREE.Mesh(new THREE.SphereGeometry(0.075, 10, 8), pele)
    maoQueixo.position.copy(ateOQueixo)
    antebraco.add(maoQueixo)
    agente.add(antebraco)

    // ---- maleta preta pendurada no guidão ----
    const maleta = new THREE.Group()
    maleta.position.set(0.5, 1.36, -0.16)
    const corpoMaleta = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.36, 0.12), preto)
    corpoMaleta.position.set(0, -0.62, 0)
    maleta.add(corpoMaleta)
    const alca = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.014, 8, 20, Math.PI), metal)
    alca.position.set(0, -0.44, 0)
    maleta.add(alca)
    for (const x of [-0.13, 0.13]) {
      const fecho = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, 0.13), metal)
      fecho.position.set(x, -0.5, 0)
      maleta.add(fecho)
    }
    maleta.add(cilindroEntre(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, -0.34, 0), 0.012, preto))
    raiz.add(maleta)

    // ---- nuvem de pensamento ----
    const texNuvem = texturaNuvem()
    const nuvem = new THREE.Sprite(new THREE.SpriteMaterial({ map: texNuvem, transparent: true }))
    nuvem.position.set(0.85, 3.0, 0)
    nuvem.scale.set(0.9, 0.68, 1)
    raiz.add(nuvem)
    const bolinhas = [0.09, 0.14, 0.2].map((r, i) => {
      const s = new THREE.Mesh(
        new THREE.SphereGeometry(r, 10, 8),
        new THREE.MeshBasicMaterial({ color: 0xf4f6fb, transparent: true })
      )
      s.position.set(0.36 + i * 0.16, 2.58 + i * 0.17, 0.02)
      raiz.add(s)
      return s
    })

    const reduzMovimento = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let quadroAnim = 0
    const inicio = performance.now()

    const desenhar = (agora: number): void => {
      const t = (agora - inicio) / 1000
      // a câmera balança de leve para dar volume
      const giro = 0.35 + Math.sin(t * 0.5) * 0.22
      camera.position.set(Math.sin(giro) * 9.5, 3.4, Math.cos(giro) * 9.5)
      camera.lookAt(0.25, 1.45, 0)

      cabeca.rotation.z = -0.1 + Math.sin(t * 0.9) * 0.06
      cabeca.rotation.y = Math.sin(t * 0.45) * 0.25
      antebraco.rotation.z = Math.sin(t * 1.8) * 0.03
      tronco.scale.set(1 + Math.sin(t * 1.6) * 0.012, 1, 1 + Math.sin(t * 1.6) * 0.012)
      maleta.rotation.z = Math.sin(t * 1.3) * 0.06
      bike.rotation.z = Math.sin(t * 0.7) * 0.004

      const ciclo = (t % 4) / 4
      nuvem.material.opacity = ciclo > 0.25 ? 1 : ciclo / 0.25
      nuvem.position.y = 3.0 + Math.sin(t * 1.4) * 0.05
      bolinhas.forEach((b, i) => {
        ;(b.material as THREE.MeshBasicMaterial).opacity = ciclo > i * 0.08 ? 1 : 0
        b.scale.setScalar(1 + Math.sin(t * 2 + i) * 0.08)
      })
      renderer.render(scene, camera)
    }

    const loop = (agora: number): void => {
      desenhar(agora)
      quadroAnim = requestAnimationFrame(loop)
    }
    if (reduzMovimento) desenhar(performance.now())
    else quadroAnim = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(quadroAnim)
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh
        m.geometry?.dispose?.()
        const material = m.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(material)) material.forEach((x) => x.dispose())
        else material?.dispose?.()
      })
      texNuvem.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return <div ref={hostRef} className="agente-secreto" aria-hidden="true" />
}
