import { useEffect, useRef } from 'react'
import * as THREE from 'three'

// Agente secreto de terno, pele clara e cabelo preto, sentado numa bicicleta
// parada, segurando a maleta preta à frente do corpo. Só a cabeça se mexe.
// Cena procedural (sem assets), no canto inferior esquerdo, sem capturar cliques.

const LARGURA = 190
const ALTURA = 170

const EIXO_Y = new THREE.Vector3(0, 1, 0)

function orientar(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): THREE.Mesh {
  const dir = new THREE.Vector3().subVectors(b, a)
  mesh.position.copy(a).addScaledVector(dir, 0.5)
  mesh.quaternion.setFromUnitVectors(EIXO_Y, dir.normalize())
  return mesh
}

function cilindroEntre(a: THREE.Vector3, b: THREE.Vector3, raio: number, material: THREE.Material): THREE.Mesh {
  const comprimento = a.distanceTo(b)
  return orientar(new THREE.Mesh(new THREE.CylinderGeometry(raio, raio, comprimento, 12), material), a, b)
}

// Membro arredondado nas pontas (braço, perna): parece tecido, não cano.
function capsulaEntre(a: THREE.Vector3, b: THREE.Vector3, raio: number, material: THREE.Material): THREE.Mesh {
  const comprimento = Math.max(a.distanceTo(b) - raio * 2, 0.01)
  return orientar(new THREE.Mesh(new THREE.CapsuleGeometry(raio, comprimento, 6, 14), material), a, b)
}

