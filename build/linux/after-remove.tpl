#!/bin/bash
# postrm (afterRemove) del paquete .deb de Valet Deck.
#
# Al desinstalar con `apt remove` (o `apt purge`) se lleva por delante todo lo
# que el panel trajo: servicios, DNS, ayudantes root, datos del usuario y, en
# segundo plano, los paquetes del stack (nginx, PHP 8.5, Composer, MariaDB,
# dnsmasq-base, libnss3-tools) y el Node.js 26 de nvm.
#
# Dos reglas de oro:
#   1. Solo actúa en remove/purge. En un upgrade llega «upgrade» y no se toca
#      nada: la aplicación se actualiza, no se desinstala.
#   2. Nunca llama a apt-get en primer plano. dpkg ejecuta este script dentro
#      de la transacción de apt, que aún tiene el lock; un apt-get aquí se
#      quedaría esperando para siempre. El purgado se programa con
#      systemd-run para que corra cuando apt ya ha terminado.
#
# El script es idempotente y siempre sale con 0: un postrm no puede romper la
# desinstalación del paquete.

set +e

case "$1" in
  remove|purge) ;;
  *) exit 0 ;;
esac

# ---------------------------------------------------------------- aplicación
# El panel puede seguir vivo en la bandeja aunque dpkg ya haya borrado sus
# archivos: se detiene antes de tocar nada más.
pkill -f '/opt/ValetDeck/valetdeck' >/dev/null 2>&1

# ---------------------------------------------------------------- servicios
for svc in valet-studio-dns valet-dns nginx dnsmasq; do
  systemctl disable --now "$svc" >/dev/null 2>&1
done
# MariaDB solo se para si la instaló el panel. El marcador lo escribe el
# instalador justo después de instalar los paquetes.
if [ -f /var/lib/valet-studio/mariadb ]; then
  systemctl disable --now mariadb >/dev/null 2>&1
fi
# Todas las versiones de PHP-FPM que haya instaladas, no solo la del panel.
for unit in $(systemctl list-unit-files 'php*-fpm.service' --no-legend --no-pager 2>/dev/null | awk '{print $1}'); do
  systemctl disable --now "$unit" >/dev/null 2>&1
done

# ---------------------------------------------------------------- datos del usuario
# apt conserva SUDO_USER al ejecutar los scripts del paquete. Si se desinstala
# desde un entorno sin sudo, se busca el dueño de los datos del panel. Se
# resuelve antes que nada porque lo usan el DNS, el Valet y Mailpit.
OWNER="${SUDO_USER:-}"
if [ -z "$OWNER" ] || [ "$OWNER" = root ]; then
  OWNER=$(stat -c %U /home/*/.valet-studio 2>/dev/null | head -n 1)
fi
UHOME=""
if [ -n "$OWNER" ] && [ "$OWNER" != root ]; then
  UHOME=$(getent passwd "$OWNER" | cut -d: -f6)
fi

# ---------------------------------------------------------------- Valet
# El enlace /usr/local/bin/valet lo crea `valet install`; se guarda su destino
# antes de borrarlo para saber si el Valet activo era el del panel.
VALET_LINK=$(readlink -f /usr/local/bin/valet 2>/dev/null)
update-alternatives --remove 'valetdeck' '/opt/ValetDeck/valetdeck' >/dev/null 2>&1
rm -f /usr/bin/valetdeck
case "$VALET_LINK" in
  */.config/valet-studio/composer/*) rm -f /usr/local/bin/valet ;;
esac

# ---------------------------------------------------------------- DNS del panel
# El ayudante de root sabe deshacer los tres modos (safe, hosts y clásico);
# si ya no está, se limpian los mismos ficheros a mano.
if [ -x /usr/local/libexec/valet-studio/dns-helper.sh ]; then
  /usr/local/libexec/valet-studio/dns-helper.sh remove '' '' '' "${OWNER:-root}" >/dev/null 2>&1
else
  systemctl disable --now valet-studio-dns.service >/dev/null 2>&1
  rm -f /etc/systemd/system/valet-studio-dns.service
  rm -f /etc/systemd/resolved.conf.d/valet-studio.conf
  rm -rf /etc/valet-studio
  systemctl daemon-reload >/dev/null 2>&1
  systemctl restart systemd-resolved >/dev/null 2>&1
fi
# Restos del DNS clásico de Valet.
rm -f /etc/dnsmasq.d/valet /etc/NetworkManager/conf.d/valet.conf

# Configuración que crea `valet install` fuera de dpkg: nginx y el pool de
# PHP-FPM. Purgar nginx/php no los borra porque no son conffiles del paquete.
rm -f /etc/nginx/sites-enabled/valet.conf /etc/nginx/sites-available/valet.conf
rm -f /etc/php/*/fpm/pool.d/valet.conf

# Bloque gestionado de /etc/hosts, con los mismos marcadores del ayudante.
# Solo se toca si están el principio y el final: con el cierre ausente, el
# awk borraría todo lo que hubiera debajo.
if [ -f /etc/hosts ] &&
   grep -qxF '# BEGIN VALET STUDIO' /etc/hosts &&
   grep -qxF '# END VALET STUDIO' /etc/hosts; then
  HOSTS_TMP=$(mktemp)
  if awk -v b='# BEGIN VALET STUDIO' -v e='# END VALET STUDIO' '
      $0 == b { skip = 1; next }
      $0 == e { skip = 0; next }
      !skip { print }
    ' /etc/hosts > "$HOSTS_TMP"; then
    install -m 644 "$HOSTS_TMP" /etc/hosts
  fi
  rm -f "$HOSTS_TMP"
fi

# ---------------------------------------------------------------- ayudantes root
rm -rf /usr/local/libexec/valet-studio

# ---------------------------------------------------------------- datos del usuario
if [ -n "$OWNER" ] && [ "$OWNER" != root ]; then
  if [ -n "$UHOME" ] && [ -d "$UHOME" ]; then
    # Mailpit del panel: servicio de usuario, proceso y unidad.
    UID_N=$(id -u "$OWNER" 2>/dev/null)
    if [ -n "$UID_N" ] && [ -d "/run/user/$UID_N" ]; then
      runuser -u "$OWNER" -- env XDG_RUNTIME_DIR="/run/user/$UID_N" \
        systemctl --user disable --now valet-studio-mailpit.service >/dev/null 2>&1
    fi
    pkill -u "$OWNER" -f "$UHOME/.valet-studio/bin/mailpit" >/dev/null 2>&1
    rm -f "$UHOME/.config/systemd/user/valet-studio-mailpit.service"

    # ~/.valet solo se borra si el Valet activo era el Composer aislado del
    # panel: un Valet externo del usuario no se toca.
    case "$VALET_LINK" in
      "$UHOME/.config/valet-studio/composer/"*) rm -rf "$UHOME/.valet" ;;
    esac

    rm -rf "$UHOME/.valet-studio"          # backups y binarios de Mailpit
    rm -rf "$UHOME/.config/valet-studio"   # Composer aislado, configuración
    rm -rf "$UHOME/.config/Valet Deck" "$UHOME/.config/Valet Studio"  # userData de Electron
    rm -rf "$UHOME/.cache/valet-studio"    # caché de versiones anteriores
    rm -rf "$UHOME/.cache/Valet Deck" "$UHOME/.cache/ValetDeck" "$UHOME/.cache/valet-deck"
  fi
