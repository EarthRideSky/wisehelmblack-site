// api/scan.js — Vercel Serverless Function
// Fetches Yahoo Finance + BLS data, computes z-scores, returns JSON

const BASELINE_WINDOW = 60
const Z_THRESHOLD = 2.0
const ALERT_THRESHOLD = 4
const SHERLOCK_VOL_WINDOW = 30
const SHERLOCK_THRESHOLD = 2.0
const SHERLOCK_ALARM = 3

// ─── Yahoo Finance Fetcher ───
async function fetchYF(ticker) {
  try {
    const end = Math.floor(Date.now() / 1000)
    const start = end - 400 * 86400
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?period1=${start}&period2=${end}&interval=1d&includePrePost=false`
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrashSentinel/1.1)' } })
    if (!res.ok) return null
    const data = await res.json()
    const result = data?.chart?.result?.[0]
    if (!result) return null
    const quote = result.indicators?.quote?.[0]
    return {
      closes: (quote?.close || []).filter(c => c !== null).map(Number),
      volumes: (quote?.volume || []).filter(v => v !== null).map(Number),
    }
  } catch { return null }
}

// ─── BLS JOLTS Fetcher ───
async function fetchJOLTS() {
  try {
    const series = { openings: 'JTS000000000000000JOL', hires: 'JTS000000000000000HIR' }
    const results = {}
    const year = new Date().getFullYear()
    for (const [key, sid] of Object.entries(series)) {
      const res = await fetch('https://api.bls.gov/publicAPI/v1/timeseries/data/', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesid: [sid], startyear: String(year - 2), endyear: String(year) }),
      })
      if (!res.ok) continue
      const data = await res.json()
      if (data?.status !== 'REQUEST_SUCCEEDED') continue
      const points = data?.Results?.series?.[0]?.data
      if (!points?.length) continue
      const values = []
      for (const p of [...points].reverse()) {
        const val = parseFloat(String(p.value).replace(/,/g, ''))
        if (!isNaN(val)) values.push(val)
      }
      if (values.length >= 6) {
        results[key] = { values, latest: values[values.length - 1], period: `${points[0].year}-${points[0].periodName}` }
      }
    }
    return Object.keys(results).length > 0 ? results : null
  } catch { return null }
}

// ─── Z-Score ───
function calcZ(values, direction, window = BASELINE_WINDOW) {
  if (!values || values.length < window + 1) return null
  const current = values[values.length - 1]
  const baseline = values.slice(-(window + 1), -1)
  const n = baseline.length
  if (n < 10) return null
  const mu = baseline.reduce((a, b) => a + b, 0) / n
  const variance = baseline.reduce((a, b) => a + (b - mu) ** 2, 0) / n
  const sigma = Math.sqrt(variance)
  if (sigma === 0) return null
  const rawZ = (current - mu) / sigma
  const z = direction === 'up' ? rawZ : -rawZ
  return {
    val: Math.round(current * 10000) / 10000,
    mu: Math.round(mu * 10000) / 10000,
    sig: Math.round(sigma * 10000) / 10000,
    z: Math.round(z * 10000) / 10000,
    breach: z > Z_THRESHOLD,
  }
}

// ─── Indicators ───
const INDICATORS = [
  { key: 'hyg', name: 'HYG High Yield ETF', cat: 'Liquidity Stress', ticker: 'HYG', dir: 'down', desc: 'High Yield Bond ETF — dropping = credit stress' },
  { key: 'lqd', name: 'LQD Inv Grade ETF', cat: 'Liquidity Stress', ticker: 'LQD', dir: 'down', desc: 'Investment Grade Bond ETF — dropping = credit tightening' },
  { key: 'tlt', name: 'TLT Long Bond ETF', cat: 'Bond Internals', ticker: 'TLT', dir: 'up', desc: 'Long bond surge = flight to safety' },
  { key: 'shy', name: 'SHY Short Tsy ETF', cat: 'Bond Internals', ticker: 'SHY', dir: 'up', desc: 'Short treasury demand = institutional fear' },
  { key: 'ief', name: 'IEF 7-10Y Tsy', cat: 'Bond Internals', ticker: 'IEF', dir: 'up', desc: 'Mid-duration safety bid' },
  { key: 'wti', name: 'WTI Crude Oil', cat: 'Energy', ticker: 'CL=F', dir: 'up', desc: 'Oil — above $100 strangles economies' },
  { key: 'brent', name: 'Brent Crude Oil', cat: 'Energy', ticker: 'BZ=F', dir: 'up', desc: 'Global benchmark — Hormuz sensitive' },
  { key: 'natgas', name: 'Natural Gas', cat: 'Energy', ticker: 'NG=F', dir: 'up', desc: 'Heating/electricity cost pressure' },
  { key: 'xle', name: 'XLE Energy ETF', cat: 'Energy', ticker: 'XLE', dir: 'up', desc: 'Energy equities surging = stagflation' },
  { key: 'copper', name: 'Copper Futures', cat: 'Real Economy', ticker: 'HG=F', dir: 'down', desc: 'Dr. Copper — falling = industrial slowdown' },
  { key: 'iyt', name: 'IYT Transport ETF', cat: 'Real Economy', ticker: 'IYT', dir: 'down', desc: 'Transport sector leads economy' },
  { key: 'xli', name: 'XLI Industrial ETF', cat: 'Real Economy', ticker: 'XLI', dir: 'down', desc: 'Industrial sector weakness' },
  { key: 'vix', name: 'VIX Fear Index', cat: 'Equity Internals', ticker: '^VIX', dir: 'up', desc: 'CBOE Volatility — spike = panic' },
  { key: 'sp500', name: 'S&P 500', cat: 'Equity Internals', ticker: '^GSPC', dir: 'down', desc: 'Broad market — drops confirm signals' },
  { key: 'rut', name: 'Russell 2000', cat: 'Equity Internals', ticker: '^RUT', dir: 'down', desc: 'Small caps crack first' },
  { key: 'rsp', name: 'RSP Equal Weight', cat: 'Equity Internals', ticker: 'RSP', dir: 'down', desc: 'Equal weight — breadth indicator' },
  { key: 'dxy', name: 'US Dollar Index', cat: 'Currency Stress', ticker: 'DX-Y.NYB', dir: 'up', desc: 'Dollar surge = EM crisis' },
  { key: 'eurusd', name: 'EUR/USD', cat: 'Currency Stress', ticker: 'EURUSD=X', dir: 'down', desc: 'Euro weakness = European stress' },
  { key: 'usdjpy', name: 'USD/JPY', cat: 'Currency Stress', ticker: 'JPY=X', dir: 'up', desc: 'Yen weakness — carry trade risk' },
  { key: 'cem', name: 'CEW EM Currency', cat: 'Currency Stress', ticker: 'CEW', dir: 'down', desc: 'EM currencies dropping = capital flight' },
  { key: 'gold', name: 'Gold Futures', cat: 'Shadow Signals', ticker: 'GC=F', dir: 'up', desc: 'Surging = systemic fear' },
  { key: 'silver', name: 'Silver Futures', cat: 'Shadow Signals', ticker: 'SI=F', dir: 'up', desc: 'Volatile cousin of gold' },
  { key: 'btc', name: 'Bitcoin', cat: 'Shadow Signals', ticker: 'BTC-USD', dir: 'down', desc: 'Crashing with equities = risk-off' },
]

const ANCHORS = [
  { name: 'SPY Volume', ticker: 'SPY', desc: 'S&P500 ETF — market backbone' },
  { name: 'TLT Volume', ticker: 'TLT', desc: 'Long bonds — safety demand' },
  { name: 'GLD Volume', ticker: 'GLD', desc: 'Gold ETF — fear barometer' },
  { name: 'VIX Volume', ticker: 'VIXY', desc: 'VIX short-term — vol positioning' },
  { name: 'HYG Volume', ticker: 'HYG', desc: 'High yield — credit appetite' },
  { name: 'USO Volume', ticker: 'USO', desc: 'Oil fund — energy supply/demand' },
  { name: 'BTC Volume', ticker: 'BTC-USD', desc: 'Bitcoin — risk sentiment' },
]

// ─── Main Scan ───
async function runScan() {
  const allTickers = [...new Set([...INDICATORS.map(i => i.ticker), ...ANCHORS.map(a => a.ticker)])]
  const fetches = allTickers.map(t => fetchYF(t).then(d => ({ ticker: t, data: d })))
  const raw = await Promise.all(fetches)
  const dataMap = {}
  for (const r of raw) { if (r.data) dataMap[r.ticker] = r.data }

  // XAU/XAG ratio
  const goldC = dataMap['GC=F']?.closes
  const silverC = dataMap['SI=F']?.closes
  let xauxag = []
  if (goldC && silverC) {
    const m = Math.min(goldC.length, silverC.length)
    for (let i = 0; i < m; i++) {
      const g = goldC[goldC.length - m + i], s = silverC[silverC.length - m + i]
      if (s > 0) xauxag.push(g / s)
    }
  }

  // RSP/SPY breadth
  const rspC = dataMap['RSP']?.closes, spyC = dataMap['SPY']?.closes
  let breadth = []
  if (rspC && spyC) {
    const m = Math.min(rspC.length, spyC.length)
    for (let i = 0; i < m; i++) {
      const r = rspC[rspC.length - m + i], s = spyC[spyC.length - m + i]
      if (s > 0) breadth.push(r / s)
    }
  }

  // Indicators
  const indicators = INDICATORS.map(ind => {
    const closes = dataMap[ind.ticker]?.closes
    const z = closes ? calcZ(closes, ind.dir) : null
    return { key: ind.key, name: ind.name, cat: ind.cat, desc: ind.desc, ticker: ind.ticker, val: z?.val ?? null, mu: z?.mu ?? null, sig: z?.sig ?? null, z: z?.z ?? null, breach: z?.breach ?? false }
  })

  // XAU/XAG
  const xz = xauxag.length > 0 ? calcZ(xauxag, 'up') : null
  indicators.push({ key: 'xauxag', name: 'XAU/XAG Ratio', cat: 'Currency Stress', desc: 'Gold/Silver ratio — spiking = extreme fear', ticker: 'COMPUTED', val: xz?.val ?? null, mu: xz?.mu ?? null, sig: xz?.sig ?? null, z: xz?.z ?? null, breach: xz?.breach ?? false })
  indicators.push({ key: 'gs_ratio', name: 'Gold/Silver Ratio', cat: 'Shadow Signals', desc: 'Ratio spikes in panic — gold outpaces silver', ticker: 'COMPUTED', val: xz?.val ?? null, mu: xz?.mu ?? null, sig: xz?.sig ?? null, z: xz?.z ?? null, breach: xz?.breach ?? false })

  // JOLTS
  const jolts = await fetchJOLTS()
  if (jolts) {
    if (jolts.openings) {
      const z = calcZ(jolts.openings.values, 'down', 12)
      indicators.push({ key: 'jolts_open', name: `JOLTS Openings (${jolts.openings.period})`, cat: 'Real Economy', desc: 'JOLTS openings — declining = labor cooling (2mo lag)', ticker: 'BLS:JOLTS', val: z?.val ?? null, mu: z?.mu ?? null, sig: z?.sig ?? null, z: z?.z ?? null, breach: z?.breach ?? false })
    }
    if (jolts.hires) {
      const z = calcZ(jolts.hires.values, 'down', 12)
      indicators.push({ key: 'jolts_hires', name: `JOLTS Hires (${jolts.hires.period})`, cat: 'Real Economy', desc: 'JOLTS hires — declining = hiring freeze (2mo lag)', ticker: 'BLS:JOLTS', val: z?.val ?? null, mu: z?.mu ?? null, sig: z?.sig ?? null, z: z?.z ?? null, breach: z?.breach ?? false })
    }
  }

  // Sherlock
  const anchors = ANCHORS.map(a => {
    const vols = dataMap[a.ticker]?.volumes
    if (!vols || vols.length < SHERLOCK_VOL_WINDOW + 5) return { name: a.name, ticker: a.ticker, desc: a.desc, vol: null, mu: null, sig: null, z: null, deviated: false }
    const current = vols[vols.length - 1]
    const baseline = vols.slice(-(SHERLOCK_VOL_WINDOW + 1), -1)
    const n = baseline.length
    const mu = baseline.reduce((a, b) => a + b, 0) / n
    const variance = baseline.reduce((a, b) => a + (b - mu) ** 2, 0) / n
    const sigma = Math.sqrt(variance)
    const z = sigma > 0 ? Math.abs((current - mu) / sigma) : 0
    return { name: a.name, ticker: a.ticker, desc: a.desc, vol: Math.round(current), mu: Math.round(mu), sig: Math.round(sigma), z: Math.round(z * 100) / 100, deviated: z > SHERLOCK_THRESHOLD }
  })
  const sherlockDev = anchors.filter(a => a.deviated).length
  const sherlock = { anchors, deviated: sherlockDev, total: anchors.length, alert: sherlockDev >= SHERLOCK_ALARM }

  // Categories
  const catNames = [...new Set(indicators.map(i => i.cat))]
  const categories = {}
  for (const cat of catNames) {
    const inds = indicators.filter(i => i.cat === cat && i.z !== null)
    if (inds.length === 0) { categories[cat] = { avgz: 0, maxz: 0, breach: 0, total: indicators.filter(i => i.cat === cat).length, sev: 'nodata' }; continue }
    const absz = inds.map(i => Math.abs(i.z))
    const avgz = absz.reduce((a, b) => a + b, 0) / absz.length
    const maxz = Math.max(...absz)
    const breach = inds.filter(i => i.breach).length
    const sev = avgz < 1.0 ? 'normal' : avgz < 1.5 ? 'elevated' : avgz < 2.0 ? 'warning' : 'critical'
    categories[cat] = { avgz: Math.round(avgz * 100) / 100, maxz: Math.round(maxz * 100) / 100, breach, total: inds.length, sev }
  }

  const validCats = Object.values(categories).filter(c => c.sev !== 'nodata')
  const composite = validCats.length > 0 ? Math.round((validCats.reduce((a, c) => a + c.avgz, 0) / validCats.length) * 100) / 100 : 0
  const catsBreach = validCats.filter(c => c.breach > 0).length
  const compSev = composite < 1.0 ? 'normal' : composite < 1.5 ? 'elevated' : composite < 2.0 ? 'warning' : 'critical'
  const alert = catsBreach >= ALERT_THRESHOLD

  return { version: '1.1', ts: new Date().toISOString(), composite, severity: compSev, alert, cats_breach: catsBreach, categories, indicators, sherlock }
}

// ─── Cache ───
let cache = null
const CACHE_TTL = 15 * 60 * 1000

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate')

  if (cache && (Date.now() - cache.ts) < CACHE_TTL) {
    return res.json({ ...cache.data, cached: true })
  }

  try {
    const data = await runScan()
    cache = { data, ts: Date.now() }
    return res.json(data)
  } catch (err) {
    return res.status(500).json({ error: 'Scan failed', message: err.message })
  }
}
