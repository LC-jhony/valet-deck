/**
 * Marca de Valet Deck: el elefante de PHP sobre una baldosa azul noche. PHP es
 * la base del entorno local que gestiona la app (Laravel, Valet, nginx y MariaDB).
 * El dibujo y los colores son los del logo de marca (`resources/icon.svg`), con
 * el elefante en azul y la baldosa con un degradado sutil que separa el icono de
 * fondos claros y oscuros.
 */
import { useId } from 'react'

const BACK =
  'M16 8q0 3.12-1.38 6.68a.5.5 0 0 1-.46.32H13a1 1 0 0 1-1-1 1 1 0 0 0-2 0 1 1 0 0 1-1 1H7.99a1.5 1.5 0 0 1-1.39-.94Q6 12.58 6 12c0-.3-.32-2.03-.45-4C8 8 4.6 3 7 3c0-2 2.63-2 3-2 2.75 0 6 2.5 6 7'
const BACK_DETAIL =
  'M16 8q0 3.12-1.38 6.68a.5.5 0 0 1-.46.32H13a1 1 0 0 1-1-1 1 1 0 0 0-2 0 1 1 0 0 1-1 1H7.99a1.5 1.5 0 0 1-1.39-.94Q6 12.58 6 12c0-.3-.32-2.03-.45-4C8 8 4.6 3 7 3c0-2 2.63-2 3-2 2.75 0 6 2.5 6 7m-6-6a5 5 0 0 0-1.19.16c-.57.17-.81.4-.81.84a1 1 0 0 1-.91 1c-.01.23.04.58.18 1.3.2 1.06.27 1.5.2 2.05q-.14.95-.86 1.38l.13 1.2c.03.24.26 1.88.26 2.07l.02.16.09.37q.13.46.42 1.16c.07.19.26.31.46.31H9l.01-.2A2 2 0 0 1 13 14h.81q1.2-3.22 1.19-6c0-1.85-.62-3.4-1.69-4.49A4.8 4.8 0 0 0 10 2'
const BODY =
  'M5 15c-2 0-4-1.5-4-8 0-3.25 2-5.5 5.75-5.5C8.25 1.5 10 3 10 6c0 1.58-1.5 5-3.5 5h-1c-.75 0-1.5.25-1.5 1s.25 1 1 1a1 1 0 0 1 0 2M5 5a1 1 0 1 0 0 2 1 1 0 0 0 0-2'
const BODY_DETAIL =
  'M10 6c0 1.58-1.5 5-3.5 5h-1c-.75 0-1.5.25-1.5 1s.25 1 1 1a1 1 0 0 1 0 2c-2 0-4-1.5-4-8 0-3.25 2-5.5 5.75-5.5C8.25 1.5 10 3 10 6m-5 8h-.18zM2 7c0 2.87.4 4.8 1.1 5.9l.14.21Q3 12.66 3 12c0-.73.37-1.32.98-1.66Q4.65 10 5.5 10h1c.48 0 1.1-.5 1.64-1.42C8.66 7.71 9 6.63 9 6c0-1.18-.31-2.1-.83-2.73-.42-.5-.95-.77-1.42-.77C3.68 2.5 2 4.18 2 7m5-1a2 2 0 1 1-4 0 2 2 0 0 1 4 0M4 6a1 1 0 1 0 2 0 1 1 0 0 0-2 0'

export function BrandLogo({ size = 30, className = '' }: { size?: number; className?: string }) {
  const tileId = `brand-tile-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
  return (
    <svg
      className={`brand-logo ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={tileId} x1="10" y1="2" x2="54" y2="62" gradientUnits="userSpaceOnUse">
          <stop stopColor="#151A27" />
          <stop offset="1" stopColor="#0B0E16" />
        </linearGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill={`url(#${tileId})`} />
      <rect x="2.5" y="2.5" width="59" height="59" rx="15.5" fill="none" stroke="#FFFFFF" strokeOpacity=".08" />
      <g transform="translate(7.35 8.47) scale(2.9)">
        <path fill="var(--brand-blue, #3b82f6)" fillOpacity=".4" fillRule="evenodd" d={BACK} />
        <path fill="#f8fafc" fillOpacity=".1" d={BACK_DETAIL} />
        <path fill="var(--brand-blue, #3b82f6)" fillRule="evenodd" d={BODY} />
        <path fill="#f8fafc" fillOpacity=".1" d={BODY_DETAIL} />
      </g>
    </svg>
  )
}

/** Logo con el nombre y la descripción del producto, para pantallas de bienvenida. */
export function BrandLockup({ size = 42, title = 'Valet Deck' }: { size?: number; title?: string }) {
  return (
    <div className="brand-lockup">
      <BrandLogo size={size} />
      <div className="brand-lockup-text">
        <span className="brand-lockup-title">{title}</span>
        <span className="brand-lockup-tag">Laravel · PHP local development for Linux</span>
      </div>
    </div>
  )
}