fi

# ---------------------------------------------------------------- paquetes del stack
# Se programan porque apt está en mitad de su transacción. Solo se purgan los
# que estén instalados: si el usuario tenía otra versión de PHP, no se toca.
CLEANUP=/var/lib/valet-studio-cleanup.sh
cat > "$CLEANUP" <<'CLEANUP_EOF'
#!/bin/bash
# Purgado diferido de Valet Deck: corre cuando apt ya soltó el lock.
set +e
OWNER="$1"
UHOME="$2"
export DEBIAN_FRONTEND=noninteractive

# La transacción de apt que nos ha lanzado termina en segundos; el timeout del
# lock cubre el caso de que tarde más.
APT="apt-get -o DPkg::Lock::Timeout=300 -y"

PURGE=""
for pkg in \
  nginx nginx-common \
  php8.5 php8.5-cli php8.5-common php8.5-fpm \
  php8.5-curl php8.5-mbstring php8.5-xml php8.5-zip php8.5-mysql \
  php8.5-sqlite3 php8.5-pgsql php8.5-gd php8.5-intl php8.5-soap \
  php8.5-opcache php8.5-imap \
  composer dnsmasq-base libnss3-tools
do
  if dpkg-query -s "$pkg" 2>/dev/null | grep -q '^Status: install ok installed'; then
    PURGE="$PURGE $pkg"
  fi
done

# MariaDB: solo si el panel la instaló (marcador de procedencia). Una MariaDB
# que ya estaba en el equipo conserva sus datos y su servicio.
if [ -f /var/lib/valet-studio/mariadb ]; then
  for pkg in mariadb-server mariadb-client; do
    if dpkg-query -s "$pkg" 2>/dev/null | grep -q '^Status: install ok installed'; then
      PURGE="$PURGE $pkg"
    fi
  done
fi

if [ -n "$PURGE" ]; then
  $APT purge $PURGE
fi
# Dependencias que quedaron huérfanas (php8.5-common, mariadb-common, etc.).
$APT autoremove --purge

# Node.js 26 instalado con nvm. nvm y otras versiones del usuario se quedan.
if [ -n "$UHOME" ] && [ -d "$UHOME/.nvm/versions/node" ]; then
  rm -rf "$UHOME"/.nvm/versions/node/v26*
fi

# Marcador de procedencia de MariaDB: ya no hace falta tras el purgado.
rm -rf /var/lib/valet-studio
rm -f /var/lib/valet-studio-cleanup.sh
CLEANUP_EOF
chmod 700 "$CLEANUP"

# systemd-run lo ejecuta fuera de la transacción de dpkg; si no hay systemd, se
# lanza en segundo plano con setsid.
LAUNCHED=0
if command -v systemd-run >/dev/null 2>&1; then
  if systemd-run --collect --unit=valet-studio-cleanup --on-active=3 \
      --property=StandardOutput=append:/var/log/valet-studio-cleanup.log \
      --property=StandardError=append:/var/log/valet-studio-cleanup.log \
      /bin/bash "$CLEANUP" "$OWNER" "$UHOME" >/dev/null 2>&1; then
    LAUNCHED=1
  fi
fi
if [ "$LAUNCHED" -eq 0 ]; then
  setsid /bin/bash "$CLEANUP" "$OWNER" "$UHOME" </dev/null \
    >/var/log/valet-studio-cleanup.log 2>&1 &
fi

exit 0
