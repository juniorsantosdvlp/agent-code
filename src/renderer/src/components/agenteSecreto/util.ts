import * as THREE from 'three'

// Utilidades de geometria do agente secreto. Membros são cilindros unitários
// reposicionados a cada quadro (pernas seguem o pedal, braços vão da maleta ao
// guidão) — mais simples que um esqueleto.

export const EIXO_Y = new THREE.Vector3(0, 1, 0)
export const v = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z)
export const CILINDRO = new THREE.CylinderGeometry(1, 1, 1, 14)
export const ESFERA = new THREE.SphereGeometry(1, 16, 12)
const tmp = new THREE.Vector3()

// Nunca deixa o membro esticar além do comprimento: com a bicicleta fugindo,
// o pedal (ou o guidão) pode estar do outro lado da tela.
export function alcance(origem: THREE.Vector3, alvo: THREE.Vector3, maximo: number): THREE.Vector3 {
  tmp.subVectors(alvo, origem)
  if (tmp.length() > maximo) alvo.copy(origem).addScaledVector(tmp.normalize(), maximo)
  return alvo
}

export function ligar(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, raio: number): void {
  tmp.subVectors(b, a)
  const comprimento = tmp.length()
  mesh.position.copy(a).addScaledVector(tmp, 0.5)
  mesh.quaternion.setFromUnitVectors(EIXO_Y, tmp.normalize())
  mesh.scale.set(raio, comprimento, raio)
}

export function cilindroFixo(a: THREE.Vector3, b: THREE.Vector3, raio: number, material: THREE.Material): THREE.Mesh {
  const mesh = new THREE.Mesh(CILINDRO, material)
  ligar(mesh, a, b, raio)
  return mesh
}

// Joelho por cinemática inversa de dois ossos, no plano da bicicleta (x, y),
// dobrando para a frente (+x).
export function joelhoEntre(quadril: THREE.Vector3, pe: THREE.Vector3, coxa: number, canela: number): THREE.Vector3 {
  const dx = pe.x - quadril.x
  const dy = pe.y - quadril.y
  const d = Math.min(Math.hypot(dx, dy), coxa + canela - 0.001)
  const ang = Math.acos(Math.min(1, Math.max(-1, (coxa * coxa + d * d - canela * canela) / (2 * coxa * d))))
  const base = Math.atan2(dy, dx) + ang
  return v(quadril.x + Math.cos(base) * coxa, quadril.y + Math.sin(base) * coxa, (quadril.z + pe.z) / 2)
}

export const suave = (atual: number, alvo: number, velocidade: number, dt: number): number =>
  atual + (alvo - atual) * Math.min(1, velocidade * dt)
export const lerp = THREE.MathUtils.lerp
export const saida = (u: number): number => 1 - (1 - Math.min(1, Math.max(0, u))) ** 3
