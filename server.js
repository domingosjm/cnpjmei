const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(compression());

const SCRAPE_SCRIPT = path.resolve(__dirname, 'scrape.js');
const SCRAPE_PLAYWRIGHT = path.resolve(__dirname, 'scrape_playwright.js');
const OUTPUT_ALL = path.resolve(__dirname, 'debitos_all.json');

// Simple in-memory cache with TTL and max size
const CACHE_TTL = 1000 * 60 * 10; // 10 minutes
const CACHE_MAX = 200;
const cache = new Map(); // key -> { ts, value }

function makeKey(cnpj, year, month) {
  return `${cnpj || ''}|${year || ''}|${month || ''}`;
}

function getFromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    cache.delete(key);
    return null;
  }
  // move to end to mark as recently used
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function setToCache(key, value) {
  if (cache.size >= CACHE_MAX) {
    // remove oldest
    const first = cache.keys().next().value;
    cache.delete(first);
  }
  cache.set(key, { ts: Date.now(), value });
}

function sanitizeCNPJ(cnpj) {
  if (!cnpj) return null;
  return String(cnpj).replace(/[^0-9]/g, '');
}

app.post('/scrape', async (req, res) => {
  const { cnpj, year, month, noHeadless } = req.body || {};
  const cnpjRaw = sanitizeCNPJ(cnpj || '');
  if (!cnpjRaw || cnpjRaw.length < 11) return res.status(400).json({ error: 'CNPJ inválido' });
  const engine = (req.body && req.body.engine) || 'puppeteer';
  const script = engine === 'playwright' ? SCRAPE_PLAYWRIGHT : SCRAPE_SCRIPT;
  const args = [script, `--cnpj=${cnpjRaw}`];
  if (year) args.push(`--year=${String(year)}`);
  if (month) args.push(`--month=${String(month)}`);
  if (noHeadless) args.push('--no-headless');

  const key = makeKey(cnpjRaw, year, month);
  const cached = getFromCache(key);
  if (cached) return res.json({ cached: true, result: cached });

  // spawn node scrape.js ...
  const node = process.execPath;
  const child = spawn(node, args, { cwd: process.cwd() });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const timeout = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch (e) {}
  }, 1000 * 60 * 3); // 3 minutes

  child.on('exit', async (code) => {
    clearTimeout(timeout);
    // try to read output JSON asynchronously and populate cache
    try {
      if (fs.existsSync(OUTPUT_ALL)) {
        const raw = await fs.promises.readFile(OUTPUT_ALL, 'utf8');
        const json = JSON.parse(raw);
        try { setToCache(key, json); } catch (e) {}
        return res.json({ success: true, code, stdout, stderr, result: json });
      }
      return res.json({ success: code === 0, code, stdout, stderr, message: 'Sem arquivo de saída gerado (verifique logs)' });
    } catch (e) {
      return res.json({ success: false, code, stdout, stderr, error: 'Falha ao ler resultado JSON', detail: String(e) });
    }
  });

  child.on('error', (err) => {
    clearTimeout(timeout);
    return res.status(500).json({ error: 'Falha ao iniciar o processo', detail: String(err) });
  });
});

// GET endpoint for quick requests via URL query: /scrape?cnpj=...&year=...&month=...&noHeadless=1
app.get('/scrape', async (req, res) => {
  const { cnpj, year, month, noHeadless } = req.query || {};
  // reuse POST handler logic by delegating to same spawn flow
  const cnpjRaw = sanitizeCNPJ(cnpj || '');
  if (!cnpjRaw || cnpjRaw.length < 11) return res.status(400).json({ error: 'CNPJ inválido' });
  const engine = req.query.engine || 'puppeteer';
  const script = engine === 'playwright' ? SCRAPE_PLAYWRIGHT : SCRAPE_SCRIPT;
  const args = [script, `--cnpj=${cnpjRaw}`];
  if (year) args.push(`--year=${String(year)}`);
  if (month) args.push(`--month=${String(month)}`);
  if (noHeadless && String(noHeadless) !== '0') args.push('--no-headless');

  const key = makeKey(cnpjRaw, year, month);
  const cached = getFromCache(key);
  if (cached) return res.json({ cached: true, result: cached });

  const node = process.execPath;
  const child = spawn(node, args, { cwd: process.cwd() });

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d.toString(); });
  child.stderr.on('data', (d) => { stderr += d.toString(); });

  const timeout = setTimeout(() => {
    try { child.kill('SIGTERM'); } catch (e) {}
  }, 1000 * 60 * 3); // 3 minutes

  child.on('exit', async (code) => {
    clearTimeout(timeout);
    try {
      if (fs.existsSync(OUTPUT_ALL)) {
        const raw = await fs.promises.readFile(OUTPUT_ALL, 'utf8');
        const json = JSON.parse(raw);
        try { setToCache(key, json); } catch (e) {}
        return res.json({ success: true, code, stdout, stderr, result: json });
      }
      return res.json({ success: code === 0, code, stdout, stderr, message: 'Sem arquivo de saída gerado (verifique logs)' });
    } catch (e) {
      return res.json({ success: false, code, stdout, stderr, error: 'Falha ao ler resultado JSON', detail: String(e) });
    }
  });

  child.on('error', (err) => {
    clearTimeout(timeout);
    return res.status(500).json({ error: 'Falha ao iniciar o processo', detail: String(err) });
  });
});

app.get('/status', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API rodando na porta ${PORT}`));