const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z)

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
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.outputColorSpace = THREE.SRGBColorSpace
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(30, LARGURA / ALTURA, 0.1, 50)
    camera.position.set(Math.sin(0.5) * 9.8, 3.1, Math.cos(0.5) * 9.8)
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

    // sombra suave no chão
    const sombra = new THREE.Mesh(
      new THREE.CircleGeometry(1, 40),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.22, depthWrite: false })
    )
    sombra.rotation.x = -Math.PI / 2
    sombra.scale.set(1.45, 0.4, 1)
    sombra.position.y = 0.005
    raiz.add(sombra)

    // ---- bicicleta (de lado, virada para +x) ----
    for (const x of [-0.75, 0.75]) {
      const pneu = new THREE.Mesh(new THREE.TorusGeometry(0.41, 0.05, 14, 48), borracha)
      pneu.position.set(x, 0.46, 0)
      raiz.add(pneu)
      const aro = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.014, 8, 48), cromo)
      aro.position.set(x, 0.46, 0)
      raiz.add(aro)
      const cubo = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.12, 12), cromo)
      cubo.rotation.x = Math.PI / 2
      cubo.position.set(x, 0.46, 0)
      raiz.add(cubo)
      for (let i = 0; i < 12; i++) {
        const raio = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.72, 4), cromo)
        raio.position.set(x, 0.46, 0)
        raio.rotation.z = (i * Math.PI) / 12
        raiz.add(raio)
      }
    }
    const pedalier = v(0, 0.5, 0)
    const rodaTras = v(-0.75, 0.46, 0)
    const rodaFrente = v(0.75, 0.46, 0)
    const canoBanco = v(-0.28, 1.08, 0)
    const canoDirecao = v(0.55, 1.08, 0)
    const tubos: [THREE.Vector3, THREE.Vector3, number][] = [
      [pedalier, canoBanco, 0.03],
      [pedalier, canoDirecao, 0.034],
      [canoBanco, canoDirecao, 0.028],
      [canoBanco, rodaTras, 0.018],
      [pedalier, rodaTras, 0.02],
      [canoDirecao, rodaFrente, 0.024]
    ]
    for (const [a, b, r] of tubos) raiz.add(cilindroEntre(a, b, r, quadro))
    const coroa = new THREE.Mesh(new THREE.TorusGeometry(0.1, 0.012, 8, 32), cromo)
    coroa.position.set(0, 0.5, 0.06)
    raiz.add(coroa)
    raiz.add(cilindroEntre(v(0, 0.5, 0.08), v(0.12, 0.33, 0.12), 0.014, cromo))
    raiz.add(cilindroEntre(v(0, 0.5, -0.08), v(-0.12, 0.67, -0.12), 0.014, cromo))
    const banco = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.2, 4, 10), couro)
    banco.rotation.z = Math.PI / 2
    banco.scale.set(1, 1, 1.3)
    banco.position.set(-0.3, 1.15, 0)
    raiz.add(banco)
    raiz.add(cilindroEntre(canoDirecao, v(0.5, 1.34, 0), 0.022, cromo))
    raiz.add(cilindroEntre(v(0.5, 1.34, -0.26), v(0.5, 1.34, 0.26), 0.02, cromo))
    for (const z of [-0.24, 0.24]) {
      const manopla = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.1, 10), borracha)
      manopla.rotation.x = Math.PI / 2
      manopla.position.set(0.5, 1.34, z)
      raiz.add(manopla)
    }

    // ---- agente ----
    // pernas: coxas quase horizontais, pés nos pedais
    const quadrilE = v(-0.28, 1.24, 0.12)
    const quadrilD = v(-0.28, 1.24, -0.12)
    const joelhoE = v(0.26, 1.08, 0.14)
    const joelhoD = v(0.08, 1.02, -0.14)
    const peE = v(0.13, 0.4, 0.15)
    const peD = v(-0.1, 0.72, -0.15)
    raiz.add(capsulaEntre(quadrilE, joelhoE, 0.1, terno))
    raiz.add(capsulaEntre(joelhoE, peE, 0.075, terno))
    raiz.add(capsulaEntre(quadrilD, joelhoD, 0.1, terno))
    raiz.add(capsulaEntre(joelhoD, peD, 0.075, terno))
    for (const pe of [peE, peD]) {
      const sapato = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.14, 4, 10), sapatoMat)
      sapato.rotation.z = Math.PI / 2
      sapato.position.set(pe.x + 0.06, pe.y - 0.05, pe.z)
      raiz.add(sapato)
    }

    // tronco: cápsula achatada, ombros largos
    const tronco = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, 0.42, 6, 18), terno)
    tronco.scale.set(0.78, 1, 1.28)
    tronco.position.set(-0.24, 1.6, 0)
    tronco.rotation.z = -0.1
    raiz.add(tronco)
    // camisa e gravata no V do paletó
    const peito = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.34), camisa)
    peito.rotation.y = Math.PI / 2
    peito.position.set(-0.08, 1.78, 0)
    raiz.add(peito)
    const gravataMesh = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.3, 0.055), gravata)
    gravataMesh.position.set(-0.07, 1.74, 0)
    raiz.add(gravataMesh)
    for (const z of [-0.07, 0.07]) {
      const lapela = new THREE.Mesh(new THREE.BoxGeometry(0.014, 0.3, 0.06), terno)
      lapela.position.set(-0.065, 1.78, z)
      lapela.rotation.x = z > 0 ? -0.35 : 0.35
      raiz.add(lapela)
    }

    // maleta de pé sobre as coxas, bem à frente do corpo
    const maleta = new THREE.Group()
    maleta.position.set(0.12, 1.36, 0)
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
    raiz.add(maleta)

    // braços: ombro → cotovelo → mão na alça da maleta
    for (const lado of [1, -1]) {
      const ombro = v(-0.22, 1.86, 0.22 * lado)
      const cotovelo = v(-0.08, 1.5, 0.26 * lado)
      const mao = v(0.12, 1.56, 0.06 * lado)
      raiz.add(capsulaEntre(ombro, cotovelo, 0.07, terno))
      raiz.add(capsulaEntre(cotovelo, mao, 0.062, terno))
      const punho = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 12), camisa)
      orientar(punho, cotovelo.clone().lerp(mao, 0.86), mao)
      raiz.add(punho)
      const maoMesh = new THREE.Mesh(new THREE.SphereGeometry(0.055, 14, 10), pele)
      maoMesh.scale.set(1.1, 0.8, 1)
      maoMesh.position.copy(mao).add(v(0.01, 0.01, 0))
      raiz.add(maoMesh)
    }

    // pescoço e cabeça (a única coisa que se mexe)
    const pescoco = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.08, 0.16, 14), pele)
    pescoco.position.set(-0.17, 2.0, 0)
    raiz.add(pescoco)
    const colarinho = new THREE.Mesh(new THREE.TorusGeometry(0.08, 0.02, 8, 20), camisa)
    colarinho.rotation.x = Math.PI / 2
    colarinho.position.set(-0.17, 1.94, 0)
    raiz.add(colarinho)

    const cabeca = new THREE.Group()
    cabeca.position.set(-0.17, 2.06, 0) // pivô na nuca, para o aceno parecer natural
    raiz.add(cabeca)
    const cranio = new THREE.Mesh(new THREE.SphereGeometry(0.19, 28, 22), pele)
    cranio.scale.set(1.02, 1.14, 0.9)
    cranio.position.set(0.02, 0.19, 0)
    cabeca.add(cranio)
    const queixo = new THREE.Mesh(new THREE.SphereGeometry(0.1, 16, 12), pele)
    queixo.scale.set(1, 0.8, 1.1)
    queixo.position.set(0.08, 0.06, 0)
    cabeca.add(queixo)
    // cabelo preto curto: calota um pouco maior, puxada para trás
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

    const reduzMovimento = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let quadroAnim = 0
    const inicio = performance.now()

    const desenhar = (agora: number): void => {
      const t = (agora - inicio) / 1000
      // aceno lento de cabeça, com um leve balanço lateral
      cabeca.rotation.z = -0.04 - Math.sin(t * 2.1) * 0.13
      cabeca.rotation.x = Math.sin(t * 1.05) * 0.05
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
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return <div ref={hostRef} className="agente-secreto" aria-hidden="true" />
}
