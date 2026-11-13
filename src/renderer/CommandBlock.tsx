import { useRef, useState } from 'react'
import { Glyph } from './ui-icons'

/** Bloque de comandos con botón de copiar. Nunca ejecuta nada por su cuenta. */
export function CommandBlock({ commands }: { commands: string[] }) {
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLPreElement>(null)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(commands.join('\n'))
      setCopied(true)
    } catch {
      // Sin permiso de portapapeles: se selecciona para copiar con Ctrl+C.
      const el = ref.current
      const selection = window.getSelection()
      if (el && selection) {
        const range = document.createRange()
        range.selectNodeContents(el)
        selection.removeAllRanges()
        selection.addRange(range)
      }
    }
  }

  return (
    <div className="cmd-block">
      <pre className="cmd" ref={ref}>{commands.join('\n')}</pre>
      <button type="button" className="btn ghost" onClick={copy}>
        <Glyph name={copied ? 'check' : 'terminal'} size={13} />
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}
