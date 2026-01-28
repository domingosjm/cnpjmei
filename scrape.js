/**
 * Script de automação para extração de débitos do MEI (Microempreendedor Individual) no site da Receita Federal do Brasil.
 *
 * Utiliza Puppeteer Extra com plugins de stealth e adblocker (opcional) para simular um navegador real e evitar bloqueios anti-bot.
 * 
 * Funcionalidades principais:
 * - Acessa a página de identificação do MEI.
 * - Preenche automaticamente o campo de CNPJ informado via linha de comando.
 * - Navega pelo menu para acessar a área de emissão de guias de pagamento (DAS).
 * - Seleciona o(s) ano(s) disponível(is) para consulta de débitos.
 * - Extrai tabelas de débitos, valores e informações relevantes.
 * - Salva os dados extraídos em arquivos JSON por ano e um agregado.
 * - Tira screenshot do resultado final.
 * 
 * Parâmetros de linha de comando:
 *   --cnpj=XXXXXXXXXXXXXX   CNPJ do MEI a consultar (obrigatório)
 *   --year=YYYY            Ano a consultar (opcional, padrão: 2024)
 *   --month=MM             Mês a consultar (opcional, padrão: 1)
 *   --no-headless          Executa o navegador com interface gráfica (debug)
 * 
 * Requisitos:
 * - Node.js
 * - puppeteer-extra, puppeteer-extra-plugin-stealth, minimist
 * - (Opcional) puppeteer-extra-plugin-adblocker
 * 
 * Uso:
 *   node scrape.js --cnpj=00000000000191 --year=2024 --month=1
 *
 * Observações:
 * - O script tenta contornar proteções anti-bot (ex: hCaptcha), mas pode exigir intervenção manual caso haja bloqueios.
 * - Os seletores e fluxos são adaptativos para lidar com possíveis mudanças na interface do site.
 */
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
let AdblockerPlugin = null;
try {
  AdblockerPlugin = require('puppeteer-extra-plugin-adblocker');
} catch (e) {
  // adblocker not installed; continue without it
}
const argv = require('minimist')(process.argv.slice(2));
const fs = require('fs');

puppeteer.use(StealthPlugin());
if (AdblockerPlugin) {
  try {
    puppeteer.use(AdblockerPlugin({ blockTrackers: true }));
  } catch (e) {
    console.warn('Falha ao registrar AdblockerPlugin:', e.message || e);
  }
} else {
  console.warn('`puppeteer-extra-plugin-adblocker` não está instalado; executando sem adblocker.');
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// headless flag handling: --no-headless to run with UI for debugging
let headless = true;
if ('no-headless' in argv || 'noheadless' in argv) headless = false;
if ('headless' in argv) headless = !!argv.headless;


const URL = 'https://www8.receita.fazenda.gov.br/SimplesNacional/Aplicacoes/ATSPO/pgmei.app/Identificacao';

const CNPJ = argv.cnpj || argv._[0] || '';
const YEAR = String(argv.year || argv.y || '2024');
const MONTH = String(argv.month || argv.m || '1');

if (!CNPJ) {
  console.error('Informe o CNPJ: node scrape.js --cnpj=00000000000191 --year=2024 --month=1');
  process.exit(1);
}

function xpathByText(text) {
  return `//*[contains(normalize-space(string(.)), "${text}")]`;
}

async function findCNPJInput(page) {
  // Prioritize exact id/name when present
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
      if (el) {
        console.log('findCNPJInput: encontrado seletor:', sel);
        return el;
      }
    } catch (e) {}
  }
  // Try label with text 'CNPJ' — use page.$$ and text comparison (more robust)
  const allLabels = await page.$$('label');
  const labelHandles = [];
  for (const lh of allLabels) {
    let txt = '';
    try {
      txt = (await (await lh.getProperty('innerText')).jsonValue()) || '';
    } catch (e) {}
    if (txt && txt.toUpperCase().includes('CNPJ')) labelHandles.push(lh);
  }
  for (const lh of labelHandles) {
    const forAttr = await lh.evaluate(l => l.getAttribute('for'));
    if (forAttr) {
      const el = await page.$(`#${forAttr}`);
      if (el) return el;
    }
    const sibling = await lh.evaluateHandle(l => {
      let el = l.nextElementSibling;
      while (el && el.tagName !== 'INPUT') el = el.nextElementSibling;
      return el;
    });
    if (sibling && (await sibling.asElement())) return sibling.asElement();
  }
  // fallback: first text input
  const inputs = await page.$$('input[type="text"], input:not([type])');
  if (inputs && inputs.length) console.log('findCNPJInput: usando primeiro input text como fallback');
  return inputs[0] || null;
}

