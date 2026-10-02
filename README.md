# Kyro Photo Selector

Elegí fotos como en Tinder: deslizá a la derecha las que te gustan y se copian (o mueven) a otra carpeta; a la izquierda, las que no. Funciona desde la PC, la notebook o el celular, con fotos de cualquier PC de la red que tenga Kyro abierto.

- Formatos: JPG, PNG, GIF, WebP, BMP, AVIF, SVG, **HEIC**, **TIFF** y **RAW** (NEF, CR2, CR3, ARW, DNG, RAF, ORF, RW2, PEF, SRW, 3FR, IIQ y más).
- Recorre la carpeta elegida **y todas sus subcarpetas**.
- Junta los pares **RAW + JPG** de la misma foto en una sola tarjeta.
- Muestra la metadata como un perfil de Tinder: cámara, lente, focal, apertura, velocidad, ISO, histograma, ubicación GPS y más.

## Instalación

1. Instalá **Node.js** (versión LTS) desde https://nodejs.org.
2. Descargá el proyecto: https://github.com/ciroamalosexcels-byte/Kyro/archive/refs/heads/main.zip y descomprimilo donde quieras.
3. (Opcional) Ejecutá **`instalar.cmd`**: agrega **"Elegir fotos con Kyro"** al clic derecho de las carpetas (en Windows 11 está en "Mostrar más opciones") y un acceso directo en el escritorio. `desinstalar.cmd` lo quita.

Para actualizar: cerrá Kyro, bajá el ZIP de nuevo y reemplazá la carpeta. La configuración de cada PC (`kyro-config.json`) no viene en el ZIP, así que conviene no borrarla.

## Uso

1. Doble clic en **`Kyro.cmd`** (o clic derecho en una carpeta → "Elegir fotos con Kyro"). Se abre una ventana negra, que es el servidor: **dejala abierta** mientras lo usás; cerrarla apaga Kyro.
2. La primera vez, Windows pregunta si Node.js puede usar la red: marcá **Redes privadas** y aceptá. Sin eso, ni el celular ni otras PCs se pueden conectar.
3. Elegí la carpeta con las fotos, la carpeta destino y qué hacer con cada foto:
   - **Matches ♥:** copiar o mover al destino.
   - **Descartes ✕:** dejarlos, moverlos a una subcarpeta "Descartadas" o borrarlos. Borrar es definitivo (no va a la papelera); se pueden deshacer los últimos 10.
   - **Agrupar RAW + JPG** y **Mantener las subcarpetas en el destino**.
4. Tocá **Empezar a matchear**. Las fotos aparecen mientras se siguen buscando.

Kyro recuerda las últimas carpetas y opciones de cada PC.

### Mientras elegís

- Deslizá la foto, o usá los botones: ↺ deshacer · ✕ nope · 🔍 100% · ♥ match · ⓘ datos.
- **Zoom:** rueda del mouse (acerca hacia el cursor), doble clic o `Z` para ver al 100%, dos dedos en el celular. Con zoom, arrastrar mueve la foto.
- **Saltear carpeta ⏭** (`S`): pasa a la próxima carpeta sin decidir las fotos que quedan.
- Las copias y los movimientos se hacen de fondo: no hace falta esperar para seguir deslizando.
- Panel izquierdo: carpetas, orden (nombre, fecha de modificación, fecha de captura, tamaño, tipo), progreso y miniaturas de matches y descartes.

### Atajos de teclado

`←` nope · `→` match · `Retroceso` o `Ctrl+Z` deshacer · `S` saltear carpeta · `Z` / `Espacio` / doble clic 100% · rueda zoom · `+` `−` `0` zoom · `I` o `↑` `↓` datos · `H` ocultar el texto sobre la foto · `F` pantalla completa

## Desde el celular u otro dispositivo

Botón **Compartir** (arriba a la izquierda, o "📱 Compartir" en la pantalla de inicio): muestra un **código QR** y el link, con botones para **Compartir**, **WhatsApp** y **Copiar link**.

- El dispositivo tiene que estar en la **misma red Wi-Fi**.
- El link es `http://IP-de-la-PC:8420`. **`localhost:8420` solo sirve en la PC donde corre Kyro**: en otro equipo hay que usar la IP que muestra Compartir.
- Todos los dispositivos ven la misma sesión: si deslizás en uno, los otros se actualizan.

