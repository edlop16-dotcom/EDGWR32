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

const DIAS_RETRASO_SOLICITUD = 4; // días de margen tras la fecha estimada de llegada
const DIAS_STOCK_MUERTO = 30;     // días sin movimiento para considerar stock muerto

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
function totalLot(l){ return (l.almacen||0)+(l.repisa||0)+(l.exhibicion||0); }
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

function buildEmail({productosBajoReorden, lotesPorVencer, lotesVencidos, productosStockCero, lotesFaltanteSinResolver, solicitudesAtrasadas, productosStockMuerto}){
  const criticos = productosStockCero.length + solicitudesAtrasadas.length;
  const subject = `Almacén TIENS PE902 — ${criticos>0 ? `⚠ ${criticos} crítico(s) · `: ""}${productosBajoReorden.length} bajo reorden · ${lotesVencidos.length} vencidos`;

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
      ${section("🔴 Stock en cero (rotura total)", productosStockCero, c =>
        `<li>${escapeHtml(c.cod)} — ${escapeHtml(c.nombre||"")}</li>`)}
      ${section("🔴 Solicitudes de ingreso atrasadas (+"+DIAS_RETRASO_SOLICITUD+" días)", solicitudesAtrasadas, s =>
        `<li>${escapeHtml(s.numero||s.id)} — ${escapeHtml(s.proveedor||"s/proveedor")} — esperada ${escapeHtml(s.fecha||"")} — estado: ${escapeHtml(s.estado||"")}</li>`)}
      ${section("Productos bajo punto de reorden", productosBajoReorden, c =>
        `<li>${escapeHtml(c.cod)} — ${escapeHtml(c.nombre||"")} (reorden: ${c.puntoReorden})</li>`)}
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
    "",
    `Stock en cero (${productosStockCero.length}): ${productosStockCero.map(c=>c.cod).join(", ")||"-"}`,
    `Solicitudes atrasadas (${solicitudesAtrasadas.length}): ${solicitudesAtrasadas.map(s=>s.numero||s.id).join(", ")||"-"}`,
    `Bajo reorden (${productosBajoReorden.length}): ${productosBajoReorden.map(c=>c.cod).join(", ")||"-"}`,
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
  if(!node || !node.state){
    console.log("No hay inventario guardado.");
    return;
  }
  const state = JSON.parse(node.state);
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

  const {subject, html, text} = buildEmail(alerts);

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
