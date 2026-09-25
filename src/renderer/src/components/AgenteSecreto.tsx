import { useEffect, useRef } from 'react'
import * as THREE from 'three'

// Agente secreto gordinho, de terno, pele clara e cabelo preto, numa bicicleta
// no canto inferior esquerdo. Acompanha o trabalho do Agent Code:
//  - parado: sentado com a maleta à frente, só balançando a cabeça;
//  - trabalhando (algum agente ocupado): pedala e vai emagrecendo aos poucos;
//  - trabalho concluído: para e descansa um tempo, ofegante;
//  - depois do descanso (ou num prompt novo) recupera o peso e o ciclo recomeça.
// Clicar nele e segurar o botão: o ponteiro o pega pela gola e ele pode ser
// levado pela tela, pendurado e balançando como pêndulo, só as pernas se
// debatendo — enquanto a bicicleta sai andando sozinha até sumir pela direita.
// Ao soltar ele cai sentado no chão onde estiver, se levanta zonzo e vai a pé
// até a bicicleta, que ficou fora da tela; volta pelo canto direito pedalando.
// Cena procedural (sem assets). Fora o próprio boneco, não captura cliques.

const LARGURA = 230
const ALTURA = 205

const DESCANSO_S = 20 // quanto tempo descansa depois que o trabalho acaba
const MAGRO = 0.3 // "gordura" mínima, perto da qual ele estaciona trabalhando
const MEIA_VIDA_EMAGRECER_S = 45

// a pegadinha da gola
const LEVANTA = 0.8 // altura mínima da gola acima da de casa: pego, ele sempre sai do banco
const PENDULO = 1.1 // da gola ao centro do corpo, para o balanço
const VEL_CASA = 9 // pedalando de volta para o canto (freia ao chegar), em unidades/s
const VEL_ANDAR = 3.2 // a pé até a bicicleta, em unidades/s
const PASSO = 0.3 // meia passada
const Y_PE = -0.14 // deslocamento do agente em pé (quadril a ~1,1 do solo)
const LEVANTAR_S = 0.7
const VIRAR_S = 0.7 // meia-volta da bicicleta ao chegar em casa
const Y_CHAO = -0.98 // deslocamento do agente sentado no chão (quadril a ~0,26 do solo)
const GRAVIDADE = 16
const RUMO_FUGA = 0.5 // guinada da bicicleta: anda paralela à tela, sem crescer
const RAIO_RODA = 0.46

const EIXO_Y = new THREE.Vector3(0, 1, 0)
const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z)
const DIRECAO_FUGA = v(Math.cos(RUMO_FUGA), 0, -Math.sin(RUMO_FUGA))
const RUMO_VOLTA = Math.PI + RUMO_FUGA // de frente para a esquerda

// Membros são cilindros unitários reposicionados a cada quadro (pernas seguem
// o pedal, braços vão da maleta ao guidão) — mais simples que um esqueleto.
const CILINDRO = new THREE.CylinderGeometry(1, 1, 1, 14)
const ESFERA = new THREE.SphereGeometry(1, 16, 12)
const tmp = new THREE.Vector3()

