import * as THREE from 'three'
import { v } from './util'

export const DESCANSO_S = 20 // quanto tempo descansa depois que o trabalho acaba
export const MAGRO = 0.3 // "gordura" mínima, perto da qual ele estaciona trabalhando
export const MEIA_VIDA_EMAGRECER_S = 45

// a pegadinha da gola
export const LEVANTA = 0.8 // altura mínima da gola acima da de casa: pego, ele sempre sai do banco
export const PENDULO = 1.1 // da gola ao centro do corpo, para o balanço
export const VEL_CASA = 9 // pedalando de volta para o canto (freia ao chegar), em unidades/s
export const VEL_ANDAR = 3.2 // a pé até a bicicleta, em unidades/s
export const PASSO = 0.3 // meia passada
export const Y_PE = -0.14 // deslocamento do agente em pé (quadril a ~1,1 do solo)
export const LEVANTAR_S = 0.7
export const VIRAR_S = 0.7 // meia-volta da bicicleta ao chegar em casa
export const Y_CHAO = -0.98 // deslocamento do agente sentado no chão (quadril a ~0,26 do solo)
export const GRAVIDADE = 16
export const RUMO_FUGA = 0.5 // guinada da bicicleta: anda paralela à tela, sem crescer
export const RAIO_RODA = 0.46
export const DIRECAO_FUGA = v(Math.cos(RUMO_FUGA), 0, -Math.sin(RUMO_FUGA))
export const RUMO_VOLTA = Math.PI + RUMO_FUGA // de frente para a esquerda

export type Fase = 'parado' | 'trabalhando' | 'descansando'

// pegadinha: 'nenhum' → 'agarrado' (botão pressionado) → 'caindo' → 'sentado'
// → 'levantando' → 'andando' (a pé até sair pela direita) → 'buscando' (fora da tela,
// pega a bicicleta) → 'voltandoCasa' (pedalando) → 'virando' → 'nenhum'
export type Pegadinha =
  | 'nenhum'
  | 'agarrado'
  | 'caindo'
  | 'sentado'
  | 'levantando'
  | 'andando'
  | 'buscando'
  | 'voltandoCasa'
  | 'virando'

export type Bicicleta = 'casa' | 'saindo' | 'fora' | 'montada'

export function novoEstado() {
  return {
    fase: 'parado' as Fase,
    gordura: 1, // 1 = gordinho; cai até perto de MAGRO enquanto trabalha
    recuperando: false,
    inicioDescanso: 0,
    pedalar: 0, // 0 parado … 1 pedalando (transição suave)
    descansar: 0,
    angPedal: -0.9,
    t: 0,

    pegadinha: 'nenhum' as Pegadinha,
    tPegadinha: 0,
    bicicleta: 'casa' as Bicicleta,
    bikeS: 0, // posição da bicicleta na linha paralela à tela (0 = casa)
    bikeV: 0,
    sFora: 40, // posição em que a bicicleta some pela direita (medida ao agarrar)
    pendurado: 0, // peso da pose "pendurado pela gola"
    noChao: 0, // peso da pose "sentado no chão"
    emPe: 0, // peso da pose "em pé / andando"
    andar: 0, // 0 parado em pé … 1 dando passos
    passo: 0, // fase da passada
    andado: 0, // quanto já andou desde onde caiu
    tontura: 0,
    // arrasto: a gola segue o ponteiro num plano paralelo à tela, passando pela gola de casa
    golaCasa: v(0, 0, 0),
    gola: v(0, 0, 0), // onde a gola está agora (suavizada)
    pegaOffset: v(0, 0, 0), // some aos poucos: a gola escorrega até a ponta do ponteiro
    planoArrasto: new THREE.Plane(),
    theta: 0, // balanço do pêndulo
    omega: 0,
    velAnterior: 0,
    sAnterior: 0,
    queda: v(0, 0, 0), // posição horizontal do agente solto (caindo / no chão)
    agenteY: 0,
    agenteVy: 0,
    agenteRot: 0
  }
}

export type Estado = ReturnType<typeof novoEstado>

// Ciclo normal: acompanha o trabalho do Agent Code e o peso dele.
export function atualizarFase(s: Estado, ocupado: boolean, dt: number): void {
  if (ocupado && s.fase !== 'trabalhando') {
    // prompt novo durante o descanso: recomeça o ciclo gordinho
    if (s.fase === 'descansando') s.recuperando = true
    s.fase = 'trabalhando'
  } else if (!ocupado && s.fase === 'trabalhando') {
    s.fase = 'descansando'
    s.inicioDescanso = s.t
  } else if (s.fase === 'descansando' && s.t - s.inicioDescanso > DESCANSO_S) {
    s.fase = 'parado'
    s.recuperando = true
  }

  if (s.recuperando) {
    s.gordura = Math.min(1, s.gordura + dt * (s.fase === 'trabalhando' ? 1.2 : 0.35))
    if (s.gordura >= 1) s.recuperando = false
  } else if (s.fase === 'trabalhando') {
    const k = Math.LN2 / MEIA_VIDA_EMAGRECER_S
    s.gordura = Math.max(MAGRO, s.gordura - (s.gordura - MAGRO + 0.02) * k * dt)
  }
}
