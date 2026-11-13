# Especificación RPM de Valet Deck.
#
# electron-builder 25 empaqueta con fpm 1.9.3, que pasa un `--define buildroot`
# que rpm 6 ignora: el paquete falla con «File not found» en todos los ficheros.
# Esta especificación construye el mismo contenido con rpmbuild directamente.
#
# Se usa desde `npm run dist:rpm`, que define `_build_version` con la versión de
# package.json y deja el payload en `_sourcedir`.

%{!?_build_version:%global _build_version 0.1.0}

Name:           valet-deck
Version:        %{_build_version}
Release:        1
Summary:        Estudio de escritorio para gestionar Laravel Valet en Linux
License:        Proprietary
URL:            https://github.com/LC-jhony/valet-deck
Vendor:         LC-jhony <jhonyapm94@gmail.com>
Packager:       LC-jhony <jhonyapm94@gmail.com>
BuildArch:      x86_64
Requires:       gtk3
Requires:       libnotify
Requires:       nss
Requires:       libXScrnSaver
Requires:       xdg-utils
Requires:       at-spi2-core
Requires:       libuuid

%description
Estudio de escritorio para gestionar Laravel Valet en Linux: sitios, PHP, DNS,
bases de datos, correo local, servicios y puertos.

%install
mkdir -p %{buildroot}/opt/ValetDeck
cp -a %{_sourcedir}/payload/. %{buildroot}/opt/ValetDeck/
install -D -m 0644 %{_sourcedir}/valet-deck.desktop %{buildroot}/usr/share/applications/valet-deck.desktop
for size in 16 24 32 48 64 128 256 512 1024; do
  install -D -m 0644 %{_sourcedir}/icon-${size}.png %{buildroot}/usr/share/icons/hicolor/${size}x${size}/apps/valet-deck.png
done

%files
/opt/ValetDeck
/usr/share/applications/valet-deck.desktop
/usr/share/icons/hicolor/16x16/apps/valet-deck.png
/usr/share/icons/hicolor/24x24/apps/valet-deck.png
/usr/share/icons/hicolor/32x32/apps/valet-deck.png
/usr/share/icons/hicolor/48x48/apps/valet-deck.png
/usr/share/icons/hicolor/64x64/apps/valet-deck.png
/usr/share/icons/hicolor/128x128/apps/valet-deck.png
/usr/share/icons/hicolor/256x256/apps/valet-deck.png
/usr/share/icons/hicolor/512x512/apps/valet-deck.png
/usr/share/icons/hicolor/1024x1024/apps/valet-deck.png

%post
if type update-alternatives 2>/dev/null >&1; then
    update-alternatives --install '/usr/bin/valetdeck' 'valetdeck' '/opt/ValetDeck/valetdeck' 100 || ln -sf '/opt/ValetDeck/valetdeck' '/usr/bin/valetdeck'
else
    ln -sf '/opt/ValetDeck/valetdeck' '/usr/bin/valetdeck'
fi

# El sandbox SUID es necesario cuando el kernel restringe los user namespaces
# sin privilegios (Ubuntu 24.04 y posteriores). El %post se ejecuta como root,
# así que el test de `unshare` no refleja lo que puede hacer el usuario: se deja
# chrome-sandbox en 4755 siempre.
chmod 4755 '/opt/ValetDeck/chrome-sandbox' || true

%postun
if [ "$1" = "0" ]; then
    if type update-alternatives 2>/dev/null >&1; then
        update-alternatives --remove 'valetdeck' '/opt/ValetDeck/valetdeck' || true
    fi
    rm -f '/usr/bin/valetdeck'
fi

%changelog
* Thu Nov 12 2026 LC-jhony <jhonyapm94@gmail.com> - 0.1.0-1
- Primera publicación pública de Valet Deck.
- Gestión de sitios, PHP, Node.js, bases de datos, correo, DNS y servicios.
- Borrado seguro de sitios desde el panel.
- Actualizaciones de la app desde GitHub Releases.
