/**
 * Netlify Function: GET /api/market
 * Devuelve WTI, Tesoro EE.UU. y precios ARCH vigentes
 * La app llama a este endpoint en lugar del Worker de Cloudflare
 */

import { getStore } from "@netlify/blobs";

const FALLBACK = [
  { d:"2026-03-12", h:"2026-04-11", e:2.890, di:2.828, s:3.620 },
  { d:"2026-04-12", h:"2026-05-11", e:3.024, di:2.962, s:4.570 },
  { d:"2026-05-12", h:"2026-06-11", e:3.164, di:3.103, s:4.810 },
];

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Content-Type": "application/json",
};

export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const [wtiR, rtR, preciosR] = await Promise.allSettled([
    fetchWTI(),
    fetchTreasury(),
    getPreciosVigentes(),
  ]);

  const wti     = wtiR.status     === "fulfilled" ? wtiR.value     : null;
  const rt      = rtR.status      === "fulfilled" ? rtR.value      : null;
  const precios = preciosR.status === "fulfilled" ? preciosR.value : getPrecioFallback();

  return new Response(JSON.stringify({
    wti,
    rt,
    precios,
    ts: Date.now(),
    source: {
      wti:     wti     ? "yahoo_finance" : "unavailable",
      rt:      rt      ? "us_treasury"   : "unavailable",
      precios: preciosR.status === "fulfilled" ? "netlify_blobs" : "fallback",
    },
  }), { status: 200, headers: CORS });
}

export const config = { path: "/api/market" };

async function getPreciosVigentes() {
  const store = getStore("precios-combustibles");
  const stored = await store.get("periodos", { type: "json" });
  const periodos = (stored && stored.length > 0) ? stored : FALLBACK;
  return getPrecioParaHoy(periodos);
}

function getPrecioFallback() {
  return getPrecioParaHoy(FALLBACK);
}

function getPrecioParaHoy(periodos) {
  const hoy = new Date().toISOString().slice(0, 10);
  for (let i = periodos.length - 1; i >= 0; i--) {
    if (hoy >= periodos[i].d && hoy <= periodos[i].h) return periodos[i];
  }
  return periodos[periodos.length - 1];
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