## Varias PCs

Abrí Kyro en cada PC. Se encuentran solas en la red; si alguna no aparece, usá **+ Agregar PC** con su IP (o `IP:puerto`).

Al elegir una carpeta, primero elegís el equipo (por ejemplo "Esta PC · NOTEBOOK" o "DESKTOP-…") y después la carpeta. Así se puede, por ejemplo, elegir desde el celular las fotos de la PC de escritorio y mandar los matches a la notebook.

- La sesión corre en la PC que tiene las fotos, que las lee de su propio disco. Si la empezaste desde otro equipo, la página se pasa sola a la dirección de esa PC.
- Los matches se envían al Kyro de la PC destino, **conservando la fecha original** del archivo.
- Deshacer borra la copia en la otra PC (y, si era "mover", devuelve el original).
- **Las dos PCs tienen que tener Kyro abierto**, y la misma versión.

## Solución de problemas

| Síntoma | Causa y solución |
|---|---|
| "No se puede acceder a este sitio" en `localhost:8420` | Kyro no está abierto en *esa* PC. Abrí `Kyro.cmd`, o usá la IP de la PC donde sí está abierto. |
| El celular u otra PC no se conecta | Falta el permiso del firewall: Configuración de Windows → Firewall → Permitir una aplicación → Node.js → Privada. La red Wi-Fi tiene que estar marcada como **privada**. |
| La otra PC no aparece en la lista de equipos | Tiene que tener Kyro abierto y actualizado (las versiones viejas no saben hablar con otras PCs). Probá **+ Agregar PC** con su IP. |
| "No se puede crear la carpeta" con una ruta de otra PC | Las rutas siempre son de la PC elegida arriba en el explorador. Para una carpeta de otra PC, elegí primero ese equipo. |
| Las fotos tardan mucho en cargar desde una carpeta compartida de Windows (`\\PC\carpeta`) | Conviene correr Kyro en la PC que tiene las fotos. Si su disco es un HDD que "se duerme", el primer acceso puede tardar decenas de segundos y frena a cualquier programa: poné "Apagar disco duro tras: Nunca" (`powercfg /change disk-timeout-ac 0`), excluí la carpeta del antivirus y, si se puede, conectala por cable. |
| HEIC o TIFF no se ven | La primera vez hace falta internet para bajar el decodificador. |
| Un RAW se ve más chico que la foto real | Se muestra la vista previa que trae el RAW; algunas cámaras (Sony, ciertos DNG) la guardan en menor resolución. El panel de datos indica su tamaño. |

## Cómo está hecho

Sin dependencias: solo Node.js.

| Archivo | Qué hace |
|---|---|
| `server.js` | Servidor HTTP (puerto 8420). Sesión compartida, búsqueda de fotos, orden, fila de copias/movimientos/borrados con deshacer, explorador de carpetas, red de Kyros (anuncio por UDP en el puerto 8421 + saludo por HTTP) y envío de archivos entre PCs. |
| `lib/media.js` | Lectura de EXIF (JPG, HEIC, RAW basados en TIFF, CR3) y extracción de la vista previa de los RAW leyendo solo el encabezado y el JPG embebido (1–2 MB en vez del RAW entero). |
| `public/index.html` | Interfaz (PC y celular): tarjetas, zoom, histograma, explorador de carpetas, compartir con QR. |
| `Kyro.cmd` | Arranca el servidor. Si recibe una carpeta, la propone como origen; si Kyro ya está abierto, se la pasa a ese. |
| `instalar.cmd` / `desinstalar.cmd` | Menú de clic derecho y acceso directo. |
| `kyro-config.json` | Se crea solo: identificador de la PC, últimas carpetas y opciones, PCs agregadas a mano. No se sube a GitHub. |

Variables de entorno: `KYRO_PORT` (puerto, por defecto 8420; el descubrimiento usa el siguiente) y `KYRO_CONFIG` (ruta del archivo de configuración). `node server.js --no-open` arranca sin abrir el navegador.

### Seguridad

Kyro no tiene contraseña: cualquier dispositivo de la misma red puede ver las carpetas de las PCs que lo tengan abierto y copiar, mover o borrar fotos. Usalo solo en redes de confianza (la de tu casa) y cerralo cuando no lo uses.
