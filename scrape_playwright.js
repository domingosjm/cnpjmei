const { Console } = require('console');
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
  let allOpts = [];
  if (await page.$(YEAR_SELECTOR)) {
    allOpts = await page.$$eval(`${YEAR_SELECTOR} option`, options =>
      options.map(o => ({ value: o.value, text: o.innerText.trim(), disabled: o.disabled || o.classList.contains('disabled') }))
    );
  } else {
    // Try to open dropdown if it's a custom select
    const toggle = await page.$('[class*="filter-option"], .dropdown-toggle, [class*="selectpicker"]');
    if (toggle) {
      try { await toggle.click(); await sleep(400); } catch (e) {}
    }
    const els = await page.$$('a, button, span, div, li, option');
    for (const el of els) {
      try {
        const txt = (await el.innerText()).trim();
        const isDisabled = await el.getAttribute('aria-disabled') === 'true' || (await el.getAttribute('disabled')) !== null || (await el.getAttribute('class') || '').includes('disabled');
        // Procura por anos (4 dígitos) ou texto com "não optante"
        if (/^\d{4}$/.test(txt) || /não optante/i.test(txt)) {
          const yearMatch = txt.match(/(\d{4})/);
          const year = yearMatch ? yearMatch[1] : txt;
          const isNotOptante = /não optante/i.test(txt) || isDisabled;
          allOpts.push({ value: year, text: txt, disabled: isNotOptante, handle: el });
        }
      } catch (e) {}
    }
    // Close dropdown if opened
    if (toggle) {
      try { await toggle.click(); } catch (e) {}
    }
  }
  
  // Separar disponíveis dos não optantes com base no status disabled
  const available = allOpts.filter(o => o.text && !o.disabled && /^\d{4}$/.test(o.value || o.text));
  const notOptante = allOpts.filter(o => o.disabled || /não optante/i.test(o.text));
  
  return { available, notOptante, all: allOpts };
}