// Nunca deixa o membro esticar além do comprimento: com a bicicleta fugindo,
// o pedal (ou o guidão) pode estar do outro lado da tela.
function alcance(origem: THREE.Vector3, alvo: THREE.Vector3, maximo: number): THREE.Vector3 {
  tmp.subVectors(alvo, origem)
  if (tmp.length() > maximo) alvo.copy(origem).addScaledVector(tmp.normalize(), maximo)
  return alvo
}

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
const lerp = THREE.MathUtils.lerp
const saida = (u: number): number => 1 - (1 - Math.min(1, Math.max(0, u))) ** 3

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
    // Câmera ortográfica com o mesmo enquadramento da perspectiva de 30° que
    // havia aqui: sem ponto de fuga, o boneco não deforma quando a pegadinha
    // estica o canvas pela janela inteira (em perspectiva, longe do canto ele
    // ficava gigante e o pescoço e a cabeça esticavam).
    const alvoCamera = v(0.1, 1.4, 0)
    const posCamera = v(Math.sin(0.5) * 9.6, 3.1, Math.cos(0.5) * 9.6)
    const meiaAltura = posCamera.distanceTo(alvoCamera) * Math.tan(THREE.MathUtils.degToRad(15))
    const meiaLargura = (meiaAltura * LARGURA) / ALTURA
    const camera = new THREE.OrthographicCamera(-meiaLargura, meiaLargura, meiaAltura, -meiaAltura, 0.1, 80)
    camera.position.copy(posCamera)
    camera.lookAt(alvoCamera)

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
    const bike = new THREE.Group() // balança junto com a pedalada; foge sozinha na pegadinha
    raiz.add(bike)
    // o agente é irmão da bicicleta, não filho: assim pode ser erguido sem ela
    const agente = new THREE.Group()
    raiz.add(agente)

    // sombra suave no chão (da bicicleta) e a do agente, que só aparece quando os dois se separam
    const sombraMat = (): THREE.MeshBasicMaterial =>
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false })
    const sombra = new THREE.Mesh(new THREE.CircleGeometry(1, 40), sombraMat())
    sombra.rotation.x = -Math.PI / 2
    sombra.scale.set(1.45, 0.4, 1)
    sombra.position.y = 0.005
    raiz.add(sombra)
    const sombraAgente = new THREE.Mesh(new THREE.CircleGeometry(1, 32), sombraMat())
    sombraAgente.rotation.x = -Math.PI / 2
    sombraAgente.position.y = 0.006
    sombraAgente.visible = false
    raiz.add(sombraAgente)

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
    agente.add(corpo)
    const L = (x: number, y: number, z: number): THREE.Vector3 => v(x + 0.28, y - 1.24, z)
    const GOLA = L(-0.27, 1.97, 0) // atrás do pescoço, onde a mão agarra

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
      agente.add(m)
      return m
    }
    const junta = (material: THREE.Material): THREE.Mesh => {
      const m = new THREE.Mesh(ESFERA, material)
      agente.add(m)
      return m
    }
    const pernas = [1, -1].map((lado) => {
      const sapato = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.14, 4, 10), sapatoMat)
      sapato.rotation.z = Math.PI / 2
      agente.add(sapato)
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

    // maleta preta: à frente, sobre as coxas (parado), pendurada no guidão
    // (pedalando) ou presa na mão dele (pendurado pela gola)
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
    agente.add(maleta)

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

    // pegadinha: 'nenhum' → 'agarrado' (botão pressionado) → 'caindo' → 'sentado'
    // → 'levantando' → 'andando' (a pé até sair pela direita) → 'buscando' (fora da tela,
    // pega a bicicleta) → 'voltandoCasa' (pedalando) → 'virando' → 'nenhum'
    type Pegadinha =
      | 'nenhum'
      | 'agarrado'
      | 'caindo'
      | 'sentado'
      | 'levantando'
      | 'andando'
      | 'buscando'
      | 'voltandoCasa'
      | 'virando'
    let pegadinha: Pegadinha = 'nenhum'
    let tPegadinha = 0
    type Bicicleta = 'casa' | 'saindo' | 'fora' | 'montada'
    let bicicleta: Bicicleta = 'casa'
    let bikeS = 0 // posição da bicicleta na linha paralela à tela (0 = casa)
    let bikeV = 0
    let sFora = 40 // posição em que a bicicleta some pela direita (medida ao agarrar)
    let pendurado = 0 // peso da pose "pendurado pela gola"
    let noChao = 0 // peso da pose "sentado no chão"
    let emPe = 0 // peso da pose "em pé / andando"
    let andar = 0 // 0 parado em pé … 1 dando passos
    let passo = 0 // fase da passada
    let andado = 0 // quanto já andou desde onde caiu
    let tontura = 0
    // arrasto: a gola segue o ponteiro num plano paralelo à tela, passando pela gola de casa
    const golaCasa = v(0, 0, 0)
    const gola = v(0, 0, 0) // onde a gola está agora (suavizada)
    const pegaOffset = v(0, 0, 0) // some aos poucos: a gola escorrega até a ponta do ponteiro
    const planoArrasto = new THREE.Plane()
    const ponteiroTela = { x: 0, y: 0, valido: false }
    let theta = 0 // balanço do pêndulo
    let omega = 0
    let velAnterior = 0
    let sAnterior = 0
    const queda = v(0, 0, 0) // posição horizontal do agente solto (caindo / no chão)
    let agenteY = 0
    let agenteVy = 0
    let agenteRot = 0
    let expandido = false

    const reduzMovimento = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let quadroAnim = 0

    const golaNoAgente = (): THREE.Vector3 => {
      corpo.updateMatrix()
      return GOLA.clone().applyMatrix4(corpo.matrix)
    }

    // Durante a pegadinha o canvas cobre a janela inteira (a bicicleta precisa
    // atravessar a tela e ele pode ser levado até o alto). setViewOffset só estende o
    // enquadramento para a direita e para cima: o canto de sempre fica idêntico.
    const expandir = (ligado: boolean): void => {
      expandido = ligado
      if (!ligado) {
        host.style.width = ''
        host.style.height = ''
        renderer.setSize(LARGURA, ALTURA)
        camera.clearViewOffset()
        return
      }
      const w = Math.max(LARGURA, window.innerWidth - 8)
      const h = Math.max(ALTURA, window.innerHeight - 8)
      host.style.width = `${w}px`
      host.style.height = `${h}px`
      renderer.setSize(w, h)
      camera.setViewOffset(LARGURA, ALTURA, 0, -(h - ALTURA), w, h)
      camera.updateMatrixWorld()
      // onde a traseira da bicicleta e a sombra (1,6 atrás do centro) já passaram da borda direita
      const ponto = v(0, 0, 0)
      sFora = 3
      while (sFora < 200) {
        ponto.copy(DIRECAO_FUGA).multiplyScalar(sFora - 1.6).setY(0.8)
        if (ponto.project(camera).x > 1.02) break
        sFora += 0.5
      }
    }

    const aplicarPose = (dt: number): void => {
      const g = gordura
      const p = pendurado
      // corpo e barriga
      const inclinacao = -0.22 * pedalar + 0.06 * descansar
      const emPeInclinado = lerp(lerp(inclinacao, 0.15, noChao), -0.06 - 0.03 * andar, emPe)
      corpo.rotation.z = lerp(emPeInclinado, Math.sin(t * 6) * 0.05, p)
      const folego = descansar * Math.sin(t * 3.2) * 0.035 + (1 - descansar) * Math.sin(t * 1.6) * 0.01
      tronco.scale.set((0.8 + 0.28 * g) * (1 + folego), 1, (1.25 + 0.3 * g) * (1 + folego))
      barriga.scale.set(0.14 + 0.08 * g, 0.24 + 0.04 * g, 0.22 + 0.08 * g)
      barriga.position.copy(L(-0.19 + 0.05 * g, 1.48, 0))
      const frente = -0.08 + 0.07 * g
      peito.position.copy(L(frente, 1.8, 0))
      gravataMesh.position.copy(L(frente + 0.01, 1.76, 0))
      gravataMesh.rotation.z = -0.25 * g
      for (const { lapela, z } of lapelas) lapela.position.copy(L(frente + 0.015, 1.8, z))
      // engorda por inteiro: rosto e pescoço alargam junto com o corpo
      cranio.scale.set(1.02 + 0.08 * g, 1.14, 0.9 + 0.12 * g)
      queixo.scale.set(1 + 0.1 * g, 0.8, 1.1 + 0.15 * g)
      pescoco.scale.set(1 + 0.25 * g, 1, 1 + 0.25 * g)

      // onde o agente está: no banco, pendurado pela gola ou solto (caindo / no chão / pulando)
      if (pegadinha === 'nenhum' || pegadinha === 'voltandoCasa' || pegadinha === 'virando') {
        agente.position.copy(bike.position)
        agente.rotation.set(0, bike.rotation.y, 0)
      } else if (pegadinha === 'agarrado') {
        // gira em torno da gola, presa na ponta do ponteiro
        const c = golaNoAgente()
        const cs = Math.cos(theta)
        const sn = Math.sin(theta)
        agente.rotation.set(0, 0, theta)
        agente.position.set(gola.x - (c.x * cs - c.y * sn), gola.y - (c.x * sn + c.y * cs), gola.z - c.z)
      } else {
        // solto: caído, levantando ou a pé, sempre a partir de onde caiu;
        // em pé ele se vira de lado para a tela, na direção da bicicleta
        agenteRot = suave(agenteRot, 0, 6, dt)
        agente.position.set(queda.x, agenteY, queda.z).addScaledVector(DIRECAO_FUGA, andado)
        agente.rotation.set(0, RUMO_FUGA * emPe, agenteRot)
      }

      agente.visible = pegadinha !== 'buscando' // lá fora da tela, pegando a bicicleta
      raiz.updateMatrixWorld(true)
      const noCorpo = (q: THREE.Vector3): THREE.Vector3 => agente.worldToLocal(corpo.localToWorld(q.clone()))
      const daBike = (q: THREE.Vector3): THREE.Vector3 => agente.worldToLocal(bike.localToWorld(q.clone()))
      const chaoY = -agente.position.y

      // pernas: seguem os pedais, esticam para a frente no chão ou balançam penduradas
      pernas.forEach((perna, i) => {
        const a = angPedal + i * Math.PI
        const pedal = v(Math.cos(a) * 0.17, 0.5 + Math.sin(a) * 0.17, 0.15 * perna.lado)
        ligar(pedivelas[i], v(0, 0.5, 0.08 * perna.lado), pedal, 0.014)
        pedais[i].position.copy(pedal)
        const quadril = noCorpo(L(-0.28, 1.24, 0.12 * perna.lado))
        const pe = daBike(pedal).add(v(0, 0.06, 0))
        if (noChao > 0) pe.lerp(v(quadril.x + 0.92, chaoY + 0.07, 0.17 * perna.lado), noChao)
        if (emPe > 0) {
          // em pé os pés ficam sob o quadril; andando, um vai à frente enquanto o outro sobe
          const fasePasso = passo + i * Math.PI
          const ergue = Math.max(0, Math.cos(fasePasso)) * 0.14 * andar
          pe.lerp(v(quadril.x + Math.sin(fasePasso) * PASSO * andar, chaoY + 0.07 + ergue, 0.13 * perna.lado), emPe)
        }
        if (p > 0) {
          const chute = t * 7.5 + i * Math.PI
          const ang = 0.1 + 0.35 * Math.sin(chute)
          const comp = 1.04 + 0.08 * Math.sin(chute + 1)
          pe.lerp(v(quadril.x + Math.sin(ang) * comp, quadril.y - Math.cos(ang) * comp, 0.14 * perna.lado), p)
        }
        alcance(quadril, pe, 1.16)
        const joelho = joelhoEntre(quadril, pe, 0.56, 0.62)
        const rCoxa = 0.1 * (1 + 0.4 * g)
        const rCanela = 0.075 * (1 + 0.4 * g)
        ligar(perna.coxa, quadril, joelho, rCoxa)
        ligar(perna.canela, joelho, pe, rCanela)
        perna.quadril.position.copy(quadril)
        perna.quadril.scale.setScalar(rCoxa)
        perna.joelho.position.copy(joelho)
        perna.joelho.scale.setScalar(rCanela)
        perna.sapato.position.set(pe.x + 0.05, pe.y - 0.045, pe.z)
        perna.sapato.rotation.z = Math.PI / 2 - 0.55 * p // pendurado, a ponta do pé cai
      })

      // mãos: da alça da maleta (parado) para as manoplas (pedalando); penduradas, se debatem
      const maoDaMaleta = v(0, 0, 0)
      bracos.forEach((b) => {
        const ombro = noCorpo(L(-0.22, 1.86, 0.22 * b.lado))
        const mao = v(0.12, 1.56, 0.06 * b.lado).lerp(daBike(v(0.5, 1.36, 0.24 * b.lado)), pedalar)
        if (emPe > 0) {
          // a pé: a direita carrega a maleta rente ao corpo, a esquerda balança com a passada
          const vai = Math.sin(passo + (b.lado === 1 ? 0 : Math.PI)) * andar
          const balancoMao = b.lado === 1 ? 0.06 * vai : 0.2 * vai
          mao.lerp(ombro.clone().add(v(0.04 + balancoMao, -0.6, 0.1 * b.lado)), emPe)
        }
        if (p > 0) {
          const debate = v(0.1 + 0.14 * Math.sin(t * 6 + b.lado), -0.58 + 0.05 * Math.sin(t * 9 + b.lado), 0.1 * b.lado)
          mao.lerp(ombro.clone().add(debate), p)
        }
        alcance(ombro, mao, 0.66)
        if (b.lado === 1) maoDaMaleta.copy(mao)
        const cotovelo = ombro.clone().lerp(mao, 0.5).add(v(-0.06, -0.14, 0.07 * b.lado))
        const rBraco = 0.07 * (1 + 0.4 * g)
        const rAnte = 0.062 * (1 + 0.4 * g)
        ligar(b.braco, ombro, cotovelo, rBraco)
        ligar(b.antebraco, cotovelo, mao, rAnte)
        b.ombro.position.copy(ombro)
        b.ombro.scale.setScalar(rBraco)
        b.cotovelo.position.copy(cotovelo)
        b.cotovelo.scale.setScalar(rAnte)
        ligar(b.punho, cotovelo.clone().lerp(mao, 0.86), mao, 0.05 + 0.01 * g)
        b.mao.position.copy(mao)
        b.mao.scale.set(0.06, 0.045, 0.055)
      })

      // maleta: no colo, no guidão ou balançando na mão dele
      maleta.position.copy(v(0.12, 1.36, 0)).lerp(daBike(v(0.6, 1.17, 0)), pedalar)
      const naMao = Math.max(p, emPe)
      if (naMao > 0) maleta.position.lerp(maoDaMaleta.add(v(0, -0.25, 0)), naMao)
      maleta.rotation.z =
        Math.sin(t * 5) * 0.05 * pedalar + Math.sin(t * 4) * 0.15 * p + Math.sin(passo) * 0.1 * andar * emPe

      // cabeça: acena parado, firme pedalando, ofegante descansando; pendurado
      // olha para baixo sacudindo, e depois da queda fica zonzo
      const quieto = Math.max(0, 1 - pedalar - descansar)
      const aceno = -0.04 - Math.sin(t * 2.1) * 0.13
      const firme = 0.12 + Math.sin(t * 9) * 0.02
      const ofegante = 0.2 + Math.sin(t * 3.2) * 0.06
      const normalZ = aceno * quieto + firme * pedalar + ofegante * descansar
      const normalX = Math.sin(t * 1.05) * 0.05 * quieto
      cabeca.rotation.z = lerp(normalZ, -0.18 + Math.sin(t * 5) * 0.08, p) + Math.cos(t * 6) * 0.1 * tontura
      cabeca.rotation.x = lerp(normalX, Math.sin(t * 11) * 0.2, p) + Math.sin(t * 6) * 0.14 * tontura

      // sombras: a da bicicleta vai com ela; a do agente encolhe com a altura
      sombra.position.set(bike.position.x, 0.005, bike.position.z)
      const alturaAgente = Math.max(0, agente.position.y - Y_CHAO)
      sombraAgente.visible =
        pegadinha === 'agarrado' ||
        pegadinha === 'caindo' ||
        pegadinha === 'sentado' ||
        pegadinha === 'levantando' ||
        pegadinha === 'andando'
      sombraAgente.position.set(agente.position.x - 0.1, 0.006, agente.position.z)
      const encolhe = 1 / (1 + alturaAgente * 0.4)
      sombraAgente.scale.set(0.75 * encolhe, 0.3 * encolhe, 1)
      ;(sombraAgente.material as THREE.MeshBasicMaterial).opacity = 0.22 * encolhe
    }

    // ---- a pegadinha, quadro a quadro ----
    const raio = new THREE.Raycaster()
    const ponteiro = new THREE.Vector2()
    const noCanvas = (x: number, y: number): void => {
      const r = host.getBoundingClientRect()
      ponteiro.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1)
      raio.setFromCamera(ponteiro, camera)
    }
    // ponto do plano de arrasto sob o ponteiro (null se o raio não o cruza)
    const pontoSobPonteiro = (): THREE.Vector3 | null => {
      noCanvas(ponteiroTela.x, ponteiroTela.y)
      return raio.ray.intersectPlane(planoArrasto, v(0, 0, 0))
    }

    const atualizarPegadinha = (dt: number): void => {
      if (pegadinha === 'nenhum') return
      tPegadinha += dt

      // bicicleta: sai sozinha para a direita até sumir e espera lá fora; volta
      // com ele montado, de frente para a esquerda, freando ao chegar em casa
      let ds = 0
      if (bicicleta === 'saindo') {
        bikeV = Math.min(16, bikeV + 10 * dt)
        ds = bikeV * dt
        if (bikeS + ds >= sFora) {
          ds = sFora - bikeS
          bicicleta = 'fora'
        }
      } else if (bicicleta === 'montada') {
        const vel = Math.min(VEL_CASA, 1.5 + 1.2 * Math.abs(bikeS))
        ds = -Math.sign(bikeS) * Math.min(Math.abs(bikeS), vel * dt)
      }
      bikeS += ds
      const frente = bicicleta === 'saindo' ? 1 : -1 // virada para a direita ou para a esquerda
      for (const roda of rodas) roda.rotation.z -= (ds * frente) / RAIO_RODA
      bike.position.x = DIRECAO_FUGA.x * bikeS
      bike.position.z = DIRECAO_FUGA.z * bikeS
      if (bicicleta === 'saindo') bike.rotation.y = RUMO_FUGA * Math.min(1, bikeS / 1.5)
      else if (bicicleta !== 'casa') bike.rotation.y = RUMO_VOLTA // fora da tela ela já dá meia-volta

      if (pegadinha === 'agarrado') {
        // a gola vai até a ponta do ponteiro, sem nunca descer ao banco
        const ponto = ponteiroTela.valido ? pontoSobPonteiro() : null
        pegaOffset.multiplyScalar(1 - Math.min(1, 6 * dt))
        const alvo = (ponto ?? gola.clone().sub(pegaOffset)).add(pegaOffset)
        alvo.y = Math.max(alvo.y, golaCasa.y + LEVANTA)
        const sAlvo = alvo.dot(DIRECAO_FUGA)
        const sLimitado = Math.min(Math.max(sAlvo, -0.4), sFora - 2.5)
        alvo.addScaledVector(DIRECAO_FUGA, sLimitado - sAlvo)
        gola.lerp(alvo, Math.min(1, 18 * dt))
        // pêndulo: arrancar para um lado deixa o corpo para trás, e ele balança
        const sGola = gola.dot(DIRECAO_FUGA)
        const vel = dt > 0 ? (sGola - sAnterior) / dt : 0
        const acel = Math.max(-60, Math.min(60, dt > 0 ? (vel - velAnterior) / dt : 0))
        sAnterior = sGola
        velAnterior = vel
        omega += (-(GRAVIDADE / PENDULO) * Math.sin(theta) - 2.2 * omega - (acel / PENDULO) * Math.cos(theta)) * dt
        theta = Math.max(-1.2, Math.min(1.2, theta + omega * dt))
        pendurado = suave(pendurado, 1, 8, dt)
        if (bicicleta === 'casa' && tPegadinha > 0.25) bicicleta = 'saindo'
      } else if (pegadinha === 'caindo') {
        // cai se debatendo; só perto do chão ajeita a pose para cair sentado
        const perto = agenteY - Y_CHAO < 1.2
        pendurado = suave(pendurado, perto ? 0 : 1, perto ? 10 : 4, dt)
        noChao = suave(noChao, perto ? 1 : 0, perto ? 10 : 4, dt)
        agenteVy -= GRAVIDADE * dt
        agenteY += agenteVy * dt
        if (agenteY <= Y_CHAO) {
          agenteY = Y_CHAO
          if (agenteVy < -2.5) {
            agenteVy = -agenteVy * 0.22 // quica uma vez
          } else {
            agenteVy = 0
            pegadinha = 'sentado'
            tPegadinha = 0
          }
        }
      } else if (pegadinha === 'sentado') {
        pendurado = suave(pendurado, 0, 10, dt)
        noChao = suave(noChao, 1, 6, dt)
        tontura = suave(tontura, 1, 4, dt)
        if (bicicleta === 'casa') bicicleta = 'saindo' // soltou antes de ela partir: parte assim mesmo
        if (tPegadinha > 1.1) {
          pegadinha = 'levantando'
          tPegadinha = 0
        }
      } else if (pegadinha === 'levantando') {
        // do chão para em pé, virando de lado para a direita, ainda meio zonzo
        const u = saida(tPegadinha / LEVANTAR_S)
        agenteY = lerp(Y_CHAO, Y_PE, u)
        noChao = 1 - u
        emPe = u
        tontura = suave(tontura, 0.4, 3, dt)
        if (tPegadinha >= LEVANTAR_S) {
          pegadinha = 'andando'
          tPegadinha = 0
        }
      } else if (pegadinha === 'andando') {
        // a pé até a bicicleta: sai pela direita da tela
        andar = suave(andar, 1, 5, dt)
        tontura = suave(tontura, 0, 1.5, dt)
        andado += VEL_ANDAR * andar * dt
        passo += ((VEL_ANDAR * andar) / (2 * PASSO)) * Math.PI * dt * 0.5
        agenteY = Y_PE + Math.abs(Math.sin(passo)) * 0.035 * andar
        if (queda.dot(DIRECAO_FUGA) + andado > sFora + 0.8) {
          pegadinha = 'buscando'
          tPegadinha = 0
        }
      } else if (pegadinha === 'buscando') {
        // fora da tela: pega a bicicleta e já volta montado, pedalando
        if (bicicleta === 'fora' && tPegadinha > 0.6) {
          bikeS = sFora
          bicicleta = 'montada'
          bike.rotation.y = RUMO_VOLTA
          pegadinha = 'voltandoCasa'
          pendurado = 0
          noChao = 0
          emPe = 0
          andar = 0
          tontura = 0
          agenteY = 0
          pedalar = 1
        }
      } else if (pegadinha === 'voltandoCasa') {
        if (Math.abs(bikeS) < 0.001) {
          bikeS = 0
          pegadinha = 'virando'
          tPegadinha = 0
        }
      } else if (pegadinha === 'virando') {
        // em casa, meia-volta para ficar de frente para a direita, como sempre
        const u = saida(tPegadinha / VIRAR_S)
        bike.rotation.y = lerp(RUMO_VOLTA, Math.PI * 2, u)
        if (tPegadinha >= VIRAR_S) {
          bike.rotation.y = 0
          bike.position.set(0, bike.position.y, 0)
          bicicleta = 'casa'
          pegadinha = 'nenhum'
          expandir(false)
        }
      }
    }

    const agarrar = (x: number, y: number): void => {
      ponteiroTela.x = x
      ponteiroTela.y = y
      ponteiroTela.valido = true
      expandir(true)
      golaCasa.copy(golaNoAgente()) // com o agente ainda no banco em casa, espaço do agente = espaço da cena
      gola.copy(golaCasa)
      planoArrasto.setFromNormalAndCoplanarPoint(v(Math.sin(RUMO_FUGA), 0, Math.cos(RUMO_FUGA)), golaCasa)
      const ponto = pontoSobPonteiro()
      pegaOffset.copy(ponto ? golaCasa.clone().sub(ponto) : v(0, 0, 0))
      sAnterior = golaCasa.dot(DIRECAO_FUGA)
      velAnterior = 0
      theta = 0
      omega = 0
      pegadinha = 'agarrado'
      tPegadinha = 0
      bicicleta = 'casa'
      bikeV = 0
    }

    const soltar = (): void => {
      pegadinha = 'caindo'
      tPegadinha = 0
      queda.set(agente.position.x, 0, agente.position.z)
      andado = 0
      passo = 0
      andar = 0
      emPe = 0
      agenteY = agente.position.y
      agenteRot = theta
      agenteVy = 0
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

      // na pegadinha ele não pedala nem descansa: está ocupado demais sendo erguido
      const livre = pegadinha === 'nenhum'
      const pedalando = (livre && fase === 'trabalhando') || pegadinha === 'voltandoCasa'
      pedalar = suave(pedalar, pedalando ? 1 : 0, 2.5, dt)
      descansar = suave(descansar, livre && fase === 'descansando' ? 1 : 0, 2, dt)

      // com "reduzir movimento" ele muda de pose e de peso, mas sem girar nada
      const velocidade = reduzMovimento ? 0 : pedalar * 6.5 // rad/s das rodas
      if (livre) for (const roda of rodas) roda.rotation.z -= velocidade * dt
      angPedal -= velocidade * 0.6 * dt
      bike.position.y = Math.abs(Math.sin(angPedal * 2)) * 0.012 * pedalar
      riscoMat.opacity = reduzMovimento || !livre ? 0 : 0.45 * pedalar
      for (const r of riscos) {
        r.position.x -= velocidade * 0.41 * dt
        if (r.position.x < -1.8) r.position.x += 3.6
      }

      atualizarPegadinha(dt)
      aplicarPose(dt)
      renderer.render(scene, camera)
    }

    const loop = (agora: number): void => {
      desenhar(agora)
      quadroAnim = requestAnimationFrame(loop)
    }
    quadroAnim = requestAnimationFrame(loop)

    // ---- ponteiro: o canvas não captura cliques; o acerto no boneco é por raio ----
    const documento = document.documentElement
    const acertaAgente = (e: PointerEvent): boolean => {
      const r = host.getBoundingClientRect()
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) return false
      noCanvas(e.clientX, e.clientY)
      return raio.intersectObject(agente, true).length > 0
    }
    let engolirClique = false
    const aoPressionar = (e: PointerEvent): void => {
      if (pegadinha !== 'nenhum' || e.button !== 0 || !acertaAgente(e)) return
      e.preventDefault()
      e.stopPropagation()
      documento.classList.remove('agente-mira')
      documento.classList.add('agente-agarrando')
      agarrar(e.clientX, e.clientY)
    }
    const aoSoltar = (): void => {
      if (pegadinha !== 'agarrado') return
      documento.classList.remove('agente-agarrando')
      soltar()
      // o clique que fecha o gesto não deve acionar o que estiver embaixo do boneco
      engolirClique = true
      setTimeout(() => {
        engolirClique = false
      }, 0)
    }
    const aoClicar = (e: MouseEvent): void => {
      if (!engolirClique) return
      engolirClique = false
      e.preventDefault()
      e.stopPropagation()
    }
    const aoMover = (e: PointerEvent): void => {
      if (pegadinha === 'agarrado') {
        ponteiroTela.x = e.clientX
        ponteiroTela.y = e.clientY
        return
      }
      if (pegadinha !== 'nenhum') return
      documento.classList.toggle('agente-mira', acertaAgente(e))
    }
    const aoRedimensionar = (): void => {
      if (expandido) expandir(true)
    }
    if (!reduzMovimento) {
      window.addEventListener('pointerdown', aoPressionar, true)
      window.addEventListener('pointerup', aoSoltar, true)
      window.addEventListener('pointercancel', aoSoltar, true)
      window.addEventListener('blur', aoSoltar)
      window.addEventListener('click', aoClicar, true)
      window.addEventListener('pointermove', aoMover, { passive: true })
      window.addEventListener('resize', aoRedimensionar)
    }

    return () => {
      cancelAnimationFrame(quadroAnim)
      window.removeEventListener('pointerdown', aoPressionar, true)
      window.removeEventListener('pointerup', aoSoltar, true)
      window.removeEventListener('pointercancel', aoSoltar, true)
      window.removeEventListener('blur', aoSoltar)
      window.removeEventListener('click', aoClicar, true)
      window.removeEventListener('pointermove', aoMover)
      window.removeEventListener('resize', aoRedimensionar)
      documento.classList.remove('agente-mira', 'agente-agarrando')
      host.style.width = ''
      host.style.height = ''
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
