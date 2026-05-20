/**
 * Netlify Scheduled Function
 * Se ejecuta automáticamente el día 12 de cada mes a la 01:00 UTC
 * Obtiene los nuevos precios y los guarda en Netlify Blobs
 *
 * Schedule: "0 1 12 * *"  ← día 12, 01:00 AM UTC
 */

import { getStore } from "@netlify/blobs";

export const config = {
  schedule: "0 1 12 * *",
};

// Precios fallback si el scraping falla
const FALLBACK = [
  { d:"2026-03-12", h:"2026-04-11", e:2.890, di:2.828, s:3.620 },
  { d:"2026-04-12", h:"2026-05-11", e:3.024, di:2.962, s:4.570 },
  { d:"2026-05-12", h:"2026-06-11", e:3.164, di:3.103, s:4.810 },
];

export default async function handler() {
  console.log("⛽ Cron día 12: actualizando precios ARCH...");

  const hoy = new Date();
  if (hoy.getUTCDate() !== 12) {
    console.log("No es día 12, saltando.");
    return new Response("Not day 12", { status: 200 });
  }

  // 1. Intentar obtener precios nuevos
  const nuevos = await obtenerPrecios();
  if (!nuevos) {
    console.log("No se pudieron obtener precios nuevos.");
    return new Response("No prices found", { status: 200 });
  }

  // 2. Calcular periodo: del 12 de este mes al 11 del siguiente
  const y = hoy.getUTCFullYear();
  const m = hoy.getUTCMonth() + 1;
  const desde = `${y}-${String(m).padStart(2,"0")}-12`;
  const sigMes = new Date(y, m, 11); // mes siguiente, día 11
  const hasta = `${sigMes.getFullYear()}-${String(sigMes.getMonth()+1).padStart(2,"0")}-11`;
  
  const nuevo = { d: desde, h: hasta, ...nuevos };
  console.log("Nuevo periodo:", nuevo);

  // 3. Guardar en Netlify Blobs
  try {
    const store = getStore("precios-combustibles");
    let periodos = FALLBACK;
    try {
      const stored = await store.get("periodos", { type: "json" });
      if (stored && stored.length > 0) periodos = stored;
    } catch (_) {}

    // Agregar si no existe ya
    if (!periodos.some(p => p.d === desde)) {
      periodos.push(nuevo);
      if (periodos.length > 24) periodos = periodos.slice(-24);
      await store.setJSON("periodos", periodos);
      console.log("✅ Precios guardados:", nuevo);
    } else {
      console.log("Periodo ya existe, no se duplica.");
    }
  } catch (e) {
    console.error("Error guardando en Blobs:", e);
  }

  return new Response(JSON.stringify(nuevo), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ─────────────────────────────────────────────
// Obtener precios con múltiples estrategias
// ─────────────────────────────────────────────
async function obtenerPrecios() {
  // Estrategia 1: Camddepe
  try {
    const r = await fetch("https://www.camddepe.ec/precios", {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (r.ok) {
      const html = await r.text();
      const p = extraerDeHTML(html);
      if (p) { console.log("Precios de Camddepe:", p); return p; }
    }
  } catch (_) {}

  // Estrategia 2: ARCH
  try {
    const r = await fetch("https://controlhidrocarburos.gob.ec/precios-de-combustibles/", {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    if (r.ok) {
      const html = await r.text();
      const p = extraerDeHTML(html);
      if (p) { console.log("Precios de ARCH:", p); return p; }
    }
  } catch (_) {}

  // Estrategia 3: Calcular con fórmula D.E. 308
  try {
    const [wti, rt] = await Promise.all([fetchWTI(), fetchTreasury()]);
    if (wti && rt) {
      const p = calcularFormula308(wti, rt);
      console.log("Precios calculados con D.E. 308:", p);
      return p;
    }
  } catch (_) {}

  return null;
}

function extraerDeHTML(html) {
  const extra = extraerPrecio(html, /(?:extra|ecopaís|ecopais)[^0-9]{0,30}(\d[,\.]\d{3})/i);
  if (!extra || extra < 1 || extra > 10) return null;
  const diesel = extraerPrecio(html, /di[eé]sel[^0-9]{0,30}(\d[,\.]\d{3})/i);
  const sup    = extraerPrecio(html, /s[uú]per[^0-9]{0,30}(\d[,\.]\d{2,3})/i);
  if (!diesel || !sup) return null;
  return { e: extra, di: diesel, s: sup };
}

function extraerPrecio(html, regex) {
  const m = html.match(regex);
  return m ? parseFloat(m[1].replace(",", ".")) : null;
}

function calcularFormula308(wti, rt) {
  const IVA=0.15, MGC=0.1603125, PISO=1.983166;
  const ultimo = FALLBACK[FALLBACK.length - 1];
  const ptBase = ultimo.e / (1 + IVA) - MGC;
  const pm = wti / 42 + 0.042;
  const seg = (pm + 0.058) * 0.0005;
  const ppi = pm + 0.058 + seg + 0.038;
  const ppimg = ppi * (1 + rt);
  const ar = (ppimg / ptBase - 1) * 100;
  let aa = ar >= 5 ? 5 : (ar <= -10 ? -10 : ar);
  let pn = ptBase * (1 + aa / 100);
  if (pn < PISO) pn = PISO;
  const e  = parseFloat(((pn + MGC) * (1 + IVA)).toFixed(3));
  const di = parseFloat((ultimo.di * (1 + aa / 100)).toFixed(3));
  const s  = parseFloat((e * (ultimo.s / ultimo.e)).toFixed(3));
  return { e, di, s };
}

async function fetchWTI() {
  const r = await fetch(
    "https://query1.finance.yahoo.com/v8/finance/chart/CL=F?interval=1d&range=5d",
    { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) }
  );
  if (!r.ok) throw new Error("Yahoo " + r.status);
  const d = await r.json();
  const closes = d.chart.result[0].indicators.quote[0].close.filter(x => x != null);
  return +closes[closes.length - 1];
}

async function fetchTreasury() {
  const now = new Date();
  for (let i = 0; i < 2; i++) {
    const m = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${m.getFullYear()}${String(m.getMonth()+1).padStart(2,"0")}`;
    try {
      const r = await fetch(
        `https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value=${ym}`,
        { signal: AbortSignal.timeout(7000) }
      );
      if (!r.ok) continue;
      const xml = await r.text();
      const matches = [...xml.matchAll(/<d:BC_10YEAR[^>]*>([^<]+)<\/d:BC_10YEAR>/g)];
      if (!matches.length) continue;
      return parseFloat(matches[matches.length - 1][1]) / 100;
    } catch (_) { continue; }
  }
  throw new Error("Treasury unavailable");
}
