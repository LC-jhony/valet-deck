// Abrir un sitio no puede limitarse a lanzar la URL: Valet solo responde si su
// `config.json` tiene dominio y el nombre resuelve en este equipo. Sin esa
// comprobación el navegador acaba en una pestaña muerta y el panel no dice por
// qué. Aquí se repara el dominio y, cuando no hay ningún DNS de Valet
// instalado, se sincroniza `/etc/hosts` antes de abrir.

import { lookup } from 'node:dns/promises'
import { existsSync } from 'node:fs'
import { shell } from 'electron'
import { syncHosts } from './install'
import { assertName, ensureValetDomain, siteUrl } from './valet'
import { trustValetCa } from './certs'

/** Un DNS propio (dinámico o clásico) no se pisa con entradas de /etc/hosts. */
const DNS_FILES = [
  '/etc/systemd/system/valet-studio-dns.service',
  '/etc/systemd/system/valet-dns.service',
  '/etc/dnsmasq.d/valet',
  '/etc/NetworkManager/conf.d/valet.conf'
]

const resolves = async (host: string): Promise<boolean> => {
  try { await lookup(host); return true } catch { return false }
}

const repairHint = (host: string) =>
  `The site ${host} does not resolve. Open Settings → Maintenance → Network and DNS and press Repair DNS.`

export async function openSite(name: string): Promise<void> {
  assertName(name)
  await ensureValetDomain()
  const url = await siteUrl(name)
  // Autorreparación: una instalación anterior pudo habilitar HTTPS sin que la
  // CA de Valet llegara al almacén de Chrome.
  if (url.startsWith('https:')) await trustValetCa()
  const host = new URL(url).hostname
  if (!(await resolves(host))) {
    // Solo se usa /etc/hosts en una máquina sin DNS de Valet: si el usuario
    // eligió el modo dinámico o el clásico, lo correcto es repararlo, no
    // cambiarlo por otro modo desde aquí.
    if (DNS_FILES.some((file) => existsSync(file))) throw new Error(repairHint(host))
    await syncHosts(() => undefined)
    if (!(await resolves(host))) throw new Error(repairHint(host))
  }
  await shell.openExternal(url)
}
