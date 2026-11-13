// Scripts que se ejecutan como root vía pkexec. Viven aparte de install.ts para
// poder comprobar su sintaxis sin cargar Electron.

/**
 * Función bash compartida por los ayudantes de root: comprueba que el destino de
 * una copia cuelga de las copias del panel y que el camino resuelto no sale de
 * ahí. Sin esto, un enlace simbólico en el home del usuario podría hacer que
 * root escribiera o cediera la propiedad de archivos del sistema.
 */
export const SAFE_DEST_FN = String.raw`safe_dest() {
  local dest="$1" owner="$2" home backups parent real
  [ -n "$dest" ] || fail "missing backup destination"
  [ -n "$owner" ] || fail "missing backup owner"
  home="$(readlink -f "$(getent passwd "$owner" | cut -d: -f6)" 2>/dev/null)"
  [ -n "$home" ] || fail "could not resolve the home of $owner"
  backups="$home/.valet-studio/backups"
  parent="$(dirname "$dest")"
  mkdir -p "$parent"
  real="$(readlink -f "$parent")"
  case "$real" in
    "$backups"/?*) ;;
    *) fail "backup destination outside the panel: $dest" ;;
  esac
  # Las rutas ya están resueltas: ceder la propiedad aquí no puede tocar /etc.
  if [ -d "$backups" ]; then chown "$owner" "$backups"; fi
  chown "$owner" "$real"
  mkdir -m 0700 "$dest" || fail "the backup destination already exists: $dest"
  chown "$owner" "$dest"
}`

