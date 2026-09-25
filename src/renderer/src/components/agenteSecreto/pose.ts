import * as THREE from 'three'
import { DIRECAO_FUGA, PASSO, RUMO_FUGA, Y_CHAO, type Estado } from './estado'
import type { Modelo } from './modelo'
import { alcance, joelhoEntre, lerp, ligar, suave, v } from './util'

// onde a gola está no espaço do agente (o corpo pode estar inclinado)
export function golaNoAgente(m: Modelo): THREE.Vector3 {
  m.corpo.updateMatrix()
  return m.GOLA.clone().applyMatrix4(m.corpo.matrix)
}

// Posiciona o agente e reposiciona membros, maleta, cabeça e sombras a partir
// do estado: no banco (parado / pedalando / descansando), pendurado pela gola,
// caído, em pé ou andando. As poses se misturam pelos pesos do estado.
export function aplicarPose(m: Modelo, s: Estado, dt: number): void {
  const { corpo, agente, bike, L } = m
  const g = s.gordura
  const p = s.pendurado
  const { t, pedalar, descansar, noChao, emPe, andar, passo, tontura } = s

  // corpo e barriga
  const inclinacao = -0.22 * pedalar + 0.06 * descansar
  const emPeInclinado = lerp(lerp(inclinacao, 0.15, noChao), -0.06 - 0.03 * andar, emPe)
  corpo.rotation.z = lerp(emPeInclinado, Math.sin(t * 6) * 0.05, p)
  const folego = descansar * Math.sin(t * 3.2) * 0.035 + (1 - descansar) * Math.sin(t * 1.6) * 0.01
  m.tronco.scale.set((0.8 + 0.28 * g) * (1 + folego), 1, (1.25 + 0.3 * g) * (1 + folego))
  m.barriga.scale.set(0.14 + 0.08 * g, 0.24 + 0.04 * g, 0.22 + 0.08 * g)
  m.barriga.position.copy(L(-0.19 + 0.05 * g, 1.48, 0))
  const frente = -0.08 + 0.07 * g
  m.peito.position.copy(L(frente, 1.8, 0))
  m.gravataMesh.position.copy(L(frente + 0.01, 1.76, 0))
  m.gravataMesh.rotation.z = -0.25 * g
  for (const { lapela, z } of m.lapelas) lapela.position.copy(L(frente + 0.015, 1.8, z))
  // engorda por inteiro: rosto e pescoço alargam junto com o corpo
  m.cranio.scale.set(1.02 + 0.08 * g, 1.14, 0.9 + 0.12 * g)
  m.queixo.scale.set(1 + 0.1 * g, 0.8, 1.1 + 0.15 * g)
  m.pescoco.scale.set(1 + 0.25 * g, 1, 1 + 0.25 * g)

  // onde o agente está: no banco, pendurado pela gola ou solto (caindo / no chão / pulando)
  const pegadinha = s.pegadinha
  if (pegadinha === 'nenhum' || pegadinha === 'voltandoCasa' || pegadinha === 'virando') {
    agente.position.copy(bike.position)
    agente.rotation.set(0, bike.rotation.y, 0)
  } else if (pegadinha === 'agarrado') {
    // gira em torno da gola, presa na ponta do ponteiro
    const c = golaNoAgente(m)
    const cs = Math.cos(s.theta)
    const sn = Math.sin(s.theta)
    agente.rotation.set(0, 0, s.theta)
    agente.position.set(s.gola.x - (c.x * cs - c.y * sn), s.gola.y - (c.x * sn + c.y * cs), s.gola.z - c.z)
  } else {
    // solto: caído, levantando ou a pé, sempre a partir de onde caiu;
    // em pé ele se vira de lado para a tela, na direção da bicicleta
    s.agenteRot = suave(s.agenteRot, 0, 6, dt)
    agente.position.set(s.queda.x, s.agenteY, s.queda.z).addScaledVector(DIRECAO_FUGA, s.andado)
    agente.rotation.set(0, RUMO_FUGA * emPe, s.agenteRot)
  }

  agente.visible = pegadinha !== 'buscando' // lá fora da tela, pegando a bicicleta
  m.raiz.updateMatrixWorld(true)
  const noCorpo = (q: THREE.Vector3): THREE.Vector3 => agente.worldToLocal(corpo.localToWorld(q.clone()))
  const daBike = (q: THREE.Vector3): THREE.Vector3 => agente.worldToLocal(bike.localToWorld(q.clone()))
  const chaoY = -agente.position.y

  // pernas: seguem os pedais, esticam para a frente no chão ou balançam penduradas
  m.pernas.forEach((perna, i) => {
    const a = s.angPedal + i * Math.PI
    const pedal = v(Math.cos(a) * 0.17, 0.5 + Math.sin(a) * 0.17, 0.15 * perna.lado)
    ligar(m.pedivelas[i], v(0, 0.5, 0.08 * perna.lado), pedal, 0.014)
    m.pedais[i].position.copy(pedal)
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
  m.bracos.forEach((b) => {
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
  const maleta = m.maleta
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
  m.cabeca.rotation.z = lerp(normalZ, -0.18 + Math.sin(t * 5) * 0.08, p) + Math.cos(t * 6) * 0.1 * tontura
  m.cabeca.rotation.x = lerp(normalX, Math.sin(t * 11) * 0.2, p) + Math.sin(t * 6) * 0.14 * tontura

  // sombras: a da bicicleta vai com ela; a do agente encolhe com a altura
  m.sombra.position.set(bike.position.x, 0.005, bike.position.z)
  const alturaAgente = Math.max(0, agente.position.y - Y_CHAO)
  const sombraAgente = m.sombraAgente
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
