// check-alerts.js
const nodemailer = require("nodemailer");

const {
  FIREBASE_API_KEY,
  FIREBASE_DB_URL,
  SYNC_CODE,
  GMAIL_USER,
  GMAIL_APP_PASSWORD,
  ALERT_EMAIL,
} = process.env;

function required(name, val){
  if(!val){
    console.error(`Falta la variable de entorno ${name}`);
    process.exit(1);
  }
  return val;
}
required("FIREBASE_API_KEY", FIREBASE_API_KEY);
required("FIREBASE_DB_URL", FIREBASE_DB_URL);
required("SYNC_CODE", SYNC_CODE);
required("GMAIL_USER", GMAIL_USER);
required("GMAIL_APP_PASSWORD", GMAIL_APP_PASSWORD);
required("ALERT_EMAIL", ALERT_EMAIL);

const DB_URL = FIREBASE_DB_URL.replace(/\/$/, "");

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_APP_PASSWORD,
  },
});

async function signInAnon(){
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${FIREBASE_API_KEY}`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({returnSecureToken:true})
  });
  if(!res.ok) throw new Error("No se pudo autenticar: "+await res.text());
  const data = await res.json();
  return data.idToken;
}

async function readSyncNode(idToken){
  const res = await fetch(`${DB_URL}/sync/${SYNC_CODE}.json?auth=${idToken}`);
  if(!res.ok) throw new Error("No se pudo leer: "+await res.text());
  return res.json();
}

async function patchSyncNode(idToken, patch){
  const res = await fetch(`${DB_URL}/sync/${SYNC_CODE}.json?auth=${idToken}`, {
    method: "PATCH",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify(patch)
  });
  if(!res.ok) throw new Error("No se pudo actualizar: "+await res.text());
}

// Lee el inventario del nodo de sincronización.
// Desde la app v89 el inventario se guarda POR RAMAS en sync/<código>/v2
// (v2/catalog, v2/lots, v2/movs...). El nodo antiguo "state" quedó congelado
// al migrar y ya no se actualiza: leerlo daba alertas con datos viejos.
function leerEstado(node){
  const v2 = node && node.v2;
  if(v2 && v2.catalog && v2.lots){
    const rama = (r)=>{
      const n = v2[r];
      if(!n) return null;
      return typeof n.d === "string" ? JSON.parse(n.d) : n.d;
    };
    return {
      catalog: rama("catalog") || [],
      lots: rama("lots") || [],
      settings: rama("settings") || {},
      solicitudes: rama("solicitudes") || [],
      // Firebase devuelve los movimientos (claves numéricas) como un arreglo con huecos null: se filtran
      movimientos: Object.values(v2.movs || {}).filter(m=>m && m.fecha).sort((a,b)=>String(b.fecha).localeCompare(String(a.fecha))),
      actualizadoEn: (v2.meta && v2.meta.updatedAt) ? new Date(v2.meta.updatedAt) : null,
      formato: "v2",
    };
  }
  if(node && node.state){
    const st = JSON.parse(node.state); // respaldo: formato antiguo (app anterior a v89)
    st.actualizadoEn = null;
    st.formato = "antiguo";
    return st;
  }
  return null;
}

const DIAS_RETRASO_SOLICITUD = 4; // días de margen tras la fecha estimada de llegada
const DIAS_STOCK_MUERTO = 30;     // días sin movimiento para considerar stock muerto
const HORAS_DATOS_VIEJOS = 48;    // si el inventario no se actualiza en este tiempo, se avisa en el correo

function daysTo(iso){
  if(!iso) return null;
  const d = new Date(iso+"T00:00:00");
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.round((d - today) / 86400000);
}
// Igual que daysTo pero en sentido contrario: días transcurridos DESDE una fecha pasada.
function daysSince(iso){
  const d = daysTo(iso);
  return d===null ? null : -d;
}
function esFaltante(l){ return (l.lote||"").trim().toUpperCase() === "FALTANTE"; }
// Igual que en la app: Almacén + Repisa + Exhibición + Pasillo
function totalLot(l){ return (l.almacen||0)+(l.repisa||0)+(l.exhibicion||0)+(l.pasillo||0); }
function totalProducto(cod, lots){ return lots.filter(l=>l.cod===cod).reduce((s,l)=>s+totalLot(l),0); }
// Total real: excluye lotes FALTANTE (son un marcador de compra pendiente, no stock físico).
function totalRealProducto(cod, lots){ return lots.filter(l=>l.cod===cod && !esFaltante(l)).reduce((s,l)=>s+totalLot(l),0); }
function solicitudTotales(s){
  const items = s.items || [];
  const pedido = items.reduce((a,it)=>a+(it.cantidadPedida||0),0);
  const recibido = items.reduce((a,it)=>a+(it.cantidadRecibida||0),0);
  return {pedido, recibido};
}

function computeAlerts(state){
  const catalog = state.catalog || [];
  const lots = state.lots || [];
  const movimientos = state.movimientos || [];
  const solicitudes = state.solicitudes || [];

  const productosBajoReorden = catalog.filter(c=>{
    if(!c.puntoReorden || c.puntoReorden<=0) return false;
    return totalProducto(c.cod, lots) <= c.puntoReorden;
  });
  const lotesPorVencer = lots.filter(l=>{
    const d = daysTo(l.vencimiento);
    return d!==null && d>=0 && d<=60 && totalLot(l)>0 && !esFaltante(l);
  });
  const lotesVencidos = lots.filter(l=>{
    const d = daysTo(l.vencimiento);
    return d!==null && d<0 && totalLot(l)>0 && !esFaltante(l);
  });

  // Stock en cero: rotura total (stock real, sin contar lotes FALTANTE)
  const productosStockCero = catalog.filter(c=> totalRealProducto(c.cod, lots) <= 0);

  // Lotes FALTANTE sin resolver (compra pendiente marcada pero aún no llega)
  const lotesFaltanteSinResolver = lots.filter(l=> esFaltante(l) && totalLot(l) > 0);

  // Solicitudes de ingreso atrasadas: no completas/canceladas y ya pasó la fecha estimada + margen
  const solicitudesAtrasadas = solicitudes.filter(s=>{
    if(["completa","cancelada"].includes(s.estado)) return false;
    const dias = daysSince(s.fecha);
    return dias !== null && dias >= DIAS_RETRASO_SOLICITUD;
  });

  // Stock muerto: producto con stock real > 0 pero sin ningún movimiento en los últimos N días
  const productosStockMuerto = catalog.filter(c=>{
    if(totalRealProducto(c.cod, lots) <= 0) return false;
    const movsProducto = movimientos.filter(m=>m.cod===c.cod);
    if(!movsProducto.length) return true; // nunca tuvo movimiento registrado
    const ultimaFecha = movsProducto.reduce((max,m)=> m.fecha > max ? m.fecha : max, movsProducto[0].fecha);
    const dias = daysSince(ultimaFecha.slice(0,10));
    return dias !== null && dias >= DIAS_STOCK_MUERTO;
  });

  return {
    productosBajoReorden, lotesPorVencer, lotesVencidos,
    productosStockCero, lotesFaltanteSinResolver, solicitudesAtrasadas, productosStockMuerto,
  };
}

function buildHash({productosBajoReorden, lotesPorVencer, lotesVencidos, productosStockCero, lotesFaltanteSinResolver, solicitudesAtrasadas, productosStockMuerto}){
  const parts = [
    ...productosBajoReorden.map(c=>"R:"+c.cod),
    ...lotesVencidos.map(l=>"V:"+l.id),
    ...lotesPorVencer.map(l=>"P:"+l.id),
    ...productosStockCero.map(c=>"Z:"+c.cod),
    ...lotesFaltanteSinResolver.map(l=>"F:"+l.id),
    ...solicitudesAtrasadas.map(s=>"S:"+s.id),
    ...productosStockMuerto.map(c=>"M:"+c.cod),
  ].sort();
  return parts.join("|");
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, ch => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[ch]));
}

function fechaPeru(d){
  return d ? d.toLocaleString("es-PE", {timeZone:"America/Lima", day:"2-digit", month:"2-digit", year:"numeric", hour:"2-digit", minute:"2-digit"}) : "desconocida";
}

function buildEmail(alerts, meta){
  const {productosBajoReorden, lotesPorVencer, lotesVencidos, productosStockCero, lotesFaltanteSinResolver, solicitudesAtrasadas, productosStockMuerto} = alerts;
  const criticos = productosStockCero.length + solicitudesAtrasadas.length;
  const horasSinActualizar = meta.actualizadoEn ? (Date.now() - meta.actualizadoEn.getTime())/3600000 : null;
  const datosViejos = horasSinActualizar === null || horasSinActualizar > HORAS_DATOS_VIEJOS;
  const avisoDatos = datosViejos
    ? (horasSinActualizar === null
        ? "⚠ No se pudo confirmar la fecha de los datos (formato antiguo)"
        : `⚠ El inventario no se actualiza hace ${Math.floor(horasSinActualizar/24)} día(s)`)
    : "";
  const subject = `Almacén TIENS PE902 — ${datosViejos ? "⚠ datos sin actualizar · " : ""}${criticos>0 ? `⚠ ${criticos} crítico(s) · `: ""}${productosBajoReorden.length} bajo reorden · ${lotesVencidos.length} vencidos`;

  const section = (titulo, items, renderItem) => {
    if(!items.length) return "";
    return `<h3 style="margin:16px 0 8px;font-family:sans-serif;color:#222">${titulo} (${items.length})</h3>
      <ul style="font-family:sans-serif;font-size:14px;color:#333;padding-left:20px;margin:0">
        ${items.map(renderItem).join("")}
      </ul>`;
  };

  const html = `
    <div style="font-family:sans-serif;max-width:600px">
      <h2 style="color:#111">Almacén TIENS PE902 / JULIACA — Alertas de inventario</h2>
      <p style="font-family:sans-serif;font-size:13px;color:#555;margin:0 0 8px">Inventario actualizado: <b>${escapeHtml(fechaPeru(meta.actualizadoEn))}</b> (hora Perú)</p>
      ${avisoDatos ? `<p style="font-family:sans-serif;font-size:13px;color:#b00020;font-weight:bold;margin:0 0 8px">${escapeHtml(avisoDatos)} — revisa que la app esté sincronizando.</p>` : ""}
      ${section("🔴 Stock en cero (rotura total)", productosStockCero, c =>
        `<li>${escapeHtml(c.cod)} — ${escapeHtml(c.nombre||"")}</li>`)}
      ${section("🔴 Solicitudes de ingreso atrasadas (+"+DIAS_RETRASO_SOLICITUD+" días)", solicitudesAtrasadas, s =>
        `<li>${escapeHtml(s.numero||s.id)} — ${escapeHtml(s.proveedor||"s/proveedor")} — esperada ${escapeHtml(s.fecha||"")} — estado: ${escapeHtml(s.estado||"")}</li>`)}
      ${section("Productos bajo punto de reorden", productosBajoReorden, c =>
        `<li>${escapeHtml(c.cod)} — ${escapeHtml(c.nombre||"")} — stock: ${totalProducto(c.cod, meta.lots)} (reorden: ${c.puntoReorden})</li>`)}
      ${section("Lotes vencidos", lotesVencidos, l =>
        `<li>${escapeHtml(l.cod)} — lote ${escapeHtml(l.lote||"")} — venció ${escapeHtml(l.vencimiento||"")}</li>`)}
      ${section("Lotes por vencer (≤60 días)", lotesPorVencer, l =>
        `<li>${escapeHtml(l.cod)} — lote ${escapeHtml(l.lote||"")} — vence ${escapeHtml(l.vencimiento||"")}</li>`)}
      ${section("Lotes FALTANTE sin resolver (compra pendiente)", lotesFaltanteSinResolver, l =>
        `<li>${escapeHtml(l.cod)} — ${totalLot(l)} uds. pendientes</li>`)}
      ${section("Stock muerto (sin movimiento en "+DIAS_STOCK_MUERTO+"+ días)", productosStockMuerto, c =>
        `<li>${escapeHtml(c.cod)} — ${escapeHtml(c.nombre||"")}</li>`)}
      <p style="font-family:sans-serif;font-size:12px;color:#888;margin-top:20px">
        Generado automáticamente por check-alerts.js
      </p>
    </div>`;

  const text = [
    "Almacén TIENS PE902 / JULIACA — Alertas de inventario",
    `Inventario actualizado: ${fechaPeru(meta.actualizadoEn)} (hora Perú)`,
    avisoDatos,
    "",
    `Stock en cero (${productosStockCero.length}): ${productosStockCero.map(c=>c.cod).join(", ")||"-"}`,
    `Solicitudes atrasadas (${solicitudesAtrasadas.length}): ${solicitudesAtrasadas.map(s=>s.numero||s.id).join(", ")||"-"}`,
    `Bajo reorden (${productosBajoReorden.length}): ${productosBajoReorden.map(c=>c.cod+" ("+totalProducto(c.cod, meta.lots)+"/"+c.puntoReorden+")").join(", ")||"-"}`,
    `Vencidos (${lotesVencidos.length}): ${lotesVencidos.map(l=>l.cod+"/"+l.lote).join(", ")||"-"}`,
    `Por vencer (${lotesPorVencer.length}): ${lotesPorVencer.map(l=>l.cod+"/"+l.lote).join(", ")||"-"}`,
    `FALTANTE sin resolver (${lotesFaltanteSinResolver.length}): ${lotesFaltanteSinResolver.map(l=>l.cod).join(", ")||"-"}`,
    `Stock muerto (${productosStockMuerto.length}): ${productosStockMuerto.map(c=>c.cod).join(", ")||"-"}`,
  ].join("\n");

  return {subject, html, text};
}

async function main(){
  console.log("Autenticando...");
  const idToken = await signInAnon();
  console.log("Leyendo inventario...");
  const node = await readSyncNode(idToken);
  const state = leerEstado(node);
  if(!state){
    console.log("No hay inventario guardado.");
    return;
  }
  console.log(`Formato de datos: ${state.formato} · inventario actualizado: ${fechaPeru(state.actualizadoEn)} (hora Perú) · ${(state.catalog||[]).length} productos, ${(state.lots||[]).length} lotes, ${(state.movimientos||[]).length} movimientos`);
  const alerts = computeAlerts(state);
  const total = alerts.productosBajoReorden.length + alerts.lotesPorVencer.length + alerts.lotesVencidos.length
    + alerts.productosStockCero.length + alerts.lotesFaltanteSinResolver.length
    + alerts.solicitudesAtrasadas.length + alerts.productosStockMuerto.length;
  const hash = buildHash(alerts);
  const today = new Date().toISOString().slice(0,10);

  console.log(`Alertas: ${alerts.productosBajoReorden.length} bajo reorden, ${alerts.lotesVencidos.length} vencidos, ${alerts.lotesPorVencer.length} por vencer, ${alerts.productosStockCero.length} en cero, ${alerts.lotesFaltanteSinResolver.length} FALTANTE sin resolver, ${alerts.solicitudesAtrasadas.length} solicitudes atrasadas, ${alerts.productosStockMuerto.length} stock muerto.`);

  const yaAvisadoHoy = node.lastNotifiedDate === today;
  const cambio = node.lastNotifiedHash !== hash;
  if(total===0 || (!cambio && yaAvisadoHoy)){
    console.log("Nada nuevo que avisar.");
    return;
  }

  const {subject, html, text} = buildEmail(alerts, {actualizadoEn: state.actualizadoEn, lots: state.lots || []});

  try{
    await transporter.sendMail({
      from: `"Almacén TIENS PE902" <${GMAIL_USER}>`,
      to: ALERT_EMAIL,
      subject,
      text,
      html,
    });
    console.log("Correo enviado a", ALERT_EMAIL);
  }catch(err){
    console.error("Error enviando correo:", err.message);
    process.exit(1);
  }

  await patchSyncNode(idToken, {lastNotifiedHash: hash, lastNotifiedDate: today});
}

main().catch(err=>{
  console.error("Error:", err);
  process.exit(1);
});