function normalizeCNPJ(raw) {
  return String(raw).replace(/\D/g, '');
}

async function findCompanyNameFromListInline(page) {
  try {
    const ul = await page.$('ul.list-inline');
    if (!ul) return null;
    const items = await ul.$$eval('li', lis => lis.map(li => (li.innerText || '').trim()).filter(Boolean));
    if (items && items.length) return items.join(' - ');
    // fallback: innerText of ul
    const txt = await (await ul.getProperty('innerText')).jsonValue();
    return txt ? String(txt).trim() : null;
  } catch (e) {
    return null;
  }
}

async function findNameByLabel(page) {
  try {
    const elems = await page.$$('label, td, th, div, span, p, strong');
    for (const el of elems) {
      try {
        const txt = (await (await el.getProperty('innerText')).jsonValue()) || '';
        if (!txt) continue;
        const lower = String(txt).toLowerCase();
        if (lower.includes('nome')) {
          // try for attribute
          const forAttr = await el.evaluate(n => n.getAttribute && n.getAttribute('for'));
          if (forAttr) {
            const target = await page.$(`#${forAttr}`);
            if (target) {
              const v = (await (await target.getProperty('innerText')).jsonValue()) || (await (await target.getProperty('value')).jsonValue()) || '';
              if (v && String(v).trim()) return String(v).trim();
            }
          }
          // try next sibling chain
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
          // try nearby text nodes/children as fallback
          const nearText = await page.evaluate(node => {
            try {
              function collectText(n) {
                if (!n) return '';
                if (n.nodeType === Node.TEXT_NODE) return (n.textContent || '').trim();
                let txt = '';
                for (const c of Array.from(n.childNodes || [])) txt += ' ' + collectText(c);
                return txt.trim();
              }
              let cur = node.nextElementSibling;
              for (let i = 0; i < 6 && cur; i++) {
                const t = collectText(cur);
                if (t) return t;
                cur = cur.nextElementSibling;
              }
            } catch (e) {}
            return null;
          }, el);
          if (nearText) return nearText;
        }
      } catch (e) {}
    }
  } catch (e) {}
  return null;
}