function normalizeHeader(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

async function extractDebits(page, year) {
  // Enhanced extraction with more comprehensive data capture
  return await page.evaluate((year) => {
    const currencyRegex = /R\$\s*[\d\.]+,\d{2}|[\d\.]+,\d{2}/g;
    const expectedHeaders = [
      'período de apuração', 'periodo de apuracao', 'periodo', 'mes', 'mês',
      'apurado', 'valor apurado', 'benefício inss', 'beneficio inss', 'inss',
      'resumo do das a ser gerado', 'das', 'guia',
      'principal', 'valor principal', 'multa', 'juros', 'total', 'valor total',
      'data de vencimento', 'vencimento', 'data vencimento',
      'data de acolhimento', 'acolhimento', 'data acolhimento',
      'situação', 'situacao', 'status', 'pago', 'pendente'
    ];
    function normalizeHeader(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }
    const out = [];
    
    // Search all possible table containers
    const containers = Array.from(document.querySelectorAll('table, div[class*="table"], .datatable, .grid, .list'));
    
    for (const container of containers) {
      try {
        const containerText = container.innerText || '';
        
        // Skip if no currency values or year references
        if (!currencyRegex.test(containerText) && !containerText.includes(String(year))) continue;
        
        // Try to find table structure
        const tables = container.tagName === 'TABLE' ? [container] : Array.from(container.querySelectorAll('table'));
        
        if (tables.length === 0) {
          // Handle non-table structured data
          const rows = Array.from(container.querySelectorAll('div[class*="row"], tr, li'));
          for (const row of rows) {
            const rowText = (row.innerText || '').trim();
            if (rowText && (rowText.includes(String(year)) || currencyRegex.test(rowText))) {
              const parts = rowText.split(/\t+|\s{3,}|\|/).map(s => s.trim()).filter(Boolean);
              const currencies = rowText.match(currencyRegex) || [];
              out.push({
                raw: rowText,
                parts: parts,
                currencies: currencies,
                year: year,
                source: 'non-table'
              });
            }
          }
          continue;
        }
        
        // Process actual tables
        for (const table of tables) {
          try {
            const tableText = table.innerText || '';
            if (!currencyRegex.test(tableText) && !tableText.includes(String(year))) continue;
            
            const rows = Array.from(table.querySelectorAll('tr'));
            if (rows.length === 0) continue;
            
            // Extract headers from first few rows
            let headers = [];
            let headerRowIndex = -1;
            
            for (let i = 0; i < Math.min(3, rows.length); i++) {
              const cells = Array.from(rows[i].querySelectorAll('td, th'));
              const potentialHeaders = cells.map(cell => normalizeHeader(cell.innerText || ''));
              
              if (potentialHeaders.some(h => expectedHeaders.includes(h))) {
                headers = potentialHeaders;
                headerRowIndex = i;
                break;
              }
            }
            
            // If no clear headers found, use first row or create generic headers
            if (headers.length === 0 && rows.length > 0) {
              const firstRowCells = Array.from(rows[0].querySelectorAll('td, th'));
              if (firstRowCells.length > 0) {
                headers = firstRowCells.map((_, idx) => `col_${idx}`);
                headerRowIndex = -1; // Don't skip first row
              }
            }
            
            // Process data rows
            const startRow = headerRowIndex >= 0 ? headerRowIndex + 1 : 0;
            
            for (let i = startRow; i < rows.length; i++) {
              try {
                const row = rows[i];
                const cells = Array.from(row.querySelectorAll('td, th'));
                const rowText = row.innerText || '';
                
                // Skip empty rows
                if (!rowText.trim()) continue;
                
                // Include row if it has currency or year reference
                if (currencyRegex.test(rowText) || rowText.includes(String(year)) || 
                    cells.some(cell => currencyRegex.test(cell.innerText || ''))) {
                  
                  const rowObj = { year: year, source: 'table' };
                  
                  // Map cells to headers
                  for (let k = 0; k < Math.max(cells.length, headers.length); k++) {
                    const cellValue = (cells[k] && cells[k].innerText || '').trim();
                    const headerKey = headers[k] || `col_${k}`;
                    
                    // Map to expected header if found
                    const mappedKey = expectedHeaders.find(expected => 
                      headerKey === expected || headerKey.includes(expected.split(' ')[0])
                    ) || headerKey;
                    
                    rowObj[mappedKey] = cellValue || null;
                  }
                  
                  // Extract all currency values
                  const currencies = rowText.match(currencyRegex) || [];
                  rowObj.currencies = currencies;
                  rowObj.raw = rowText;
                  
                  out.push(rowObj);
                }
              } catch (e) {
                console.warn('Error processing row:', e);
              }
            }
          } catch (e) {
            console.warn('Error processing table:', e);
          }
        }
      } catch (e) {
        console.warn('Error processing container:', e);
      }
    }
    
    return out.length > 0 ? out : [];
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
 //
  const digits = normalizeCNPJ(CNPJ);
  const browser = await chromium.connectOverCDP('ws://localhost:9222/devtools/browser/a26eda10-ba61-40e3-90c3-c21e2ddf6f59');
  const context = browser.contexts()[0];
  const pages = context.pages();
  const page = await context.newPage();
  await page.goto('https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao');
  //const browser = await chromium.launch({ headless, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  //const context = await browser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36', locale: 'pt-BR' });
 await context.addInitScript(() => {
   try { Object.defineProperty(navigator, 'webdriver', { get: () => false }); } catch (e) {}
    try { Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt'] }); } catch (e) {}
    try { Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] }); } catch (e) {}
  });
  //const page = await context.newPage();
  //const page = await browser.newPage();
 // await page.setViewportSize({ width: 1280, height: 900 });
console.log('Navigating to page...');
  //await page.goto(URL, { waitUntil: 'networkidle', timeout: 60000 })

  
  const cnpjEl = await findCNPJInput(page);
  if (!cnpjEl) { console.error('Campo de CNPJ não encontrado.'); await browser.close(); process.exit(1); }
  try { await cnpjEl.click({ clickCount: 1 }); } catch (e) {}
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
//////DAQUI PARA FRENTE ESTAMOS DENTRO DA PAGINA JA CARREGADA
  let companyName = await findCompanyNameFromListInline(page);
  if (companyName) console.log('Nome da empresa detectado em ul.list-inline:', companyName);

  // press Enter to submit
  try { await page.keyboard.press('Enter'); try { await page.waitForLoadState('networkidle', { timeout: 5000 }); } catch (e) {} } catch (e) {}
  await sleep(1500);

  // click menu
  const MENU_TEXT = 'Emitir Guia de Pagamento (DAS)';
  console.log('Evaristo');
  try {
    await page.waitForSelector(`text="${MENU_TEXT}"`, { timeout: 10000 });
    const menu = await page.$(`text="${MENU_TEXT}"`);
    if (menu) { 
      try { 
        await menu.click(); 
        await page.waitForLoadState('networkidle', { timeout: 5000 }); 
      } catch (e) {} 
    }
  } catch (e) {}
 console.log('Evaristo 2');
  const { available: years, notOptante, all: allYears } = await getAvailableYears(page);
 console.log('Evaristo 3')
  // Função para processar scraping de todos os anos na mesma página
  async function scrapeAllYearsSequential(page, digits, companyName, years) {
    let all = [];
    for (const yearObj of years) {
      const yearLabel = yearObj.text || yearObj.value;
      // Sempre clicar no menu antes de selecionar o ano
      const MENU_TEXT = 'Emitir Guia de Pagamento (DAS)';
      try {
        const menu = await page.$(`text="${MENU_TEXT}"`);
        if (menu) {
          await menu.click();
          await page.waitForLoadState('networkidle', { timeout: 20 }).catch(() => {});
          await sleep(10);
        }
      } catch (e) {}
      // Selecionar ano
      try {
        if (await page.$('select[id*="ano"]')) {
          await page.selectOption('select[id*="ano"]', yearObj.value);
          await sleep(50);
        } else {
          const toggle = await page.$('[class*="filter-option"], .dropdown-toggle, [class*="selectpicker"]');
          if (toggle) { try { await toggle.click(); await sleep(400); } catch (e) {} }
          const opt = await page.$(`text="${yearLabel}"`);
          if (opt) try { await opt.click(); } catch (e) {}
          await sleep(50);
        }
      } catch (e) {}
      // Consultar
      try {
        const consultTexts = ['Consultar','Pesquisar','Filtrar','OK','Ok','Continuar','Buscar','Pesquisar Débitos','Emitir','Confirmar'];
        let consultou = false;
        for (const t of consultTexts) {
          const btn = await page.$(`text=${t}`);
          if (btn) { try { await btn.click(); consultou = true; break; } catch (e) {} }
        }
        if (consultou) {
          await page.waitForSelector('table', { timeout: 10000 }).catch(() => {});
          await sleep(50);
        }
      } catch (e) {}
      // Tentar extrair mesmo se não encontrar tabela
      const found = await safeExtractDebits(page, yearLabel, 3);
      if (found && found.length) {
        try { fs.writeFileSync(`debitos_${yearLabel}.json`, JSON.stringify({ cnpj: digits, companyName: companyName || null, year: yearLabel, items: found }, null, 2), 'utf8'); } catch (e) {}
      }
      all.push({ year: yearLabel, items: found });
    }
    return all;
  }
console.log('Evaristo 4')
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
  let resultJson;
  if (years && years.length) {
    all = await scrapeAllYearsSequential(page, digits, companyName, years);
    resultJson = { 
      cnpj: digits, 
      companyName: companyName || null, 
      availableYears: years.map(y => y.text || y.value),
      notOptanteYears: notOptante.map(y => y.text || y.value),
      allYears: allYears.map(y => y.text || y.value),
      years: all 
    };
    try { fs.writeFileSync('debitos_all.json', JSON.stringify(resultJson, null, 2), 'utf8'); } catch (e) {}
  } else {
    const found = await safeExtractDebits(page, (argvC.year||argvC.y||new Date().getFullYear()), 3);
    resultJson = { 
      cnpj: digits, 
      companyName: companyName || null, 
      availableYears: years.map(y => y.text || y.value),
      notOptanteYears: notOptante.map(y => y.text || y.value),
      allYears: allYears.map(y => y.text || y.value),
      years: found 
    };
    try { fs.writeFileSync('debitos_all.json', JSON.stringify(resultJson, null, 2), 'utf8'); } catch (e) {}
  }


  // Extraia o nome do elemento 'li' que contenha 'Nome:' e pegue o texto após 'Nome:'
  let nomeFinal = await page.evaluate(() => {
    const itens = Array.from(document.querySelectorAll('li'));
    const alvo = itens.find(el => el.textContent.includes('Nome:'));
    if (alvo) {
      return alvo.textContent.replace('Nome:', '').trim();
    }
    // fallback: tenta pegar o texto do strong se não encontrar o padrão acima
    const strong = document.querySelector('li strong');
    return strong ? strong.textContent.trim() : null;
  });
  if (nomeFinal) {
    resultJson.companyName = nomeFinal;
    try { fs.writeFileSync('debitos_all.json', JSON.stringify(resultJson, null, 2), 'utf8'); } catch (e) {}
  }

  // Exibir o JSON final no terminal
  console.log('\n===== RESULTADO EXTRAÇÃO =====\n');
  // console.log(JSON.stringify(resultJson, null, 2)); // Removido para evitar duplicação no endpoint
  console.log('\n=============================');

  // Fechar o navegador após exibir o resultado
  await browser.close();

  console.log('Consulta finalizada');
})();