export const DNS_SCRIPT = String.raw`#!/bin/bash
set -Eeo pipefail
umask 022
MODE="$1"
TLD="$2"
BACKUP_DIR="$3"
HOSTS_FILE="$4"
OWNER="$5"
HOSTS_BEGIN="# BEGIN VALET STUDIO"
HOSTS_END="# END VALET STUDIO"

log() { printf '%s\n' "$*"; }
fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || fail "root is required"

${SAFE_DEST_FN}

INTERNET_BEFORE=0
getent hosts example.com >/dev/null 2>&1 && INTERNET_BEFORE=1 || true

backup() {
  [ -n "$BACKUP_DIR" ] || return 0
  safe_dest "$BACKUP_DIR" "$OWNER"
  for f in /etc/resolv.conf /etc/dnsmasq.conf /etc/dnsmasq.d /etc/default/dnsmasq /etc/NetworkManager/NetworkManager.conf /etc/NetworkManager/conf.d /etc/systemd/resolved.conf /etc/systemd/resolved.conf.d /etc/hosts /etc/valet-studio /etc/systemd/system/valet-studio-dns.service; do
    [ -e "$f" ] || continue
    cp -a "$f" "$BACKUP_DIR/$(basename "$f").$(date +%s%N)"
  done
  chown -R -h "$OWNER" "$BACKUP_DIR" 2>/dev/null || true
}

remove_hosts_block() {
  [ -f /etc/hosts ] || return 0
  # Sin los dos marcadores no se toca nada: si falta el de cierre, el awk
  # borraría todas las líneas que hubiera debajo.
  grep -qxF "$HOSTS_BEGIN" /etc/hosts || return 0
  grep -qxF "$HOSTS_END" /etc/hosts || return 0
  local tmp
  tmp="$(mktemp)"
  awk -v b="$HOSTS_BEGIN" -v e="$HOSTS_END" '
    $0 == b { skip=1; next }
    $0 == e { skip=0; next }
    !skip { print }
  ' /etc/hosts > "$tmp"
  install -m 644 "$tmp" /etc/hosts
  rm -f "$tmp"
}

remove_safe() {
  systemctl disable --now valet-studio-dns.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/valet-studio-dns.service
  rm -f /etc/systemd/resolved.conf.d/valet-studio.conf
  rm -rf /etc/valet-studio
  systemctl daemon-reload >/dev/null 2>&1 || true
  systemctl restart systemd-resolved >/dev/null 2>&1 || true
}

# ── Restos del DNS clásico de Valet ──────────────────────────────────────────
# Valet 2.4.5 puede dejar un dnsmasq propio, un dns=none en NetworkManager y
# /etc/resolv.conf apuntando a 127.0.0.1. Antes de aplicar el DNS dinámico se
# retiran esos restos y se devuelve resolv.conf a systemd-resolved. Si internet
# funcionaba antes y deja de hacerlo, se restaura la copia y se aborta.
classic_present() {
  [ -e /etc/dnsmasq.d/valet ] && return 0
  [ -e /etc/NetworkManager/conf.d/valet.conf ] && return 0
  [ -e /etc/systemd/system/valet-dns.service ] && return 0
  if systemctl list-unit-files valet-dns.service >/dev/null 2>&1; then
    systemctl list-unit-files valet-dns.service 2>/dev/null | grep -q '^valet-dns\.service' && return 0
  fi
  if [ -e /etc/resolv.conf ] && [ ! -L /etc/resolv.conf ] && grep -Eq '^[[:space:]]*nameserver[[:space:]]+127\.0\.0\.1([[:space:]]|$)' /etc/resolv.conf 2>/dev/null; then
    return 0
  fi
  return 1
}

restore_resolv() {
  # Solo se toca si es un fichero normal con el resolutor local del Valet
  # clásico; un enlace correcto o un resolv.conf gestionado por la distro se
  # quedan como están.
  if [ -e /etc/resolv.conf ] && [ ! -L /etc/resolv.conf ] && grep -Eq '^[[:space:]]*nameserver[[:space:]]+127\.0\.0\.1([[:space:]]|$)' /etc/resolv.conf 2>/dev/null; then
    if [ -f /run/systemd/resolve/stub-resolv.conf ]; then
      ln -sfn /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
      log "resolv.conf restored to systemd-resolved"
    fi
  fi
  if [ -f /run/systemd/resolve/stub-resolv.conf ] && ! systemctl is-active --quiet systemd-resolved; then
    systemctl enable --now systemd-resolved >/dev/null 2>&1 || true
  fi
}

cleanup_classic() {
  local rollback="$1"
  [ -n "$rollback" ] || rollback=yes
  local resolv_copy="" nm_copy="" nm_dns_copy=""
  [ -n "$BACKUP_DIR" ] || fail "missing backup destination"
  classic_present || { log "No classic Valet DNS leftovers"; return 0; }

  mkdir -p "$BACKUP_DIR"
  if [ -e /etc/resolv.conf ]; then
    resolv_copy="$BACKUP_DIR/resolv.conf.before-cleanup"
    cp -a /etc/resolv.conf "$resolv_copy"
  fi
  if [ -e /etc/NetworkManager/NetworkManager.conf ]; then
    nm_copy="$BACKUP_DIR/NetworkManager.conf.before-cleanup"
    cp -a /etc/NetworkManager/NetworkManager.conf "$nm_copy"
  fi
  if [ -e /etc/NetworkManager/conf.d/valet.conf ]; then
    nm_dns_copy="$BACKUP_DIR/valet.conf.before-cleanup"
    cp -a /etc/NetworkManager/conf.d/valet.conf "$nm_dns_copy"
  fi

  systemctl disable --now valet-dns.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/valet-dns.service
  rm -f /etc/dnsmasq.d/valet
  rm -f /etc/NetworkManager/conf.d/valet.conf
  rm -f /etc/NetworkManager/dnsmasq.d/valet
  systemctl daemon-reload >/dev/null 2>&1 || true

  restore_resolv
  systemctl restart NetworkManager >/dev/null 2>&1 || true
  systemctl restart systemd-resolved >/dev/null 2>&1 || true
  sleep 1

  if [ "$INTERNET_BEFORE" -eq 1 ] && ! getent hosts example.com >/dev/null 2>&1; then
    if [ "$rollback" = "yes" ]; then
      [ -n "$resolv_copy" ] && cp -a "$resolv_copy" /etc/resolv.conf
      [ -n "$nm_copy" ] && cp -a "$nm_copy" /etc/NetworkManager/NetworkManager.conf
      [ -n "$nm_dns_copy" ] && cp -a "$nm_dns_copy" /etc/NetworkManager/conf.d/valet.conf
      systemctl restart NetworkManager >/dev/null 2>&1 || true
      systemctl restart systemd-resolved >/dev/null 2>&1 || true
      fail "General DNS stopped resolving after cleaning the classic Valet DNS; the previous configuration was restored"
    fi
    log "Internet still does not resolve; check /etc/resolv.conf by hand"
  fi

  if [ -n "$resolv_copy" ]; then chown "$OWNER" "$resolv_copy" 2>/dev/null || true; fi
  if [ -n "$nm_copy" ]; then chown "$OWNER" "$nm_copy" 2>/dev/null || true; fi
  if [ -n "$nm_dns_copy" ]; then chown "$OWNER" "$nm_dns_copy" 2>/dev/null || true; fi
  log "Classic Valet DNS leftovers removed"
}

install_safe() {
  [ -n "$TLD" ] || fail "empty TLD"
  [[ "$TLD" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || fail "invalid TLD"
  systemctl is-active --quiet systemd-resolved || fail "systemd-resolved is not running"
  [ -x /usr/sbin/dnsmasq ] || fail "dnsmasq is not installed"

  cleanup_classic
  remove_safe
  remove_hosts_block
  mkdir -p /etc/valet-studio /etc/systemd/resolved.conf.d

  cat > /etc/valet-studio/dnsmasq.conf <<EOF
port=5354
listen-address=127.0.0.1
bind-interfaces
no-resolv
no-hosts
local-ttl=0
log-facility=-
address=/$TLD/127.0.0.1
EOF

  cat > /etc/systemd/system/valet-studio-dns.service <<EOF
[Unit]
Description=Valet Deck DNS (.$TLD)
After=network.target

[Service]
ExecStart=/usr/sbin/dnsmasq --keep-in-foreground --conf-file=/etc/valet-studio/dnsmasq.conf
Restart=on-failure
User=root

[Install]
WantedBy=multi-user.target
EOF

  cat > /etc/systemd/resolved.conf.d/valet-studio.conf <<EOF
[Resolve]
DNS=127.0.0.1:5354
Domains=~$TLD
EOF

  /usr/sbin/dnsmasq --test --conf-file=/etc/valet-studio/dnsmasq.conf >/dev/null || { remove_safe; fail "dnsmasq rejected the configuration"; }
  systemctl daemon-reload || { remove_safe; fail "Could not reload systemd"; }
  systemctl enable --now valet-studio-dns.service || { remove_safe; fail "Could not start safe DNS"; }
  systemctl restart systemd-resolved || { remove_safe; fail "Could not restart systemd-resolved"; }
  sleep 1
  if ! getent hosts "valet-studio.$TLD" | grep -q '127.0.0.1'; then
    remove_safe
    fail "Could not resolve valet-studio.$TLD; the configuration was restored"
  fi
  if [ "$INTERNET_BEFORE" -eq 1 ] && ! getent hosts example.com >/dev/null 2>&1; then
    remove_safe
    fail "General DNS stopped resolving; the configuration was restored"
  fi
  log "DNS seguro activo: *.$TLD -> 127.0.0.1:5354"
}

install_hosts() {
  [ -f "$HOSTS_FILE" ] || fail "The hosts file does not exist"
  if grep -Evq '^(127\.0\.0\.1 [A-Za-z0-9.-]+|#|$)' "$HOSTS_FILE"; then
    fail "The hosts file contains invalid lines"
  fi
  cleanup_classic
  remove_safe
  [ -f /etc/hosts ] || : > /etc/hosts
  local tmp
  tmp="$(mktemp)"
  awk -v b="$HOSTS_BEGIN" -v e="$HOSTS_END" '
    $0 == b { skip=1; next }
    $0 == e { skip=0; next }
    !skip { print }
  ' /etc/hosts > "$tmp"
  {
    printf '%s\n' "$HOSTS_BEGIN"
    cat "$HOSTS_FILE"
    printf '%s\n' "$HOSTS_END"
  } >> "$tmp"
  install -m 644 "$tmp" /etc/hosts
  rm -f "$tmp"
  log "Host entries updated"
}

remove_all() {
  remove_safe
  remove_hosts_block
  cleanup_classic no
  log "Valet Deck DNS removed"
}

backup

case "$MODE" in
  safe) install_safe ;;
  hosts) install_hosts ;;
  cleanup-classic) cleanup_classic ;;
  remove) remove_all ;;
  *) fail "Unknown mode: $MODE" ;;
esac
`

export const BACKUP_SCRIPT = String.raw`#!/bin/bash
set -Eeo pipefail
umask 077
DEST="$1"
OWNER="$2"

fail() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ -n "$DEST" ] && [ -n "$OWNER" ] || exit 1
[ "$(id -u)" -eq 0 ] || fail "root is required"

${SAFE_DEST_FN}

safe_dest "$DEST" "$OWNER"
for f in /etc/nginx /etc/php /etc/apache2 /etc/dnsmasq.conf /etc/dnsmasq.d /etc/default/dnsmasq /etc/resolv.conf /etc/NetworkManager/NetworkManager.conf /etc/NetworkManager/conf.d /etc/systemd/resolved.conf /etc/systemd/resolved.conf.d /etc/hosts /etc/valet-studio /usr/local/bin/valet; do
  [ -e "$f" ] || continue
  cp -a "$f" "$DEST/"
done
chown -R -h "$OWNER" "$DEST" 2>/dev/null || true
`