(async () => {
  const browser = await puppeteer.launch({ headless, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });

  // set a realistic User-Agent and Accept-Language
  const defaultUA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36';
  await page.setUserAgent(defaultUA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7' });

  // small navigator tweaks in case stealth misses something
  await page.evaluateOnNewDocument(() => {
    try {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    } catch (e) {}
    try {
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt'] });
    } catch (e) {}
    try {
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
    } catch (e) {}
    try {
      window.navigator.chrome = { runtime: {} };
    } catch (e) {}
  });

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 60000 });

  // Detect hCaptcha / proteção anti-bot
  const content = await page.content();
  const hasHCaptcha = /hcaptcha/i.test(content) || /hcaptcha.com/i.test(content) || await page.$('iframe[src*="hcaptcha"]');
  if (hasHCaptcha) {
    // Não bloquear: loga e espera brevemente por possíveis mudanças, depois continua automaticamente.
    console.warn('\nhCaptcha detectado — não será necessário pressionar Enter; o script continuará automaticamente.');
    // breve polling para aguardar remoção do iframe ou aparecimento de resultados (não bloqueante)
    try {
      const maxWait = 100; // 10s
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        try {
          const frames = await page.frames();
          const hasHCaptchaFrame = frames.some(f => (f.url() || '').toLowerCase().includes('hcaptcha'));
          const iframeHandle = await page.$('iframe[src*="hcaptcha"]');
          const table = await page.$('table');
          const listInline = await page.$('ul.list-inline');
          if ((!hasHCaptchaFrame && !iframeHandle) || table || listInline) break;
        } catch (e) {}
        await sleep(500);
      }
    } catch (e) {}
  }

  // ====== localização automática do campo CNPJ ======
  const cnpjEl = await findCNPJInput(page);
  if (!cnpjEl) {
    console.error('Campo de CNPJ não encontrado. Ajuste seletores manualmente.');
    await browser.close();
    process.exit(1);
  }
  await sleep(500);
  try {
    await cnpjEl.click({ clickCount: 3 });
  } catch (e) {}
  const digits = normalizeCNPJ(CNPJ);
  try {
    await cnpjEl.type(digits, { delay: 50 });
  } catch (e) {
    // fallback: set value via JS if elementHandle.type fails
    try {
      const id = await (await cnpjEl.getProperty('id')).jsonValue().catch(() => null);
      const name = await (await cnpjEl.getProperty('name')).jsonValue().catch(() => null);
      if (id) {
        await page.evaluate((i, v) => { const el = document.getElementById(i); if (el) { el.focus(); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } }, id, digits);
      } else if (name) {
        await page.evaluate((n, v) => { const el = document.getElementsByName(n)[0]; if (el) { el.focus(); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); } }, name, digits);
      } else {
        // direct element handle evaluation as last resort
        await cnpjEl.evaluate((el, v) => { el.focus(); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }, digits);
      }
    } catch (ee) {
      console.warn('Falha ao preencher campo de CNPJ automaticamente.');
    }
  }
  // confirm value readback for debugging
  try {
    const value = await page.evaluate((el) => el.value, cnpjEl);
    console.log('Valor no campo CNPJ após preenchimento:', value);
  } catch (e) {
    try {
      const id = await (await cnpjEl.getProperty('id')).jsonValue().catch(() => null);
      const name = await (await cnpjEl.getProperty('name')).jsonValue().catch(() => null);
      let value = null;
      if (id) value = await page.$eval(`#${id}`, el => el.value).catch(() => null);
      else if (name) value = await page.$eval(`[name="${name}"]`, el => el.value).catch(() => null);
      console.log('Valor no campo CNPJ após preenchimento (via id/name):', value);
    } catch (ee) {}
  }

  // capturar nome na lista inline (se presente)
  // --- Extrair CNPJ e Nome do HTML (similar ao PHP) ---
  const htmlContent = await page.content();
  let cnpjFromHtml = null;
  let nomeFromHtml = null;
  try {
    const cnpjMatch = htmlContent.match(/CNPJ:<\/strong>\s*([\d\.\/-]+)/);
    const nomeMatch = htmlContent.match(/Nome:<\/strong>\s*([^<]+)/);
    if (cnpjMatch) cnpjFromHtml = cnpjMatch[1].trim();
    if (nomeMatch) nomeFromHtml = nomeMatch[1].trim();
    if (cnpjFromHtml) console.log('CNPJ extraído do HTML:', cnpjFromHtml);
    if (nomeFromHtml) console.log('Nome extraído do HTML:', nomeFromHtml);
  } catch (e) {
    console.warn('Erro ao extrair CNPJ/Nome do HTML:', e.message || e);
  }

  // capturar nome na lista inline (se presente)
  let companyName = null;
  try {
    companyName = await findCompanyNameFromListInline(page);
    if (companyName) console.log('Nome da empresa detectado em ul.list-inline:', companyName);
    else console.log('ul.list-inline não encontrada ou vazia.');
  } catch (e) {
    console.warn('Erro ao ler ul.list-inline:', e.message || e);
  }

  // Submeter ou avançar — depende do comportamento da página
  // Tente um botão ou pressione Enter
  try {

      await page.keyboard.press('Enter');
      try {
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 });
      } catch (e) {
        // não houve navegação visível; prosseguir
      }
    } catch (e) {}

    // Aguarda menu/link aparecer
    await sleep(100);

  // Clicar no menu "Emitir Guia de Pagamento (DAS)"
  const MENU_TEXT = 'Emitir Guia de Pagamento (DAS)';
  let menuEl = null;
  const tagCandidates = ['a', 'button', 'li', 'span', 'div', 'td'];
  for (const tag of tagCandidates) {
    const els = await page.$$(tag);
    for (const el of els) {
      try {
        const txt = (await (await el.getProperty('innerText')).jsonValue()) || '';
        if (txt && txt.trim().includes(MENU_TEXT)) {
          menuEl = el;
          break;
        }
      } catch (e) {}
    }
    if (menuEl) break;
  }
  if (menuEl) {
    try {
      await menuEl.click();
      try { await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 5000 }); } catch (e) {}
    } catch (e) {
      try { await menuEl.click(); } catch (ee) {}
    }
  } else {
    console.warn('Menu não encontrado por texto. Verifique o seletor / texto.');
  }

  await sleep(100);

  // Selecionar anos disponíveis e iterar (exclui opções com "não optante")
  const YEAR_SELECTOR = 'select[id*="ano"]';

  async function getAvailableYears(page) {
    // tenta select primeiro
    if (await page.$(YEAR_SELECTOR)) {
      const opts = await page.$$eval(`${YEAR_SELECTOR} option`, options =>
        options.map(o => ({ value: o.value, text: o.innerText.trim(), disabled: o.disabled || o.classList.contains('disabled') }))
      );
      return opts.filter(o => o.text && !/não optante/i.test(o.text) && !o.disabled);
    }
    // fallback: buscar botões/links com anos
    const els = await page.$$('a, button, span, div');
    const years = [];
    for (const el of els) {
      try {
        const txt = (await (await el.getProperty('innerText')).jsonValue()) || '';
        const t = txt.trim();
        const isDisabled = await el.evaluate(n => {
          try {
            return (n.classList && (n.classList.contains('disabled') || n.classList.contains('disabled-option'))) || n.getAttribute && (n.getAttribute('disabled') !== null || n.getAttribute('aria-disabled') === 'true') || n.disabled;
          } catch (e) { return false; }
        });
        if (/^\d{4}$/.test(t) && !/não optante/i.test(t) && !isDisabled) years.push({ value: t, text: t, handle: el });
      } catch (e) {}
    }
    return years;
  }

  // Extrair débitos do ano: procurar tabelas com valores monetários e linhas que correspondam ao ano
  async function extractDebits(page, year) {
    const currencyRegex = /R\$\s*[\d\.]+,\d{2}|[\d\.]+,\d{2}/g;
    const expectedHeaders = [
      'período de apuração', 'apurado', 'benefício inss', 'resumo do das a ser gerado',
      'principal', 'multa', 'juros', 'total', 'data de vencimento', 'data de acolhimento'
    ];

    const tables = await page.$$('table');
    const results = [];

    function normalizeHeader(s) {
      return s.replace(/\s+/g, ' ').trim().toLowerCase();
    }

    for (const table of tables) {
      try {
        const text = (await (await table.getProperty('innerText')).jsonValue()) || '';
        if (!currencyRegex.test(text)) continue; // skip tables without monetary values

        // try to read header cells
        const headerCells = await table.$$('th');
        let headers = [];
        if (headerCells && headerCells.length) {
          for (const hc of headerCells) {
            const hv = String((await (await hc.getProperty('innerText')).jsonValue()) || '').trim();
            headers.push(normalizeHeader(hv));
          }
        } else {
          // try first row as header
          const firstRow = (await table.$$('tr'))[0];
          if (firstRow) {
            const tds = await firstRow.$$('*');
            for (const td of tds) {
              const tv = String((await (await td.getProperty('innerText')).jsonValue()) || '').trim();
              headers.push(normalizeHeader(tv));
            }
          }
        }

        const hasExpected = headers.some(h => expectedHeaders.includes(h));
        if (hasExpected && headers.length) {
          // map header positions to canonical keys
          const mapKeys = headers.map(h => {
            const idx = expectedHeaders.indexOf(h);
            return idx >= 0 ? expectedHeaders[idx] : h;
          });

          const rows = await table.$$('tr');
          // skip header row if headerCells existed or first row used as header
          const start = headerCells && headerCells.length ? 1 : 1;
          for (let i = start; i < rows.length; i++) {
            try {
              const row = rows[i];
              const cells = await row.$$('*');
              const rowObj = {};
              const cellValues = [];
              for (const c of cells) {
                const v = String((await (await c.getProperty('innerText')).jsonValue()) || '').trim();
                cellValues.push(v);
              }
              // align cellValues to mapKeys
              for (let k = 0; k < mapKeys.length; k++) {
                rowObj[mapKeys[k] || `col_${k}`] = cellValues[k] || null;
              }
              results.push(rowObj);
            } catch (e) {}
          }
        } else {
          // fallback: existing heuristic
          const rows = await table.$$('tr');
          for (const r of rows) {
            try {
              let rowText = await (await r.getProperty('innerText')).jsonValue();
              rowText = String(rowText).trim();
              if (!rowText) continue;
              if (rowText.includes(String(year)) || currencyRegex.test(rowText)) {
                const parts = rowText.split(/\t+|\s{2,}/).map(s => s.trim()).filter(Boolean);
                const amountPart = parts.slice().reverse().find(p => /\d+[\.,]\d{2}/.test(p));
                const amount = amountPart ? amountPart.replace(/[R\$\s\.]/g, '').replace(',', '.') : null;
                results.push({ raw: rowText, parts, amount: amount ? Number(amount) : null });
              }
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
    return results;
  }

  // extrator com retry para lidar com possíveis mudanças de contexto (navegações que invalidam handles)
  async function safeExtractDebits(page, year, tries = 2) {
    for (let i = 0; i < tries; i++) {
      try {
        return await extractDebits(page, year);
      } catch (err) {
        const msg = String(err && err.message || err || '');
        if (msg.includes('Execution context was destroyed') || msg.includes('Execution context')) {
          console.warn('Contexto destruído detectado durante extração; tentando novamente...', i + 1);
          await sleep(100);
          continue;
        }
        throw err;
      }
    }
    return [];
  }

  let debitos = [];
  try {
    // se existe um select, iterar todas as opções (exceto 'não optante')
    const years = await getAvailableYears(page);
    if (years && years.length) {
      const all = [];
      for (const y of years) {
        const yearLabel = y.text || y.value;
        console.log('Processando ano:', yearLabel);
        // selecionar ano
        try {
          if (await page.$(YEAR_SELECTOR)) {
            await page.select(YEAR_SELECTOR, y.value);
            await sleep(100);
          } else {
            // tenta clicar em dropdown estilo bootstrap/selectpicker
            const toggle = await page.$('[class*="filter-option"], .dropdown-toggle, [class*="selectpicker"]');
            if (toggle) {
              try { await toggle.click(); await sleep(100); } catch (e) {}
              // procurar opção visível
              const optionSelectors = ['.dropdown-menu li', '.dropdown-menu a', '.dropdown-item', '.bs-list li', 'li'];
              let clicked = false;
              for (const sel of optionSelectors) {
                const opts = await page.$$(sel);
                for (const o of opts) {
                  try {
                      const isDisabledOpt = await o.evaluate(n => {
                        try { return (n.classList && (n.classList.contains('disabled') || n.classList.contains('disabled-option'))) || n.getAttribute && (n.getAttribute('disabled') !== null || n.getAttribute('aria-disabled') === 'true') || n.disabled; } catch (e) { return false; }
                      });
                      if (isDisabledOpt) continue;
                      const txt = (await (await o.getProperty('innerText')).jsonValue()) || '';
                      if (txt && txt.trim() === String(yearLabel)) {
                        try { await o.click(); clicked = true; break; } catch (e) {}
                      }
                  } catch (e) {}
                }
                if (clicked) break;
              }
              if (!clicked && y.handle) {
                try { await y.handle.click(); } catch (e) {}
              }
            } else if (y.handle) {
              try { await y.handle.click(); } catch (e) {}
            }
            await sleep(100);
          }
        } catch (e) { console.warn('Falha ao selecionar ano', yearLabel); }

        // disparar evento change no select (caso necessário) e acionar botão de consulta/OK
        try {
          if (await page.$(YEAR_SELECTOR)) {
            await page.evaluate(sel => {
              const s = document.querySelector(sel);
              if (s) {
                s.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, YEAR_SELECTOR);
            await sleep(100);
          }
        } catch (e) {}

        let consulted = false;
        // clique específico em elementos Ladda 'Ok' (`<span class="ladda-label">Ok</span>`)
        try {
          const clickedLadda = await page.evaluate(() => {
            const spans = Array.from(document.querySelectorAll('span.ladda-label'));
            for (const s of spans) {
              if (!s || !s.innerText) continue;
              if (s.innerText.trim().toLowerCase() === 'ok') {
                let cur = s;
                for (let i = 0; i < 4 && cur; i++) {
                  if (['BUTTON', 'A', 'INPUT'].includes(cur.tagName) || (cur.getAttribute && cur.getAttribute('role') === 'button')) {
                    try { cur.click(); return true; } catch (e) {}
                  }
                  cur = cur.parentElement;
                }
                try { s.click(); return true; } catch (e) {}
              }
            }
            return false;
          });
          if (clickedLadda) {
            consulted = true;
            try {
              await Promise.race([
                page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 6000 }),
                page.waitForSelector('table', { timeout: 6000 })
              ]);
            } catch (e) { await sleep(100); }
          }
        } catch (e) {}
        const consultButtonsText = ['Consultar', 'Pesquisar', 'Filtrar', 'OK', 'Ok', 'Continuar', 'Buscar', 'Pesquisar Débitos', 'Emitir', 'Confirmar'];
        // expandir tipos de elementos buscados (inclui spans/divs e role=button)
        for (const t of consultButtonsText) {
          const btns = await page.$$("button, a, input[type='button'], input[type='submit'], [role='button'], div, span");
          for (const b of btns) {
            try {
              const txt = (await (await b.getProperty('innerText')).jsonValue()) || (await (await b.getProperty('value')).jsonValue()) || '';
              if (txt && txt.trim().includes(t)) { try { await b.click(); consulted = true; break; } catch (e) {} }
            } catch (e) {}
          }
          if (consulted) break;
        }

        // tentativa adicional via XPath para textos exatos/visíveis (mais robusto)
        if (!consulted) {
          for (const t of consultButtonsText) {
            try {
              const xpath = `//*[contains(normalize-space(string(.)), "${t}") and (self::button or self::a or self::div or self::span or @role='button' or self::input)]`;
              const elems = await page.$x(xpath);
              if (elems && elems.length) {
                for (const el of elems) {
                  try { await el.click(); consulted = true; break; } catch (e) {}
                }
              }
            } catch (e) {}
            if (consulted) break;
          }
        }

        if (consulted) {
          try {
            await Promise.race([
              page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 6000 }),
              page.waitForSelector('table', { timeout: 6000 })
            ]);
          } catch (e) {
            await sleep(100);
          }
        }

        const found = await safeExtractDebits(page, yearLabel, 3);
        if (found && found.length) {
          const outPath = `debitos_${yearLabel}.json`;
          // Usa companyName, se não houver, tenta nomeFromHtml, se não houver, null
          const payload = { cnpj: digits, companyName: companyName || nomeFromHtml || null, year: yearLabel, items: found };
          try { fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8'); console.log(`Salvo ${found.length} débitos em ${outPath}`); } catch (e) { console.warn('Falha ao salvar:', e.message || e); }
          all.push({ year: yearLabel, items: found });
        } else {
          console.log('Nenhum débito encontrado para', yearLabel);
        }
        // pequena espera entre anos
        await sleep(100);
      }
      // salvar agregado
      try { fs.writeFileSync(`debitos_all.json`, JSON.stringify({ cnpj: digits, companyName: companyName || nomeFromHtml || null, years: all }, null, 2), 'utf8'); } catch (e) {}
      debitos = all;
    } else {
      debitos = await safeExtractDebits(page, YEAR, 3);
    }
  } catch (e) {
    console.warn('Erro ao extrair débitos:', e.message || e);
    debitos = [];
  }

  // No final da extração, tentar extrair o nome via label 'Nome' se disponível e sobrescrever companyName
  try {
    const nameFromLabel = await findNameByLabel(page);
    if (nameFromLabel) {
      console.log('Nome encontrado via label "Nome":', nameFromLabel);
      companyName = nameFromLabel;
      // atualizar arquivos já salvos para incluir companyName quando aplicável
      try {
        const aggregatePath = 'debitos_all.json';
        if (fs.existsSync(aggregatePath)) {
          const agg = JSON.parse(fs.readFileSync(aggregatePath, 'utf8'));
          agg.companyName = companyName;
          fs.writeFileSync(aggregatePath, JSON.stringify(agg, null, 2), 'utf8');
        }
      } catch (e) {}
    }
  } catch (e) {
    // não bloquear o fluxo principal se falhar
  }

  if (debitos && debitos.length) {
    const outPath = `debitos_${YEAR}.json`;
    const payload = { cnpj: digits, companyName: companyName || null, year: YEAR, items: debitos };
    try { fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8'); console.log(`Extraiu ${debitos.length} linhas. Salvo em ${outPath}`); } catch (e) { console.warn('Falha ao salvar JSON de débitos:', e.message || e); }
  } else {
    console.log('Nenhum débito encontrado automaticamente para o ano', YEAR);
  }

  // Tirar screenshot do resultado
  await page.screenshot({ path: 'resultado.png', fullPage: true });
  console.log('Screenshot salvo em resultado.png');

  await browser.close();
})();
