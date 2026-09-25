import * as THREE from 'three'
import {
  DIRECAO_FUGA,
  GRAVIDADE,
  LEVANTA,
  LEVANTAR_S,
  PASSO,
  PENDULO,
  RAIO_RODA,
  RUMO_FUGA,
  RUMO_VOLTA,
  VEL_ANDAR,
  VEL_CASA,
  VIRAR_S,
  Y_CHAO,
  Y_PE,
  type Estado
} from './estado'
import type { Modelo } from './modelo'
import { golaNoAgente } from './pose'
import { lerp, saida, suave, v } from './util'

// A pegadinha da gola: o ponteiro pega o agente, a bicicleta foge sozinha, ele
// cai ao ser solto, levanta, vai a pé buscá-la fora da tela e volta pedalando.

export interface Ponteiro {
  // ponto do plano de arrasto sob o ponteiro (null se não há ponteiro ou o raio não cruza o plano)
  pontoSobPonteiro: () => THREE.Vector3 | null
  // a pegadinha acabou: o agente está de volta em casa
  terminar: () => void
}

// Pedalada e rodas do ciclo normal; na pegadinha ele não pedala nem descansa,
// está ocupado demais sendo erguido (só volta a pedalar montado, voltando para casa).
export function atualizarPedalada(m: Modelo, s: Estado, dt: number, reduzMovimento: boolean): void {
  const livre = s.pegadinha === 'nenhum'
  const pedalando = (livre && s.fase === 'trabalhando') || s.pegadinha === 'voltandoCasa'
  s.pedalar = suave(s.pedalar, pedalando ? 1 : 0, 2.5, dt)
  s.descansar = suave(s.descansar, livre && s.fase === 'descansando' ? 1 : 0, 2, dt)

  // com "reduzir movimento" ele muda de pose e de peso, mas sem girar nada
  const velocidade = reduzMovimento ? 0 : s.pedalar * 6.5 // rad/s das rodas
  if (livre) for (const roda of m.rodas) roda.rotation.z -= velocidade * dt
  s.angPedal -= velocidade * 0.6 * dt
  m.bike.position.y = Math.abs(Math.sin(s.angPedal * 2)) * 0.012 * s.pedalar
  m.riscoMat.opacity = reduzMovimento || !livre ? 0 : 0.45 * s.pedalar
  for (const r of m.riscos) {
    r.position.x -= velocidade * 0.41 * dt
    if (r.position.x < -1.8) r.position.x += 3.6
  }
}

