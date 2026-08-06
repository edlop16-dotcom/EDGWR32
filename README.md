# Notificaciones push gratis — Almacén TIENS PE902

Este repositorio es el "servidor" gratuito que revisa tu inventario cada hora
y te manda una notificación push **aunque tengas la app cerrada**. No cuesta
nada y no necesita tarjeta de crédito. Se apoya en:

- **GitHub Actions** — ejecuta `check-alerts.js` cada hora (gratis: 2,000
  minutos/mes en la cuenta gratuita; este chequeo tarda segundos).
- **Web Push + VAPID** — el estándar que usan todos los navegadores para
  mandar notificaciones a un dispositivo aunque la pestaña esté cerrada.
  No usa Firebase Cloud Messaging ni cuenta de servicio: es más simple y
  no depende de habilitar nada de pago en Firebase.
- **Tu misma base de datos de Firebase** (Realtime Database) — donde ya
  sincronizas el inventario. Ahí se guardan también las "suscripciones"
  push de cada dispositivo.

No hace falta saber programar para seguir estos pasos — son de copiar,
pegar y hacer clic.

---

## Paso 1 — Genera tus llaves VAPID (una sola vez)

En tu computadora, con [Node.js](https://nodejs.org) instalado, abre una
terminal en esta carpeta y corre:

```
npx web-push generate-vapid-keys
```

Te va a imprimir algo así (con valores distintos a este ejemplo):

```
Public Key:
BEl62iUYgUivxIkv69yViEuiBIa1HI0DUnE0OJTn6qHzgz1P5xJ7Fp8CtLJ5r2s3fXHkA8s6bZ6LnHhFvcpVLQg

Private Key:
5v9y8oOBjLnxN2Q6cW6Kv3EYr7hM4xz2Xk9tQdP1LmM
```

Guarda ambas — las vas a necesitar en los pasos 3 y 4. La **pública** también
la vas a pegar dentro de la app (Panel → sección Notificaciones).

⚠️ La llave **privada** no se comparte con nadie ni se sube al repositorio —
va únicamente como "Secret" de GitHub (paso 4), que está cifrado.

---

## Paso 2 — Reúne los datos de tu Firebase

Ya los tienes de cuando configuraste la sincronización en la app
(Más → Sincronizar):

- **FIREBASE_API_KEY**: el valor `apiKey` del bloque `firebaseConfig` que
  copiaste de Firebase.
- **FIREBASE_DB_URL**: el valor `databaseURL` de ese mismo bloque (algo como
  `https://tu-proyecto-default-rtdb.firebaseio.com`).
- **SYNC_CODE**: el código de sincronización que elegiste (ej. `TDCPE902`).

---

## Paso 3 — Sube esta carpeta a un repositorio de GitHub

1. Crea una cuenta gratis en [github.com](https://github.com) si no tienes.
2. Crea un repositorio nuevo — puede ser **privado** (recomendado, ya que
   aquí no van claves pero es buena práctica) o público, ambos gratis.
3. Sube todos los archivos de esta carpeta (`check-alerts.js`,
   `package.json`, la carpeta `.github/workflows/`, este `README.md`).
   La forma más simple sin usar la terminal: en la página del repo vacío,
   "uploading an existing file" → arrastra los archivos.

---

## Paso 4 — Agrega los "Secrets" del repositorio

En tu repositorio: **Settings → Secrets and variables → Actions → New
repository secret**. Crea estos 6, uno por uno (nombre exacto a la
izquierda, tu valor real a la derecha):

| Nombre del secret     | Valor                                         |
|------------------------|------------------------------------------------|
| `FIREBASE_API_KEY`     | El `apiKey` de tu `firebaseConfig`             |
| `FIREBASE_DB_URL`      | El `databaseURL` de tu `firebaseConfig`        |
| `SYNC_CODE`             | Tu código de sincronización (ej. `TDCPE902`)  |
| `VAPID_PUBLIC_KEY`      | La llave pública del Paso 1                    |
| `VAPID_PRIVATE_KEY`     | La llave privada del Paso 1                    |
| `VAPID_SUBJECT`         | `mailto:tu-correo@ejemplo.com` (cualquier correo tuyo, es solo para identificarte ante los navegadores) |

---

## Paso 5 — Activa las notificaciones dentro de la app

1. Abre la app (en el celular o la PC donde quieres recibir avisos).
2. Ve al **Panel** → sección "🔔 Notificaciones de alertas críticas".
3. Pega la **llave pública VAPID** (la misma del Paso 1) en el campo de texto.
4. Toca **"Activar notificaciones"** y acepta el permiso que pide el navegador.
5. Repite esto en cada dispositivo donde quieras recibir avisos — cada uno
   se suscribe por separado.

---

## Paso 6 — Pruébalo sin esperar a que pase una hora

En tu repositorio de GitHub: pestaña **Actions** → "Revisar alertas de
inventario" (a la izquierda) → botón **"Run workflow"** → Run workflow.
Tarda unos segundos; si todo está bien configurado, te debería llegar la
notificación al dispositivo que activaste en el Paso 5 (si hay alertas
pendientes en ese momento — si no hay ninguna, no llega nada, que es lo
correcto).

Si algo falla, entra al log de esa ejecución (clic en el círculo de
resultado) para ver el mensaje de error exacto — casi siempre es un secret
mal copiado (espacios de más, o el `databaseURL` sin el `https://`).

---

## ¿Cuánto cuesta esto en total?

**$0.** No se pide tarjeta de crédito en ningún paso:

- GitHub Actions: gratis hasta 2,000 minutos/mes en cuentas gratuitas —
  este chequeo corre 24 veces al día y tarda segundos cada vez, muy por
  debajo del límite.
- Web Push / VAPID: es un estándar abierto, no un servicio de pago.
- Firebase Realtime Database: sigue en el mismo plan gratuito (Spark) que
  ya usas para sincronizar — esto no le agrega carga significativa.

---

## Preguntas frecuentes

**¿Y si cambio de celular?** — Activa las notificaciones de nuevo desde el
nuevo dispositivo (Paso 5). El anterior, si ya no se usa, sus alertas
simplemente dejarán de recibirse con el tiempo (el script limpia
suscripciones vencidas automáticamente).

**¿Funciona en iPhone?** — Sí, pero solo si la app está **agregada a la
pantalla de inicio** (instalada como PWA) y con iOS 16.4 o más nuevo. Safari
abierto en una pestaña normal no puede recibir push en iOS.

**¿Puedo cambiar la frecuencia del chequeo?** — Sí, edita la línea `cron`
en `.github/workflows/check-alerts.yml`. Por ejemplo, `*/30 * * * *` seria
cada 30 minutos. No lo bajes de cada 5 minutos sin necesidad — no aporta
nada porque las alertas de inventario no cambian tan rápido, y evitas
gastar minutos gratis sin motivo.
