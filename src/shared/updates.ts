// Qué filas de «Programs and updates» pueden lanzar una actualización.
// Es una función pura para cubrir el caso que fallaba: `valet` se ofrecía
// siempre, aunque estuviera en la última versión, y el botón no cambiaba nada.
import type { UpdateItem } from './types'

export function canUpgrade(item: UpdateItem): boolean {
  return !item.blocked && item.available
}
