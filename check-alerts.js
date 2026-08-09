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

function daysTo(iso){
  if(!iso) return null;
  const d = new Date(iso+"T00:00:00");
  const today = new Date(); today.setHours(0,0,0,0);
  return Math.round((d - today) / 86400000);
}
function esFaltante(l){ return (l.lote||"").trim().toUpperCase() === "FALTANTE"; }
function totalLot(l){ return (l.almacen||0)+(l.repisa||0)+(l.exhibicion||0); }
function totalProducto(cod, lots){ return lots.filter(l=>l.cod===cod).reduce((s,l)=>s+totalLot(l),0); }

function computeAlerts(state){
  const catalog = state.catalog || [];
  const lots = state.lots || [];
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
  return {productosBajoReorden, lotesPorVencer, lotesVencidos};
}

function buildHash({productosBajoReorden, lotesPorVencer, lotesVencidos}){
  const parts = [
    ...productosBajoReorden.map(c=>"R:"+c.cod),
    ...lotesVencidos.map(l=>"V:"+l.id),
    ...lotesPorVencer.map(l=>"P:"+l.id),
  ].sort();
  return parts.join("|");
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, ch => ({
    "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
  }[ch]));
}

function buildEmail({productosBajoReorden, lotesPorVencer, lotesVencidos}){
  const subject = `Almacén TIENS PE902 — ${productosBajoReorden.length} bajo reorden · ${lotesVencidos.length} vencidos · ${lotesPorVencer.length} por vencer`;

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
      ${section("Productos bajo punto de reorden", productosBajoReorden, c =>
        `<li>${escapeHtml(c.cod)} — ${escapeHtml(c.nombre||"")} (reorden: ${c.puntoReorden})</li>`)}
      ${section("Lotes vencidos", lotesVencidos, l =>
        `<li>${escapeHtml(l.cod)} — lote ${escapeHtml(l.lote||"")} — venció ${escapeHtml(l.vencimiento||"")}</li>`)}
      ${section("Lotes por vencer (≤60 días)", lotesPorVencer, l =>
        `<li>${escapeHtml(l.cod)} — lote ${escapeHtml(l.lote||"")} — vence ${escapeHtml(l.vencimiento||"")}</li>`)}
      <p style="font-family:sans-serif;font-size:12px;color:#888;margin-top:20px">
        Generado automáticamente por check-alerts.js
      </p>
    </div>`;

  const text = [
    "Almacén TIENS PE902 / JULIACA — Alertas de inventario",
    "",
    `Bajo reorden (${productosBajoReorden.length}): ${productosBajoReorden.map(c=>c.cod).join(", ")||"-"}`,
    `Vencidos (${lotesVencidos.length}): ${lotesVencidos.map(l=>l.cod+"/"+l.lote).join(", ")||"-"}`,
    `Por vencer (${lotesPorVencer.length}): ${lotesPorVencer.map(l=>l.cod+"/"+l.lote).join(", ")||"-"}`,
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
  const total = alerts.productosBajoReorden.length + alerts.lotesPorVencer.length + alerts.lotesVencidos.length;
  const hash = buildHash(alerts);
  const today = new Date().toISOString().slice(0,10);

  console.log(`Alertas: ${alerts.productosBajoReorden.length} bajo reorden, ${alerts.lotesVencidos.length} vencidos, ${alerts.lotesPorVencer.length} por vencer.`);

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
