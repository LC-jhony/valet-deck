# Nota de riesgos de seguridad

Lair ejecuta software real del usuario y modifica la configuración del sistema. Esta nota describe los riesgos y las mitigaciones implementadas. **Léela antes de instalar la CA o el drop-in de DNS.**

## Modelo de confianza

- La confianza de los binarios **no depende del host**: todo se verifica con una firma Ed25519 cuya clave pública va embebida en el binario (`internal/assets/public.ed25519`). Un mirror comprometido no puede servir un artifact modificado.
- La clave privada de desarrollo (`keys/private.ed25519`) **no se embebe ni se distribuye**. Sirve solo para firmar manifiestos de prueba. Una clave de producción debe custodiarse fuera del repositorio.
- El daemon **nunca corre como root**. Se ejecuta como `lair@<usuario>` con `CAP_NET_BIND_SERVICE` únicamente (ambient capability) para enlazar 80/443. `NoNewPrivileges=yes` impide escalada posterior.
- Todos los listeners están en `127.0.0.1`. No hay sockets TCP remotos.

## Riesgos y mitigaciones

| Riesgo | Mitigación | Riesgo residual |
|---|---|---|
| Manifiesto manipulado o *rollback* | Firma Ed25519, esquema/canal/expiración y serial monótono por canal; caché reverificada al cargar | Si la clave pública embebida se sustituye en el binario, toda la cadena cae; protege el binario con hashes/checksums propios. |
| Mirror malicioso | Múltiples URLs base en orden de fallback; la firma, no el host, decide | Un mirror puede hacer DoS (negar el manifiesto), no falsificarlo. |
| Artifact corrupto o *yanked* | SHA-256 en streaming a `.part`, staging con `safeJoin`, build markers, rechazo de yanked y reemplazo automático | Un build firmado pero defectuoso sigue siendo confiable criptográficamente; depende del proceso de release. |
| Extracción con *path traversal* | `safeJoin` + `Prepare` + verificación de ejecutables esperados antes del rename | Ninguno conocido en el código propio. |
| DNS `*.test` secuestrado | El drop-in de `systemd-resolved` usa `Domains=~test`, es decir, **solo** `*.test` se envía al resolver local; el resto se reenvía upstream | Cualquier proceso local que escuche en `127.0.0.1:53535` podría responder si el puerto quedara libre; el daemon lo mantiene enlazado. |
| CA local instalada en el sistema | La CA es ECDSA P-256, clave `0600`, y se instala mediante un script que el usuario revisa; se puede revertir con `trust-ca.sh --remove` | **La CA es plenamente confiable para todo el sistema.** Cualquier proceso que obtenga `certs/ca-key.pem` puede emitir certificados válidos para cualquier dominio. Protege `certs/` y no lo compartas. |
| HTTPS engañoso en `*.test` | El servidor solo emite certificados para hosts bajo el dominio configurado (`test`) y fase TLS usa `GetCertificate` con validación del nombre | Un sitio `*.test` sigue siendo un sitio local; no implica identidad real. |
| API local sin autenticar | Socket unix en `run/` (`0700`), permiso `0600`, token aleatorio de 256 bits comparado en tiempo constante | Cualquier proceso del mismo usuario puede leer el token; eso equivale a controlar Lair, pero no a escalar privilegios. |
| Servicios con configuración externa | Bind/puerto forzados por `Spec`; MySQL/MariaDB validan `mysqld-auto.cnf` y rechazan claves que muevan puerto/bind/socket/datadir | Un servicio puede tener sus propias vulnerabilidades; Lair no los aísla (son procesos nativos del usuario). |
| Fuga de secretos en logs | Los logs de servicios van a `log/<id>.log` con `0600`; la API no expone variables de entorno | El cuerpo stderr de PHP se añade como comentario HTML a la respuesta **solo en desarrollo**; no lo expongas a redes no confiables (los listeners son loopback). |
| Daemon único | `Server.Serve` rechaza iniciarse si ya hay algo escuchando en el socket | Un socket huérfano se elimina solo si no responde. |

## Superficie privilegiada

El único código que toma privilegios es el contenido de:

- `<LAIR_HOME>/setup-privileged.sh` — instala unidad systemd, drop-in, regla polkit y drop-in de resolved;
- `<LAIR_HOME>/trust-ca.sh` — instala la CA en el store del sistema;
- `<LAIR_HOME>/revert-privileged.sh` — deshace todo lo anterior.

**No se ejecutan automáticamente.** El usuario debe revisarlos y ejecutarlos una vez con `sudo`/`pkexec`. La regla polkit concede control sobre `lair@<usuario>.service` **solo** al usuario dueño de esa unidad; no es una regla global para systemd.

## Recomendaciones

1. Ejecuta `lair install` desde un binario Lair obtenido por un canal en el que confíes.
2. Revisa los scripts generados antes de `sudo`.
3. Trata `certs/ca-key.pem` como un secreto; no lo sincronices ni lo subas a un repositorio.
4. Usa `lair uninstall` para revertir PATH, shims y CA antes de desinstalar el binario.
5. En máquinas con datos sensibles, evita instalar la CA en el store del sistema y usa `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` apuntando a `certs/ca.pem` en su lugar.

## Limitaciones conocidas

- No hay sandbox ni aislamiento de procesos: los servicios son procesos normales del usuario.
- El soporte macOS/Windows es actualmente una abstracción; la integración privilegiada real existe solo para Linux/systemd.
- El DNS propio es un resolver mínimo UDP: no implementa TCP, EDNS completo ni DNSSEC; confía en el upstream para el resto de nombres.
