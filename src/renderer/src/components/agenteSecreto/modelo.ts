import * as THREE from 'three'
import { CILINDRO, ESFERA, cilindroFixo, v } from './util'

// Modelo procedural (sem assets) do agente secreto e da bicicleta. Bicicleta e
// agente são grupos irmãos em `raiz`, para que ele possa ser erguido sem ela.

export type Modelo = ReturnType<typeof montarModelo>

export function montarModelo(scene: THREE.Scene) {
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

  return {
    raiz,
    bike,
    agente,
    sombra,
    sombraAgente,
    riscoMat,
    riscos,
    rodas,
    pedivelas,
    pedais,
    corpo,
    L,
    GOLA,
    tronco,
    barriga,
    peito,
    gravataMesh,
    lapelas,
    pescoco,
    cabeca,
    cranio,
    queixo,
    pernas,
    bracos,
    maleta
  }
}

// Libera geometrias e materiais da cena (menos as geometrias unitárias compartilhadas).
export function liberarCena(scene: THREE.Scene): void {
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
}
