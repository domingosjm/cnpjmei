const fs = require('fs');
const argv = require('minimist')(process.argv.slice(2));
const { chromium } = require('playwright');

const URL = 'https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao';

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function normalizeCNPJ(raw) {
  return String(raw || '').replace(/\D/g, '');
}

async function findCNPJInput(page) {
  const candidates = [
    '#cnpj',
    'input[name="cnpj"]',
    'input[name*="cnpj"]',
    'input[id*="cnpj"]',
    'input[placeholder*="CNPJ"]',
    'input[aria-label*="CNPJ"]',
    'input[type="text"]'
  ];
  for (const sel of candidates) {
    try {
      const el = await page.$(sel);
      if (el) return el;
    } catch (e) {}
  }
  // try labels
  try {
    const labels = await page.$$('label');
    for (const lh of labels) {
      try {
        const txt = (await lh.innerText()).trim();
        if (txt && txt.toLowerCase().includes('cnpj')) {
          const forAttr = await lh.getAttribute('for');
          if (forAttr) {
            const el = await page.$(`#${forAttr}`);
            if (el) return el;
          }
          const handle = await lh.evaluateHandle(n => {
            let el = n.nextElementSibling;
            while (el && el.tagName !== 'INPUT') el = el.nextElementSibling;
            return el || null;
          });
          if (handle && handle.asElement()) return handle.asElement();
        }
      } catch (e) {}
    }
  } catch (e) {}
  const inputs = await page.$$('input[type="text"], input:not([type])');
  return inputs && inputs.length ? inputs[0] : null;
}

async function findCompanyNameFromListInline(page) {
  try {
    const ul = await page.$('ul.list-inline');
    if (!ul) return null;
    const items = await ul.$$eval('li', lis => lis.map(li => (li.innerText || '').trim()).filter(Boolean));
    if (items && items.length) return items.join(' - ');
    const txt = await ul.innerText();
    return txt ? String(txt).trim() : null;
  } catch (e) { return null; }
}

