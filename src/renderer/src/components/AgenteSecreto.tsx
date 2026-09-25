import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { DIRECAO_FUGA, atualizarFase, novoEstado } from './agenteSecreto/estado'
import { liberarCena, montarModelo } from './agenteSecreto/modelo'
import { agarrar, atualizarPedalada, atualizarPegadinha, soltar } from './agenteSecreto/pegadinha'
import { aplicarPose } from './agenteSecreto/pose'
import { v } from './agenteSecreto/util'

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
// Cena procedural (sem assets, em ./agenteSecreto). Fora o próprio boneco, não captura cliques.

const LARGURA = 230
const ALTURA = 205

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

    const m = montarModelo(scene)
    const s = novoEstado()
    const ponteiroTela = { x: 0, y: 0, valido: false }
    let expandido = false
    let ultimo = performance.now()

    const reduzMovimento = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let quadroAnim = 0

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
      s.sFora = 3
      while (s.sFora < 200) {
        ponto.copy(DIRECAO_FUGA).multiplyScalar(s.sFora - 1.6).setY(0.8)
        if (ponto.project(camera).x > 1.02) break
        s.sFora += 0.5
      }
    }

    const raio = new THREE.Raycaster()
    const ponteiro = new THREE.Vector2()
    const noCanvas = (x: number, y: number): void => {
      const r = host.getBoundingClientRect()
      ponteiro.set(((x - r.left) / r.width) * 2 - 1, -((y - r.top) / r.height) * 2 + 1)
      raio.setFromCamera(ponteiro, camera)
    }
    // ponto do plano de arrasto sob o ponteiro (null se o raio não o cruza)
    const pontoSobPonteiro = (): THREE.Vector3 | null => {
      if (!ponteiroTela.valido) return null
      noCanvas(ponteiroTela.x, ponteiroTela.y)
      return raio.ray.intersectPlane(s.planoArrasto, v(0, 0, 0))
    }
    const contexto = { pontoSobPonteiro, terminar: () => expandir(false) }

    const desenhar = (agora: number): void => {
      const dt = Math.min(0.1, (agora - ultimo) / 1000)
      ultimo = agora
      s.t += dt
      atualizarFase(s, trabalhandoRef.current, dt)
      atualizarPedalada(m, s, dt, reduzMovimento)
      atualizarPegadinha(m, s, dt, contexto)
      aplicarPose(m, s, dt)
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
      return raio.intersectObject(m.agente, true).length > 0
    }
    let engolirClique = false
    const aoPressionar = (e: PointerEvent): void => {
      if (s.pegadinha !== 'nenhum' || e.button !== 0 || !acertaAgente(e)) return
      e.preventDefault()
      e.stopPropagation()
      documento.classList.remove('agente-mira')
      documento.classList.add('agente-agarrando')
      ponteiroTela.x = e.clientX
      ponteiroTela.y = e.clientY
      ponteiroTela.valido = true
      expandir(true)
      agarrar(m, s, pontoSobPonteiro)
    }
    const aoSoltar = (): void => {
      if (s.pegadinha !== 'agarrado') return
      documento.classList.remove('agente-agarrando')
      soltar(m, s)
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
      if (s.pegadinha === 'agarrado') {
        ponteiroTela.x = e.clientX
        ponteiroTela.y = e.clientY
        return
      }
      if (s.pegadinha !== 'nenhum') return
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
      liberarCena(scene)
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return <div ref={hostRef} className="agente-secreto" aria-hidden="true" />
}
