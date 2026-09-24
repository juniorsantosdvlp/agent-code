import { useEffect, useRef } from 'react'
import * as THREE from 'three'

// Agente secreto gordinho, de terno, pele clara e cabelo preto, numa bicicleta
// no canto inferior esquerdo. Acompanha o trabalho do Agent Code:
//  - parado: sentado com a maleta à frente, só balançando a cabeça;
//  - trabalhando (algum agente ocupado): pedala e vai emagrecendo aos poucos;
//  - trabalho concluído: para e descansa um tempo, ofegante;
//  - depois do descanso (ou num prompt novo) recupera o peso e o ciclo recomeça.
// Cena procedural (sem assets) e sem capturar cliques.

const LARGURA = 230
const ALTURA = 205

const DESCANSO_S = 20 // quanto tempo descansa depois que o trabalho acaba
const MAGRO = 0.3 // "gordura" mínima, perto da qual ele estaciona trabalhando
const MEIA_VIDA_EMAGRECER_S = 45

const EIXO_Y = new THREE.Vector3(0, 1, 0)
const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z)

// Membros são cilindros unitários reposicionados a cada quadro (pernas seguem
// o pedal, braços vão da maleta ao guidão) — mais simples que um esqueleto.
const CILINDRO = new THREE.CylinderGeometry(1, 1, 1, 14)
const ESFERA = new THREE.SphereGeometry(1, 16, 12)
const tmp = new THREE.Vector3()

function ligar(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, raio: number): void {
  tmp.subVectors(b, a)
  const comprimento = tmp.length()
  mesh.position.copy(a).addScaledVector(tmp, 0.5)
  mesh.quaternion.setFromUnitVectors(EIXO_Y, tmp.normalize())
  mesh.scale.set(raio, comprimento, raio)
}

function cilindroFixo(a: THREE.Vector3, b: THREE.Vector3, raio: number, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(CILINDRO, material)
  ligar(mesh, a, b, raio)
  return mesh
}

// Joelho por cinemática inversa de dois ossos, no plano da bicicleta (x, y),
// dobrando para a frente (+x).
function joelhoEntre(quadril: THREE.Vector3, pe: THREE.Vector3, coxa: number, canela: number): THREE.Vector3 {
  const dx = pe.x - quadril.x
  const dy = pe.y - quadril.y
  const d = Math.min(Math.hypot(dx, dy), coxa + canela - 0.001)
  const ang = Math.acos(Math.min(1, Math.max(-1, (coxa * coxa + d * d - canela * canela) / (2 * coxa * d))))
  const base = Math.atan2(dy, dx) + ang
  return v(quadril.x + Math.cos(base) * coxa, quadril.y + Math.sin(base) * coxa, (quadril.z + pe.z) / 2)
}

const suave = (atual: number, alvo: number, velocidade: number, dt: number): number =>
  atual + (alvo - atual) * Math.min(1, velocidade * dt)