async function findNameByLabel(page) {
  try {
    const elems = await page.$$('label, td, th, div, span, p, strong');
    for (const el of elems) {
      try {
        const txt = (await el.innerText()).trim() || '';
        if (!txt) continue;
        if (txt.toLowerCase().includes('nome')) {
          const forAttr = await el.getAttribute('for');
          if (forAttr) {
            const target = await page.$(`#${forAttr}`);
            if (target) {
              const v = ((await target.innerText()).trim() || (await target.getAttribute('value')) || '').trim();
              if (v) return v;
            }
          }
          const siblingVal = await el.evaluate(node => {
            try {
              let sib = node.nextElementSibling;
              while (sib) {
                const t = (sib.innerText || sib.value || '').trim();
                if (t) return t;
                sib = sib.nextElementSibling;
              }
              const p = node.parentElement;
              if (p) {
                const found = p.querySelector('strong, span, p, td, label');
                if (found) return (found.innerText || '').trim();
              }
            } catch (e) {}
            return null;
          }, el);
          if (siblingVal) return siblingVal;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return null;
}

async function getAvailableYears(page) {
  const YEAR_SELECTOR = 'select[id*="ano"]';
  if (await page.$(YEAR_SELECTOR)) {
    const opts = await page.$$eval(`${YEAR_SELECTOR} option`, options =>
      options.map(o => ({ value: o.value, text: o.innerText.trim(), disabled: o.disabled || o.classList.contains('disabled') }))
    );
    return opts.filter(o => o.text && !/não optante/i.test(o.text) && !o.disabled);
  }
  const els = await page.$$('a, button, span, div');
  const years = [];
  for (const el of els) {
    try {
      const txt = (await el.innerText()).trim();
      const isDisabled = await el.getAttribute('aria-disabled') === 'true' || (await el.getAttribute('disabled')) !== null || (await el.getAttribute('class') || '').includes('disabled');
      if (/^\d{4}$/.test(txt) && !/não optante/i.test(txt) && !isDisabled) years.push({ value: txt, text: txt, handle: el });
    } catch (e) {}
  }
  return years;
}

function normalizeHeader(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

async function extractDebits(page, year) {
  // Fast extraction: run inside page context to minimize round-trips
  return await page.evaluate((year) => {
    const currencyRegex = /R\$\s*[\d\.]+,\d{2}|[\d\.]+,\d{2}/g;
    const expectedHeaders = [
      'período de apuração', 'apurado', 'benefício inss', 'resumo do das a ser gerado',
      'principal', 'multa', 'juros', 'total', 'data de vencimento', 'data de acolhimento'
    ];
    function normalizeHeader(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
    const out = [];
    const tables = Array.from(document.querySelectorAll('table'));
    for (const table of tables) {
      try {
        const txt = table.innerText || '';
        if (!currencyRegex.test(txt)) continue;
        const ths = Array.from(table.querySelectorAll('th'));
        let headers = [];
        if (ths.length) headers = ths.map(h => normalizeHeader(h.innerText || ''));
        else {
          const first = table.querySelector('tr');
          if (first) headers = Array.from(first.querySelectorAll('td,th')).map(h => normalizeHeader(h.innerText || ''));
        }
        const hasExpected = headers.some(h => expectedHeaders.includes(h));
        const rows = Array.from(table.querySelectorAll('tr'));
        if (hasExpected && headers.length) {
          const mapKeys = headers.map(h => { const idx = expectedHeaders.indexOf(h); return idx >= 0 ? expectedHeaders[idx] : h; });
          for (let i = 1; i < rows.length; i++) {
            try {
              const cells = Array.from(rows[i].querySelectorAll('td,th'));
              const rowObj = {};
              for (let k = 0; k < mapKeys.length; k++) rowObj[mapKeys[k] || `col_${k}`] = (cells[k] && (cells[k].innerText || '').trim()) || null;
              out.push(rowObj);
            } catch (e) {}
          }
        } else {
          for (const r of rows) {
            try {
              const rowText = (r.innerText || '').trim();
              if (!rowText) continue;
              if (rowText.includes(String(year)) || currencyRegex.test(rowText)) {
                const parts = rowText.split(/\t+|\s{2,}/).map(s => s.trim()).filter(Boolean);
                const amountPart = parts.slice().reverse().find(p => /\d+[\.,]\d{2}/.test(p));
                const amount = amountPart ? amountPart.replace(/[R\$\s\.]/g, '').replace(',', '.') : null;
                out.push({ raw: rowText, parts, amount: amount ? Number(amount) : null });
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
    return out;
  }, year);
}

async function safeExtractDebits(page, year, tries = 2) {
  for (let i = 0; i < tries; i++) {
    try { return await extractDebits(page, year); } catch (err) {
      const msg = String(err && err.message || err || '');
      if (msg.includes('Execution context was destroyed') || msg.includes('Execution context')) { await sleep(1000); continue; }
      throw err;
    }
  }
  return [];
}

(async () => {
  const argvC = argv || require('minimist')(process.argv.slice(2));
  const CNPJ = argvC.cnpj || argvC._[0] || '';
  if (!CNPJ) { console.error('Informe o CNPJ: node scrape_playwright.js --cnpj=00000000000191'); process.exit(1); }
  let headless = true;
  if ('no-headless' in argvC || 'noheadless' in argvC) headless = false;

  const digits = normalizeCNPJ(CNPJ);
  const browser = await chromium.launch({ headless, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36', locale: 'pt-BR' });
  // Bloquear CSS para acelerar scraping
  await context.route('**/*', (route) => {
    const req = route.request();
    if (req.resourceType() === 'stylesheet' || req.url().match(/\.css($|\?)/)) {
      route.abort();
    } else {
      route.continue();
    }
  });
  await context.addInitScript(() => {
    try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (e) {}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt'] }); } catch (e) {}
    try { Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] }); } catch (e) {}
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1280, height: 900 });

  await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });

  // detect hcaptcha and non-blocking wait
  try {
    const content = await page.content();
    const hasHCaptcha = /hcaptcha/i.test(content) || (await page.$('iframe[src*="hcaptcha"]'));
    if (hasHCaptcha) {
      console.warn('\nhCaptcha detectado — aguardando brevemente e continuando automaticamente.');
      const maxWait = 20000; const start = Date.now();
      while (Date.now() - start < maxWait) {
        try {
          const iframeHandle = await page.$('iframe[src*="hcaptcha"]');
          const table = await page.$('table');
          const listInline = await page.$('ul.list-inline');
          if ((!iframeHandle) || table || listInline) break;
        } catch (e) {}
        await sleep(500);
      }
    }
  } catch (e) {}

  const cnpjEl = await findCNPJInput(page);
  if (!cnpjEl) { console.error('Campo de CNPJ não encontrado.'); await browser.close(); process.exit(1); }
  try { await cnpjEl.click({ clickCount: 3 }); } catch (e) {}
  try {
    await cnpjEl.fill(digits);
  } catch (e) {
    try {
      const id = await cnpjEl.getAttribute('id');
      const name = await cnpjEl.getAttribute('name');
      if (id) await page.evaluate((i, v) => { const el = document.getElementById(i); if (el) { el.focus(); el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } }, id, digits);
      else if (name) await page.evaluate((n, v) => { const el = document.getElementsByName(n)[0]; if (el) { el.focus(); el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); } }, name, digits);
      else await cnpjEl.evaluate((el, v) => { el.focus(); el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); }, digits);
    } catch (ee) { console.warn('Falha ao preencher CNPJ via fallback'); }
  }
  try { const val = await cnpjEl.inputValue(); console.log('Valor no campo CNPJ após preenchimento:', val); } catch (e) {}

  let companyName = await findCompanyNameFromListInline(page);
  if (companyName) console.log('Nome da empresa detectado em ul.list-inline:', companyName);

  // press Enter to submit
  try { await page.keyboard.press('Enter'); try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch (e) {} } catch (e) {}
  await sleep(1500);

  // click menu
  const MENU_TEXT = 'Emitir Guia de Pagamento (DAS)';
  try {
    const menu = await page.$(`text="${MENU_TEXT}"`);
    if (menu) { try { await menu.click(); await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch (e) {} }
  } catch (e) {}

  const years = await getAvailableYears(page);

  // Função para processar scraping de um ano em uma nova página
  async function scrapeYearInParallel(context, digits, companyName, yearObj) {
    const yearLabel = yearObj.text || yearObj.value;
    const page = await context.newPage();
    // Bloquear CSS em cada página paralela
    await page.route('**/*', (route) => {
      const req = route.request();
      if (req.resourceType() === 'stylesheet' || req.url().match(/\.css($|\?)/)) {
        route.abort();
      } else {
        route.continue();
      }
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 });
    const cnpjEl = await findCNPJInput(page);
    if (!cnpjEl) { await page.close(); return { year: yearLabel, items: [] }; }
    try { await cnpjEl.fill(digits); } catch (e) {}
    try { await page.keyboard.press('Enter'); await sleep(1500); } catch (e) {}
    // clicar menu
    const MENU_TEXT = 'Emitir Guia de Pagamento (DAS)';
    try {
      const menu = await page.$(`text="${MENU_TEXT}"`);
      if (menu) { try { await menu.click(); await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch (e) {} }
    } catch (e) {}
    // selecionar ano
    try {
      if (await page.$('select[id*="ano"]')) {
        await page.selectOption('select[id*="ano"]', yearObj.value);
        await sleep(300);
      } else {
        const toggle = await page.$('[class*="filter-option"], .dropdown-toggle, [class*="selectpicker"]');
        if (toggle) { try { await toggle.click(); await sleep(200); } catch (e) {} }
        const opt = await page.$(`text="${yearLabel}"`);
        if (opt) try { await opt.click(); } catch (e) {}
        await sleep(300);
      }
    } catch (e) {}
    // consultar
    try {
      const consultTexts = ['Consultar','Pesquisar','Filtrar','OK','Ok','Continuar','Buscar','Pesquisar Débitos','Emitir','Confirmar'];
      for (const t of consultTexts) {
        const btn = await page.$(`text=${t}`);
        if (btn) { try { await btn.click(); break; } catch (e) {} }
      }
      await page.waitForSelector('table', { timeout: 6000 }).catch(() => {});
    } catch (e) {}
    const found = await safeExtractDebits(page, yearLabel, 3);
    if (found && found.length) {
      try { fs.writeFileSync(`debitos_${yearLabel}.json`, JSON.stringify({ cnpj: digits, companyName: companyName || null, year: yearLabel, items: found }, null, 2), 'utf8'); } catch (e) {}
    }
    await page.close();
    return { year: yearLabel, items: found };
  }

  // Limitar concorrência para evitar bloqueio do site
  async function parallelMap(arr, limit, fn) {
    const ret = [];
    let idx = 0;
    async function next() {
      if (idx >= arr.length) return;
      const i = idx++;
      ret[i] = await fn(arr[i]);
      await next();
    }
    const workers = Array.from({ length: Math.min(limit, arr.length) }, next);
    await Promise.all(workers);
    return ret;
  }

  let all = [];
  if (years && years.length) {
    // Limite de 3 páginas paralelas (ajuste conforme necessário)
    all = await parallelMap(years, 3, y => scrapeYearInParallel(context, digits, companyName, y));
    try { fs.writeFileSync('debitos_all.json', JSON.stringify({ cnpj: digits, companyName: companyName || null, years: all }, null, 2), 'utf8'); } catch (e) {}
  } else {
    const found = await safeExtractDebits(page, (argvC.year||argvC.y||new Date().getFullYear()), 3);
    try { fs.writeFileSync('debitos_all.json', JSON.stringify({ cnpj: digits, companyName: companyName || null, years: found }, null, 2), 'utf8'); } catch (e) {}
  }

  // final attempt to find name via label
  try {
    const nameFromLabel = await findNameByLabel(page);
    if (nameFromLabel) {
      companyName = nameFromLabel;
      try {
        if (fs.existsSync('debitos_all.json')) {
          const agg = JSON.parse(fs.readFileSync('debitos_all.json','utf8'));
          agg.companyName = companyName;
          fs.writeFileSync('debitos_all.json', JSON.stringify(agg, null, 2), 'utf8');
        }
      } catch (e) {}
    }
  } catch (e) {}

  await page.screenshot({ path: 'resultado_playwright.png', fullPage: true }).catch(()=>{});
  await browser.close();
  console.log('Playwright scrape finished');
})();

// Remover bloco duplicado e desnecessário, pois já existe scraping principal otimizado acima