export function atualizarPegadinha(m: Modelo, s: Estado, dt: number, ponteiro: Ponteiro): void {
  if (s.pegadinha === 'nenhum') return
  s.tPegadinha += dt
  const bike = m.bike

  // bicicleta: sai sozinha para a direita até sumir e espera lá fora; volta
  // com ele montado, de frente para a esquerda, freando ao chegar em casa
  let ds = 0
  if (s.bicicleta === 'saindo') {
    s.bikeV = Math.min(16, s.bikeV + 10 * dt)
    ds = s.bikeV * dt
    if (s.bikeS + ds >= s.sFora) {
      ds = s.sFora - s.bikeS
      s.bicicleta = 'fora'
    }
  } else if (s.bicicleta === 'montada') {
    const vel = Math.min(VEL_CASA, 1.5 + 1.2 * Math.abs(s.bikeS))
    ds = -Math.sign(s.bikeS) * Math.min(Math.abs(s.bikeS), vel * dt)
  }
  s.bikeS += ds
  const frente = s.bicicleta === 'saindo' ? 1 : -1 // virada para a direita ou para a esquerda
  for (const roda of m.rodas) roda.rotation.z -= (ds * frente) / RAIO_RODA
  bike.position.x = DIRECAO_FUGA.x * s.bikeS
  bike.position.z = DIRECAO_FUGA.z * s.bikeS
  if (s.bicicleta === 'saindo') bike.rotation.y = RUMO_FUGA * Math.min(1, s.bikeS / 1.5)
  else if (s.bicicleta !== 'casa') bike.rotation.y = RUMO_VOLTA // fora da tela ela já dá meia-volta

  if (s.pegadinha === 'agarrado') {
    // a gola vai até a ponta do ponteiro, sem nunca descer ao banco
    const ponto = ponteiro.pontoSobPonteiro()
    s.pegaOffset.multiplyScalar(1 - Math.min(1, 6 * dt))
    const alvo = (ponto ?? s.gola.clone().sub(s.pegaOffset)).add(s.pegaOffset)
    alvo.y = Math.max(alvo.y, s.golaCasa.y + LEVANTA)
    const sAlvo = alvo.dot(DIRECAO_FUGA)
    const sLimitado = Math.min(Math.max(sAlvo, -0.4), s.sFora - 2.5)
    alvo.addScaledVector(DIRECAO_FUGA, sLimitado - sAlvo)
    s.gola.lerp(alvo, Math.min(1, 18 * dt))
    // pêndulo: arrancar para um lado deixa o corpo para trás, e ele balança
    const sGola = s.gola.dot(DIRECAO_FUGA)
    const vel = dt > 0 ? (sGola - s.sAnterior) / dt : 0
    const acel = Math.max(-60, Math.min(60, dt > 0 ? (vel - s.velAnterior) / dt : 0))
    s.sAnterior = sGola
    s.velAnterior = vel
    s.omega +=
      (-(GRAVIDADE / PENDULO) * Math.sin(s.theta) - 2.2 * s.omega - (acel / PENDULO) * Math.cos(s.theta)) * dt
    s.theta = Math.max(-1.2, Math.min(1.2, s.theta + s.omega * dt))
    s.pendurado = suave(s.pendurado, 1, 8, dt)
    if (s.bicicleta === 'casa' && s.tPegadinha > 0.25) s.bicicleta = 'saindo'
  } else if (s.pegadinha === 'caindo') {
    // cai se debatendo; só perto do chão ajeita a pose para cair sentado
    const perto = s.agenteY - Y_CHAO < 1.2
    s.pendurado = suave(s.pendurado, perto ? 0 : 1, perto ? 10 : 4, dt)
    s.noChao = suave(s.noChao, perto ? 1 : 0, perto ? 10 : 4, dt)
    s.agenteVy -= GRAVIDADE * dt
    s.agenteY += s.agenteVy * dt
    if (s.agenteY <= Y_CHAO) {
      s.agenteY = Y_CHAO
      if (s.agenteVy < -2.5) {
        s.agenteVy = -s.agenteVy * 0.22 // quica uma vez
      } else {
        s.agenteVy = 0
        s.pegadinha = 'sentado'
        s.tPegadinha = 0
      }
    }
  } else if (s.pegadinha === 'sentado') {
    s.pendurado = suave(s.pendurado, 0, 10, dt)
    s.noChao = suave(s.noChao, 1, 6, dt)
    s.tontura = suave(s.tontura, 1, 4, dt)
    if (s.bicicleta === 'casa') s.bicicleta = 'saindo' // soltou antes de ela partir: parte assim mesmo
    if (s.tPegadinha > 1.1) {
      s.pegadinha = 'levantando'
      s.tPegadinha = 0
    }
  } else if (s.pegadinha === 'levantando') {
    // do chão para em pé, virando de lado para a direita, ainda meio zonzo
    const u = saida(s.tPegadinha / LEVANTAR_S)
    s.agenteY = lerp(Y_CHAO, Y_PE, u)
    s.noChao = 1 - u
    s.emPe = u
    s.tontura = suave(s.tontura, 0.4, 3, dt)
    if (s.tPegadinha >= LEVANTAR_S) {
      s.pegadinha = 'andando'
      s.tPegadinha = 0
    }
  } else if (s.pegadinha === 'andando') {
    // a pé até a bicicleta: sai pela direita da tela
    s.andar = suave(s.andar, 1, 5, dt)
    s.tontura = suave(s.tontura, 0, 1.5, dt)
    s.andado += VEL_ANDAR * s.andar * dt
    s.passo += ((VEL_ANDAR * s.andar) / (2 * PASSO)) * Math.PI * dt * 0.5
    s.agenteY = Y_PE + Math.abs(Math.sin(s.passo)) * 0.035 * s.andar
    if (s.queda.dot(DIRECAO_FUGA) + s.andado > s.sFora + 0.8) {
      s.pegadinha = 'buscando'
      s.tPegadinha = 0
    }
  } else if (s.pegadinha === 'buscando') {
    // fora da tela: pega a bicicleta e já volta montado, pedalando
    if (s.bicicleta === 'fora' && s.tPegadinha > 0.6) {
      s.bikeS = s.sFora
      s.bicicleta = 'montada'
      bike.rotation.y = RUMO_VOLTA
      s.pegadinha = 'voltandoCasa'
      s.pendurado = 0
      s.noChao = 0
      s.emPe = 0
      s.andar = 0
      s.tontura = 0
      s.agenteY = 0
      s.pedalar = 1
    }
  } else if (s.pegadinha === 'voltandoCasa') {
    if (Math.abs(s.bikeS) < 0.001) {
      s.bikeS = 0
      s.pegadinha = 'virando'
      s.tPegadinha = 0
    }
  } else if (s.pegadinha === 'virando') {
    // em casa, meia-volta para ficar de frente para a direita, como sempre
    const u = saida(s.tPegadinha / VIRAR_S)
    bike.rotation.y = lerp(RUMO_VOLTA, Math.PI * 2, u)
    if (s.tPegadinha >= VIRAR_S) {
      bike.rotation.y = 0
      bike.position.set(0, bike.position.y, 0)
      s.bicicleta = 'casa'
      s.pegadinha = 'nenhum'
      ponteiro.terminar()
    }
  }
}

// Com o agente ainda no banco em casa (espaço do agente = espaço da cena):
// prepara o plano de arrasto pela gola, paralelo à tela, e o pega.
export function agarrar(m: Modelo, s: Estado, pontoSobPonteiro: () => THREE.Vector3 | null): void {
  s.golaCasa.copy(golaNoAgente(m))
  s.gola.copy(s.golaCasa)
  s.planoArrasto.setFromNormalAndCoplanarPoint(v(Math.sin(RUMO_FUGA), 0, Math.cos(RUMO_FUGA)), s.golaCasa)
  const ponto = pontoSobPonteiro()
  s.pegaOffset.copy(ponto ? s.golaCasa.clone().sub(ponto) : v(0, 0, 0))
  s.sAnterior = s.golaCasa.dot(DIRECAO_FUGA)
  s.velAnterior = 0
  s.theta = 0
  s.omega = 0
  s.pegadinha = 'agarrado'
  s.tPegadinha = 0
  s.bicicleta = 'casa'
  s.bikeV = 0
}

export function soltar(m: Modelo, s: Estado): void {
  s.pegadinha = 'caindo'
  s.tPegadinha = 0
  s.queda.set(m.agente.position.x, 0, m.agente.position.z)
  s.andado = 0
  s.passo = 0
  s.andar = 0
  s.emPe = 0
  s.agenteY = m.agente.position.y
  s.agenteRot = s.theta
  s.agenteVy = 0
}