export function AgenteSecreto({ trabalhando = false }: { trabalhando?: boolean }): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const trabalhandoRef = useRef(trabalhando)
  trabalhandoRef.current = trabalhando

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
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, LARGURA / ALTURA, 0.1, 50)
    camera.position.set(Math.sin(0.5) * 9.6, 3.1, Math.cos(0.5) * 9.6)
    camera.lookAt(0.1, 1.4, 0)

    scene.add(new THREE.HemisphereLight(0xeef2ff, 0x3a3530, 0.9))
    const chave = new THREE.DirectionalLight(0xfff4e6, 2.2)
    chave.position.set(3, 5, 4)
    scene.add(chave)
    const contra = new THREE.DirectionalLight(0x9fb4ff, 1.1)
    contra.position.set(-4, 3, -3)
    scene.add(contra)

    const mat = (cor: number, rugosidade = 0.7, metal = 0): THREE.MeshStandardMaterial =>
      new THREE.MeshStandardMaterial({ color: cor, roughness: rugosidade, metalness: metal })
    const terno = mat(0x1d2330, 0.85)
    const camisa = mat(0xf4f4f1, 0.6)
    const gravata = mat(0x14161c, 0.5)
    const pele = mat(0xf3dccb, 0.55)
    const cabeloMat = mat(0x0c0b0b, 0.45)
    const olhoMat = mat(0x1a1410, 0.3)
    const couro = mat(0x0b0b0d, 0.32, 0.1)
    const sapatoMat = mat(0x0a0a0a, 0.25, 0.1)
    const cromo = mat(0xc9ced6, 0.22, 0.9)
    const borracha = mat(0x151517, 0.9)
    const quadro = mat(0x24313f, 0.35, 0.4)

    const raiz = new THREE.Group()
    scene.add(raiz)
    const bike = new THREE.Group() // balança junto com a pedalada
    raiz.add(bike)

    // sombra suave no chão
    const sombra = new THREE.Mesh(
      new THREE.CircleGeometry(1, 40),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false })
    )
    sombra.rotation.x = -Math.PI / 2
    sombra.scale.set(1.45, 0.4, 1)
    sombra.position.y = 0.005
    raiz.add(sombra)

    // riscos no chão que passam para trás quando ele pedala
    const riscoMat = new THREE.MeshBasicMaterial({ color: 0x9aa3b2, transparent: true, opacity: 0 })
    const riscos = [-0.35, 0.3, -0.1, 0.45, 0.1].map((z, i) => {
      const r = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.008, 0.012), riscoMat)
      r.position.set(-1.6 + i * 0.7, 0.01, z)
      raiz.add(r)
      return r
    })

    // ---- bicicleta (de lado, virada para +x) ----
    const rodas = [-0.75, 0.75].map((x) => {
      const roda = new THREE.Group()
      roda.position.set(x, 0.46, 0)
      roda.add(new THREE.Mesh(new THREE.TorusGeometry(0.41, 0.05, 14, 48), borracha))
      roda.add(new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.014, 8, 48), cromo))
      const cubo = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 12), cromo)
      cubo.rotation.x = Math.PI / 2
      roda.add(cubo)
      for (let i = 0; i < 12; i++) {
        const raio = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.72, 4), cromo)
        raio.rotation.z = (i * Math.PI) / 12
        roda.add(raio)
      }
      bike.add(roda)
      return roda
    })
    const pedalier = v(0, 0.5, 0)
    const canoBanco = v(-0.28, 1.08, 0)
    const canoDirecao = v(0.55, 1.08, 0)
    const tubos: [THREE.Vector3, THREE.Vector3, number][] = [
      [pedalier, canoBanco, 0.03],
      [pedalier, canoDirecao, 0.034],
      [canoBanco, canoDirecao, 0.028],
      [canoBanco, v(-0.75, 0.46, 0), 0.018],
      [pedalier, v(-0.75, 0.46, 0), 0.02],
      [canoDirecao, v(0.75, 0.46, 0), 0.024]
    ]
    for (const [a, b, r] of tubos) bike.add(cilindroFixo(a, b, r, quadro))
    const coroa = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.012, 8, 32), cromo)
    coroa.position.set(0, 0.5, 0.06)
    bike.add(coroa)
    const banco = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.2, 4, 10), couro)
    banco.rotation.z = Math.PI / 2
    banco.scale.set(1, 1, 1.3)
    banco.position.set(-0.3, 1.15, 0)
    bike.add(banco)
    bike.add(cilindroFixo(canoDirecao, v(0.5, 1.34, 0), 0.022, cromo))
    bike.add(cilindroFixo(v(0.5, 1.34, -0.26), v(0.5, 1.34, 0.26), 0.02, cromo))
    for (const z of [-0.24, 0.24]) {
      const manopla = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.1, 10), borracha)
      manopla.rotation.x = Math.PI / 2
      manopla.position.set(0.5, 1.34, z)
      bike.add(manopla)
    }
    // pedivela e pedais (posições atualizadas a cada quadro)
    const pedivelas = [0, 1].map(() => {
      const m = new THREE.Mesh(CILINDRO, cromo)
      bike.add(m)
      return m
    })
    const pedais = [0, 1].map(() => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.025, 0.08), sapatoMat)
      bike.add(m)
      return m
    })

    // ---- agente ----
    // corpo (tronco, barriga, cabeça) gira em torno do quadril para inclinar
    const corpo = new THREE.Group()
    corpo.position.set(-0.28, 1.24, 0)
    bike.add(corpo)
    const L = (x: number, y: number, z: number): THREE.Vector3 => v(x + 0.28, y - 1.24, z)

    const tronco = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.42, 6, 18), terno)
    tronco.position.copy(L(-0.24, 1.6, 0))
    tronco.rotation.z = -0.1
    corpo.add(tronco)
    const barriga = new THREE.Mesh(ESFERA, terno)
    corpo.add(barriga)
    const peito = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.3), camisa)
    peito.rotation.y = Math.PI / 2
    corpo.add(peito)
    const gravataMesh = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.28, 0.055), gravata)
    corpo.add(gravataMesh)
    const lapelas = [-0.07, 0.07].map((z) => {
      const lapela = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.28, 0.06), terno)
      lapela.rotation.x = z > 0 ? -0.35 : 0.35
      corpo.add(lapela)
      return { lapela, z }
    })

    const pescoco = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.16, 14), pele)
    pescoco.position.copy(L(-0.17, 2.0, 0))
    corpo.add(pescoco)
    const colarinho = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.02, 8, 20), camisa)
    colarinho.rotation.x = Math.PI / 2
    colarinho.position.copy(L(-0.17, 1.94, 0))
    corpo.add(colarinho)

    const cabeca = new THREE.Group()
    cabeca.position.copy(L(-0.17, 2.06, 0)) // pivô na nuca, para o aceno parecer natural
    corpo.add(cabeca)
    const cranio = new THREE.Mesh(new THREE.SphereGeometry(0.19, 28, 22), pele)
    cranio.scale.set(1.02, 1.14, 0.9)
    cranio.position.set(0.02, 0.19, 0)
    cabeca.add(cranio)
    const queixo = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), pele)
    queixo.position.set(0.08, 0.06, 0)
    cabeca.add(queixo)
    const bochechas = [-0.1, 0.1].map((z) => {
      const b = new THREE.Mesh(ESFERA, pele)
      b.position.set(0.1, 0.11, z)
      cabeca.add(b)
      return b
    })
    const cabelo = new THREE.Mesh(
      new THREE.SphereGeometry(0.2, 28, 18, 0, Math.PI * 2, 0, Math.PI * 0.5),
      cabeloMat
    )
    cabelo.scale.set(1.06, 1.08, 0.95)
    cabelo.rotation.z = 0.28
    cabelo.position.set(0, 0.22, 0)
    cabeca.add(cabelo)
    const nuca = new THREE.Mesh(new THREE.SphereGeometry(0.17, 20, 14), cabeloMat)
    nuca.scale.set(0.7, 0.9, 0.98)
    nuca.position.set(-0.07, 0.2, 0)
    cabeca.add(nuca)
    for (const z of [-0.17, 0.17]) {
      const orelha = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), pele)
      orelha.scale.set(0.8, 1.2, 0.45)
      orelha.position.set(0, 0.17, z)
      cabeca.add(orelha)
      const olho = new THREE.Mesh(new THREE.SphereGeometry(0.018, 10, 8), olhoMat)
      olho.position.set(0.195, 0.2, z * 0.4)
      cabeca.add(olho)
      const sobrancelha = new THREE.Mesh(new THREE.BoxGeometry(0.015, 0.014, 0.06), cabeloMat)
      sobrancelha.position.set(0.19, 0.245, z * 0.42)
      cabeca.add(sobrancelha)
    }
    const nariz = new THREE.Mesh(new THREE.ConeGeometry(0.028, 0.08, 10), pele)
    nariz.rotation.z = -Math.PI / 2 - 0.3
    nariz.position.set(0.215, 0.15, 0)
    cabeca.add(nariz)
    const boca = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.008, 0.06), mat(0xb07a6c, 0.6))
    boca.position.set(0.185, 0.09, 0)
    cabeca.add(boca)

    // membros dinâmicos
    const membro = (material: THREE.Material): THREE.Mesh => {
      const m = new THREE.Mesh(CILINDRO, material)
      bike.add(m)
      return m
    }
    const junta = (material: THREE.Material): THREE.Mesh => {
      const m = new THREE.Mesh(ESFERA, material)
      bike.add(m)
      return m
    }
    const pernas = [1, -1].map((lado) => {
      const sapato = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.14, 4, 10), sapatoMat)
      sapato.rotation.z = Math.PI / 2
      bike.add(sapato)
      return { lado, coxa: membro(terno), canela: membro(terno), joelho: junta(terno), quadril: junta(terno), sapato }
    })
    const bracos = [1, -1].map((lado) => ({
      lado,
      braco: membro(terno),
      antebraco: membro(terno),
      ombro: junta(terno),
      cotovelo: junta(terno),
      punho: membro(camisa),
      mao: junta(pele)
    }))

    // maleta preta: à frente, sobre as coxas (parado) ou pendurada no guidão (pedalando)
    const maleta = new THREE.Group()
    maleta.add(new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.36, 0.52), couro))
    const friso = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.012, 0.525), mat(0x1c1c20, 0.4))
    friso.position.y = 0.12
    maleta.add(friso)
    const alca = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.014, 8, 20, Math.PI), couro)
    alca.rotation.y = Math.PI / 2
    alca.position.y = 0.18
    maleta.add(alca)
    for (const z of [-0.15, 0.15]) {
      const fecho = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.035, 0.05), cromo)
      fecho.position.set(0.058, 0.12, z)
      maleta.add(fecho)
    }
    bike.add(maleta)

    // ---- estado ----
    type Fase = 'parado' | 'trabalhando' | 'descansando'
    let fase: Fase = 'parado'
    let gordura = 1 // 1 = gordinho; cai até perto de MAGRO enquanto trabalha
    let recuperando = false
    let inicioDescanso = 0
    let pedalar = 0 // 0 parado … 1 pedalando (transição suave)
    let descansar = 0
    let angPedal = -0.9
    let t = 0
    let ultimo = performance.now()

    const reduzMovimento = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let quadroAnim = 0

    const aplicarPose = (): void => {
      const g = gordura
      // corpo e barriga
      corpo.rotation.z = -0.22 * pedalar + 0.06 * descansar
      const folego = descansar * Math.sin(t * 3.2) * 0.035 + (1 - descansar) * Math.sin(t * 1.6) * 0.01
      tronco.scale.set((0.8 + 0.28 * g) * (1 + folego), 1, (1.25 + 0.3 * g) * (1 + folego))
      barriga.scale.set(0.12 + 0.13 * g, 0.2 + 0.07 * g, 0.2 + 0.1 * g)
      barriga.position.copy(L(-0.17 + 0.07 * g, 1.46, 0))
      const frente = -0.08 + 0.07 * g
      peito.position.copy(L(frente, 1.8, 0))
      gravataMesh.position.copy(L(frente + 0.01, 1.76, 0))
      gravataMesh.rotation.z = -0.25 * g
      for (const { lapela, z } of lapelas) lapela.position.copy(L(frente + 0.015, 1.8, z))
      for (const b of bochechas) b.scale.setScalar(0.035 + 0.045 * g)
      queixo.scale.set(1, 0.8, 1.1 + 0.3 * g)

      bike.updateMatrixWorld(true)
      const noCorpo = (p: THREE.Vector3): THREE.Vector3 => bike.worldToLocal(corpo.localToWorld(p.clone()))

      // pernas seguem os pedais
      pernas.forEach((perna, i) => {
        const a = angPedal + i * Math.PI
        const pedal = v(Math.cos(a) * 0.17, 0.5 + Math.sin(a) * 0.17, 0.15 * perna.lado)
        ligar(pedivelas[i], v(0, 0.5, 0.08 * perna.lado), pedal, 0.014)
        pedais[i].position.copy(pedal)
        const quadril = noCorpo(L(-0.28, 1.24, 0.12 * perna.lado))
        const pe = pedal.clone().add(v(0, 0.06, 0))
        const joelho = joelhoEntre(quadril, pe, 0.56, 0.62)
        const rCoxa = 0.1 * (1 + 0.55 * g)
        const rCanela = 0.075 * (1 + 0.35 * g)
        ligar(perna.coxa, quadril, joelho, rCoxa)
        ligar(perna.canela, joelho, pe, rCanela)
        perna.quadril.position.copy(quadril)
        perna.quadril.scale.setScalar(rCoxa)
        perna.joelho.position.copy(joelho)
        perna.joelho.scale.setScalar(rCanela * 1.08)
        perna.sapato.position.set(pe.x + 0.05, pe.y - 0.045, pe.z)
      })

      // maleta e mãos: da alça da maleta (parado) para as manoplas (pedalando)
      maleta.position.copy(v(0.12, 1.36, 0)).lerp(v(0.64, 0.98, 0), pedalar)
      maleta.rotation.z = Math.sin(t * 5) * 0.05 * pedalar
      bracos.forEach((b) => {
        const ombro = noCorpo(L(-0.22, 1.86, 0.22 * b.lado))
        const mao = v(0.12, 1.56, 0.06 * b.lado).lerp(v(0.5, 1.36, 0.24 * b.lado), pedalar)
        const cotovelo = ombro.clone().lerp(mao, 0.5).add(v(-0.06, -0.14, 0.07 * b.lado))
        const rBraco = 0.07 * (1 + 0.45 * g)
        const rAnte = 0.062 * (1 + 0.3 * g)
        ligar(b.braco, ombro, cotovelo, rBraco)
        ligar(b.antebraco, cotovelo, mao, rAnte)
        b.ombro.position.copy(ombro)
        b.ombro.scale.setScalar(rBraco)
        b.cotovelo.position.copy(cotovelo)
        b.cotovelo.scale.setScalar(rAnte * 1.05)
        ligar(b.punho, cotovelo.clone().lerp(mao, 0.86), mao, 0.05 + 0.01 * g)
        b.mao.position.copy(mao)
        b.mao.scale.set(0.06, 0.045, 0.055)
      })

      // cabeça: acena parado, firme pedalando, ofegante olhando para cima descansando
      const quieto = Math.max(0, 1 - pedalar - descansar)
      const aceno = -0.04 - Math.sin(t * 2.1) * 0.13
      const firme = 0.12 + Math.sin(t * 9) * 0.02
      const ofegante = 0.2 + Math.sin(t * 3.2) * 0.06
      cabeca.rotation.z = aceno * quieto + firme * pedalar + ofegante * descansar
      cabeca.rotation.x = Math.sin(t * 1.05) * 0.05 * quieto
    }

    const desenhar = (agora: number): void => {
      const dt = Math.min(0.1, (agora - ultimo) / 1000)
      ultimo = agora
      t += dt

      // máquina de estados
      const ocupado = trabalhandoRef.current
      if (ocupado && fase !== 'trabalhando') {
        // prompt novo durante o descanso: recomeça o ciclo gordinho
        if (fase === 'descansando') recuperando = true
        fase = 'trabalhando'
      } else if (!ocupado && fase === 'trabalhando') {
        fase = 'descansando'
        inicioDescanso = t
      } else if (fase === 'descansando' && t - inicioDescanso > DESCANSO_S) {
        fase = 'parado'
        recuperando = true
      }

      if (recuperando) {
        gordura = Math.min(1, gordura + dt * (fase === 'trabalhando' ? 1.2 : 0.35))
        if (gordura >= 1) recuperando = false
      } else if (fase === 'trabalhando') {
        const k = Math.LN2 / MEIA_VIDA_EMAGRECER_S
        gordura = Math.max(MAGRO, gordura - (gordura - MAGRO + 0.02) * k * dt)
      }

      pedalar = suave(pedalar, fase === 'trabalhando' ? 1 : 0, 2.5, dt)
      descansar = suave(descansar, fase === 'descansando' ? 1 : 0, 2, dt)

      // com "reduzir movimento" ele muda de pose e de peso, mas sem girar nada
      const velocidade = reduzMovimento ? 0 : pedalar * 6.5 // rad/s das rodas
      for (const roda of rodas) roda.rotation.z -= velocidade * dt
      angPedal -= velocidade * 0.6 * dt
      bike.position.y = Math.abs(Math.sin(angPedal * 2)) * 0.012 * pedalar
      riscoMat.opacity = reduzMovimento ? 0 : 0.45 * pedalar
      for (const r of riscos) {
        r.position.x -= velocidade * 0.41 * dt
        if (r.position.x < -1.8) r.position.x += 3.6
      }

      aplicarPose()
      renderer.render(scene, camera)
    }

    const loop = (agora: number): void => {
      desenhar(agora)
      quadroAnim = requestAnimationFrame(loop)
    }
    quadroAnim = requestAnimationFrame(loop)

    return () => {
      cancelAnimationFrame(quadroAnim)
      const geometrias = new Set<THREE.BufferGeometry>()
      const materiais = new Set<THREE.Material>()
      scene.traverse((obj) => {
        const m = obj as THREE.Mesh
        if (m.geometry && m.geometry !== CILINDRO && m.geometry !== ESFERA) geometrias.add(m.geometry)
        const material = m.material as THREE.Material | THREE.Material[] | undefined
        if (Array.isArray(material)) material.forEach((x) => materiais.add(x))
        else if (material) materiais.add(material)
      })
      geometrias.forEach((g) => g.dispose())
      materiais.forEach((x) => x.dispose())
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return <div ref={hostRef} className="agente-secreto" aria-hidden="true" />
}
