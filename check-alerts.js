// check-alerts.js
const webpush = require("web-push");

const {
  FIREBASE_API_KEY,
  FIREBASE_DB_URL,
  SYNC_CODE,
  VAPID_PUBLIC_KEY,
  VAPID_PRIVATE_KEY,
} = process.env;

const VAPID_SUBJECT = 'mailto:edlop16@gmail.com';

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
required("VAPID_PUBLIC_KEY", VAPID_PUBLIC_KEY);
required("VAPID_PRIVATE_KEY", VAPID_PRIVATE_KEY);

const DB_URL = FIREBASE_DB_URL.replace(/\/$/, "");
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

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

function buildMessage({productosBajoReorden, lotesPorVencer, lotesVencidos}){
  return {
    title: "Almacén TIENS PE902 — Alertas",
    body: `${productosBajoReorden.length} bajo reorden · ${lotesVencidos.length} vencidos · ${lotesPorVencer.length} por vencer (≤60d)`,
    url: "./"
  };
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

  const subs = node.pushSubscriptions || {};
  const deviceIds = Object.keys(subs);
  if(!deviceIds.length){
    console.log("Sin dispositivos suscritos.");
    await patchSyncNode(idToken, {lastNotifiedHash: hash, lastNotifiedDate: today});
    return;
  }

  const payload = JSON.stringify(buildMessage(alerts));
  const patch = {lastNotifiedHash: hash, lastNotifiedDate: today};
  let enviados = 0, expirados = 0;

  for(const deviceId of deviceIds){
    try{
      await webpush.sendNotification(subs[deviceId], payload);
      enviados++;
    }catch(err){
      if(err.statusCode===404 || err.statusCode===410){
        patch["pushSubscriptions/"+deviceId] = null;
        expirados++;
      }else{
        console.error(`Error en ${deviceId}:`, err.message);
      }
    }
  }
  await patchSyncNode(idToken, patch);
  console.log(`Enviadas: ${enviados}. Vencidas limpiadas: ${expirados}.`);
}

main().catch(err=>{
  console.error("Error:", err);
  process.exit(1);
});
