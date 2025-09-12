import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(
  cors({
    origin: ["http://127.0.0.1:5500", "https://utpschedule.vercel.app"],
  })
);
app.use(express.json());

// ======================
// Configuración para Serverless
// ======================

const SERVERLESS_CONFIG = {
  maxBrowsers: parseInt(process.env.MAX_BROWSERS) || 2,
  browserTimeout: parseInt(process.env.BROWSER_TIMEOUT) || 25000,
  maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
  retryDelay: parseInt(process.env.RETRY_DELAY) || 2000,
  healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL) || 30000,
  browserMaxAge: parseInt(process.env.BROWSER_MAX_AGE) || 5 * 60 * 1000, // 5 minutos
};

// ======================
// Browser Pool Robusto
// ======================

class RobustBrowserPool {
  constructor(maxSize = SERVERLESS_CONFIG.maxBrowsers) {
    this.pool = [];
    this.maxSize = maxSize;
    this.inUse = new Set();
    this.creating = new Set(); // Track browsers being created
    this.healthCheckInterval = null;
    this.stats = {
      created: 0,
      failed: 0,
      closed: 0,
      recycled: 0
    };
    
    this.startHealthCheck();
  }

  async init() {
    console.log(`🔧 Inicializando pool robusto (máximo: ${this.maxSize})`);
    console.log(`⚙️ Configuración serverless:`, SERVERLESS_CONFIG);
  }

  async createBrowser() {
    const startTime = Date.now();
    console.log(`🏗️ Intentando crear navegador... (Total creados: ${this.stats.created})`);

    // Args minimalistas para serverless
    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor,TranslateUI',
      '--disable-extensions',
      '--disable-plugins',
      '--disable-images',
      '--disable-javascript-harmony-shipping',
      '--disable-background-networking',
      '--disable-background-mode',
      '--disable-default-apps',
      '--disable-sync',
      '--disable-translate',
      '--hide-scrollbars',
      '--mute-audio',
      '--no-first-run',
      '--no-default-browser-check',
      '--no-pings',
      '--no-zygote',
      '--single-process',
      '--memory-pressure-off',
      '--max_old_space_size=512',
      '--aggressive-cache-discard',
      '--disable-ipc-flooding-protection',
    ];

    let browser = null;
    
    try {
      browser = await Promise.race([
        puppeteer.launch({
          args,
          executablePath: await chromium.executablePath(),
          headless: 'new', // Use new headless mode
          defaultViewport: { width: 1024, height: 768 },
          timeout: SERVERLESS_CONFIG.browserTimeout,
          ignoreDefaultArgs: ['--disable-extensions'],
          protocolTimeout: 10000,
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Browser launch timeout')), SERVERLESS_CONFIG.browserTimeout)
        )
      ]);

      // Verificar que el navegador esté realmente conectado
      if (!browser || !browser.connected) {
        throw new Error('Browser created but not connected');
      }

      // Test inmediato para verificar funcionalidad
      await this.testBrowser(browser);

      browser._createdAt = Date.now();
      browser._id = `browser-${this.stats.created}`;
      this.stats.created++;

      const duration = Date.now() - startTime;
      console.log(`✅ Navegador creado exitosamente: ${browser._id} (${duration}ms)`);
      
      return browser;

    } catch (error) {
      this.stats.failed++;
      console.error(`❌ Error creando navegador (fallos: ${this.stats.failed}):`, error.message);
      
      // Intentar cerrar navegador fallido
      if (browser) {
        try {
          await browser.close();
        } catch (closeError) {
          console.error('Error cerrando navegador fallido:', closeError.message);
        }
      }
      
      throw error;
    }
  }

  async testBrowser(browser) {
    const testTimeout = 5000;
    const startTime = Date.now();
    
    try {
      // Test básico: crear y cerrar contexto
      const context = await Promise.race([
        browser.createBrowserContext(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Context creation timeout')), testTimeout)
        )
      ]);

      await context.close();
      
      const duration = Date.now() - startTime;
      console.log(`🧪 Test de navegador exitoso (${duration}ms)`);
      
    } catch (error) {
      throw new Error(`Browser test failed: ${error.message}`);
    }
  }

  async getBrowser(retryCount = 0) {
    const maxRetries = SERVERLESS_CONFIG.maxRetries;
    
    try {
      // 1. Buscar navegador disponible y saludable
      for (const browser of this.pool) {
        if (!this.inUse.has(browser) && browser.connected && this.isBrowserHealthy(browser)) {
          this.inUse.add(browser);
          console.log(`🔄 Navegador reutilizado: ${browser._id} (En uso: ${this.inUse.size}/${this.pool.length})`);
          return browser;
        }
      }

      // 2. Crear nuevo navegador si hay espacio
      if (this.pool.length < this.maxSize) {
        const browserId = `creating-${Date.now()}`;
        this.creating.add(browserId);
        
        try {
          const newBrowser = await this.createBrowser();
          this.creating.delete(browserId);
          
          this.pool.push(newBrowser);
          this.inUse.add(newBrowser);
          
          console.log(`➕ Nuevo navegador agregado: ${newBrowser._id} (Pool: ${this.pool.length})`);
          return newBrowser;
          
        } catch (error) {
          this.creating.delete(browserId);
          throw error;
        }
      }

      // 3. Esperar a que se libere uno
      console.log(`⏳ Pool lleno, esperando disponibilidad... (${this.inUse.size}/${this.pool.length})`);
      await this.waitForAvailable(3000);
      
      // Retry recursivo
      return await this.getBrowser(retryCount);

    } catch (error) {
      if (retryCount < maxRetries) {
        console.log(`🔄 Retry ${retryCount + 1}/${maxRetries} en ${SERVERLESS_CONFIG.retryDelay}ms`);
        await this.delay(SERVERLESS_CONFIG.retryDelay);
        return await this.getBrowser(retryCount + 1);
      }
      
      throw new Error(`Failed to get browser after ${maxRetries} retries: ${error.message}`);
    }
  }

  isBrowserHealthy(browser) {
    if (!browser || !browser.connected) return false;
    
    const age = Date.now() - browser._createdAt;
    if (age > SERVERLESS_CONFIG.browserMaxAge) {
      console.log(`👴 Navegador ${browser._id} demasiado viejo (${Math.round(age / 1000)}s)`);
      return false;
    }
    
    return true;
  }

  async waitForAvailable(timeout = 10000) {
    const startTime = Date.now();
    
    return new Promise((resolve, reject) => {
      const check = () => {
        // Check for available browser
        const available = this.pool.find(browser => 
          !this.inUse.has(browser) && browser.connected && this.isBrowserHealthy(browser)
        );
        
        if (available || this.pool.length < this.maxSize) {
          resolve();
          return;
        }
        
        if (Date.now() - startTime > timeout) {
          reject(new Error('Timeout waiting for browser availability'));
          return;
        }
        
        setTimeout(check, 250);
      };
      check();
    });
  }

  releaseBrowser(browser) {
    if (this.inUse.has(browser)) {
      this.inUse.delete(browser);
      console.log(`🔓 Navegador liberado: ${browser._id} (En uso: ${this.inUse.size}/${this.pool.length})`);
    }
  }

  async removeBrowser(browser) {
    try {
      this.inUse.delete(browser);
      const index = this.pool.indexOf(browser);
      if (index > -1) {
        this.pool.splice(index, 1);
      }
      
      if (browser && browser.connected) {
        await browser.close();
        this.stats.closed++;
      }
      
      console.log(`🗑️ Navegador removido: ${browser._id} (Pool: ${this.pool.length})`);
    } catch (error) {
      console.error(`Error removiendo navegador ${browser._id}:`, error.message);
    }
  }

  startHealthCheck() {
    this.healthCheckInterval = setInterval(async () => {
      console.log(`🏥 Health check - Pool: ${this.pool.length}, En uso: ${this.inUse.size}, Creando: ${this.creating.size}`);
      console.log(`📊 Stats: Created(${this.stats.created}) Failed(${this.stats.failed}) Closed(${this.stats.closed})`);
      
      const browsersToRemove = [];

      for (const browser of this.pool) {
        if (!browser.connected) {
          console.log(`💀 Navegador desconectado detectado: ${browser._id}`);
          browsersToRemove.push(browser);
        } else if (!this.isBrowserHealthy(browser) && !this.inUse.has(browser)) {
          console.log(`♻️ Reciclando navegador viejo: ${browser._id}`);
          browsersToRemove.push(browser);
          this.stats.recycled++;
        }
      }

      for (const browser of browsersToRemove) {
        await this.removeBrowser(browser);
      }
      
      // Mantener al menos un navegador si no hay ninguno
      if (this.pool.length === 0 && this.inUse.size === 0 && this.creating.size === 0) {
        console.log('🔄 Pool vacío, intentando crear navegador de respaldo...');
        try {
          const browser = await this.createBrowser();
          this.pool.push(browser);
          console.log(`✅ Navegador de respaldo creado: ${browser._id}`);
        } catch (error) {
          console.error('❌ Error creando navegador de respaldo:', error.message);
        }
      }
    }, SERVERLESS_CONFIG.healthCheckInterval);
  }

  async closeAll() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    console.log(`🔥 Cerrando todos los navegadores (${this.pool.length})...`);
    
    const closePromises = this.pool.map(async (browser) => {
      if (browser && browser.connected) {
        try {
          await browser.close();
          this.stats.closed++;
        } catch (error) {
          console.error(`Error cerrando navegador ${browser._id}:`, error.message);
        }
      }
    });
    
    await Promise.all(closePromises);
    this.pool = [];
    this.inUse.clear();
    this.creating.clear();
    console.log('✅ Todos los navegadores cerrados');
  }

  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats() {
    return {
      poolSize: this.pool.length,
      maxSize: this.maxSize,
      inUse: this.inUse.size,
      creating: this.creating.size,
      available: this.pool.length - this.inUse.size,
      connected: this.pool.filter(b => b && b.connected).length,
      stats: { ...this.stats },
      healthy: this.pool.filter(b => this.isBrowserHealthy(b)).length
    };
  }
}

// Crear instancia global del pool
const browserPool = new RobustBrowserPool();

// Inicializar el pool al arrancar
browserPool.init();

// Cleanup al cerrar la aplicación
process.on("exit", async () => {
  await browserPool.closeAll();
});
process.on("SIGINT", async () => {
  console.log('\n🛑 Recibida señal SIGINT, cerrando...');
  await browserPool.closeAll();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  console.log('\n🛑 Recibida señal SIGTERM, cerrando...');
  await browserPool.closeAll();
  process.exit(0);
});

// ======================
// Helpers
// ======================

async function setupPage(browser) {
  let context = null;
  let page = null;
  
  try {
    console.log(`🔧 Configurando página para navegador: ${browser._id}`);
    
    context = await Promise.race([
      browser.createBrowserContext(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Context creation timeout')), 10000)
      )
    ]);

    page = await Promise.race([
      context.newPage(),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Page creation timeout')), 10000)
      )
    ]);
    
    // Configurar página básica
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );
    
    // Request interception minimalista
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`✅ Página configurada exitosamente`);
    return { context, page };
    
  } catch (error) {
    console.error('❌ Error en setupPage:', error.message);
    
    // Cleanup en caso de error
    if (page && !page.isClosed()) {
      try { await page.close(); } catch {}
    }
    if (context) {
      try { await context.close(); } catch {}
    }
    
    throw error;
  }
}

async function login(page, username, password) {
  const maxRetries = 2;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`🔐 Intento de login ${attempt}/${maxRetries}`);
      
      await page.goto("https://class.utp.edu.pe/student/calendar", {
        waitUntil: "networkidle2",
        timeout: 20000
      });

      // Check if already logged in
      const alreadyLoggedIn = await page.$('.text-body.font-bold');
      if (alreadyLoggedIn) {
        console.log('✅ Ya logueado');
        return;
      }

      await page.waitForSelector("#username", { timeout: 10000 });
      await page.type("#username", username);
      await page.type("#password", password);
      
      await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }),
        page.click("#kc-login")
      ]);

      // Verify login success
      const loginError = await page.$('.alert-error, .error-message, .invalid-credentials');
      if (loginError) {
        throw new Error('Credenciales inválidas');
      }

      console.log('✅ Login exitoso');
      return;

    } catch (error) {
      console.error(`❌ Error en login attempt ${attempt}:`, error.message);
      
      if (attempt === maxRetries) {
        throw new Error(`Login failed after ${maxRetries} attempts: ${error.message}`);
      }
      
      // Wait before retry
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

async function getNombreEstudiante(page) {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await page.waitForSelector(".text-body.font-bold", { timeout: 8000 });
      return await page.$eval(".text-body.font-bold", (el) => el.innerText.trim());
    } catch (error) {
      console.log(`⚠️ Retry getNombreEstudiante ${i + 1}/${maxRetries}`);
      if (i === maxRetries - 1) throw error;
      await page.waitForTimeout(1000);
    }
  }
}

async function getSemanaInfo(page) {
  return page.evaluate(() => {
    const findTextBySelectors = (selectors) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) return element.innerText.trim();
      }
      return null;
    };

    return {
      ciclo: findTextBySelectors([
        '[data-testid="ciclo"]', '.ciclo-info', 'p:contains("Ciclo")', '.semester-info'
      ]),
      semanaActual: findTextBySelectors([
        '[data-testid="semana"]', '.week-info', 'p:contains("Semana")', '.current-week'
      ]),
      fechas: findTextBySelectors([
        '[data-testid="fechas"]', '.date-range', '.week-dates', 'p:contains("/")'
      ]),
    };
  });
}

async function getEventos(page) {
  return page.evaluate(() => {
    const eventos = [];
    const eventSelectors = ['.event-card', '.calendar-event', '.schedule-item', '[data-event]', '.day-event'];

    let eventElements = [];
    for (const selector of eventSelectors) {
      eventElements = document.querySelectorAll(selector);
      if (eventElements.length > 0) break;
    }

    eventElements.forEach((el) => {
      const titulo = 
        el.querySelector('.event-title, .title, .event-name, h3, h4, .subject')?.innerText.trim() ||
        el.textContent.split('\n')[0]?.trim() ||
        "Sin título";

      const hora = 
        el.querySelector('.event-time, .time, .hour, .schedule-time')?.innerText.trim() ||
        el.textContent.match(/\d{1,2}:\d{2}(?:\s*(?:AM|PM))?/i)?.[0] ||
        "";

      const dia = 
        el.closest('.day-column, .day-container, [data-day]')
          ?.querySelector('.day-label, .day-name, .date, h2, h3')?.innerText.trim() ||
        "";

      eventos.push({ titulo, hora, dia });
    });

    return eventos;
  });
}

// ======================
// Scraper principal
// ======================
async function scrapearEventosUTP(username, password, onStep = () => {}) {
  let browser = null;
  let context = null;
  let page = null;
  const startTime = Date.now();

  try {
    onStep("estado", { mensaje: "Obteniendo navegador..." });
    browser = await browserPool.getBrowser();

    onStep("estado", { mensaje: "Configurando página..." });
    ({ context, page } = await setupPage(browser));

    onStep("estado", { mensaje: "Iniciando login..." });
    await login(page, username, password);

    onStep("estado", { mensaje: "Obteniendo nombre..." });
    const nombreEstudiante = await getNombreEstudiante(page);
    onStep("nombre", { nombreEstudiante });

    onStep("estado", { mensaje: "Obteniendo info de semana..." });
    const semanaInfo = await getSemanaInfo(page);
    onStep("semana", { semanaInfo });

    onStep("estado", { mensaje: "Extrayendo eventos..." });
    const eventos = await getEventos(page);
    onStep("eventos", { eventos });

    const duration = Date.now() - startTime;
    console.log(`✅ Scraping completado en ${duration}ms`);
    
    return { nombreEstudiante, semanaInfo, eventos };

  } catch (error) {
    const duration = Date.now() - startTime;
    console.error(`❌ Error en scraping (${duration}ms):`, error.message);
    
    // Si el navegador se desconectó, removerlo del pool
    if (browser && !browser.connected) {
      console.log('🗑️ Removiendo navegador desconectado del pool');
      await browserPool.removeBrowser(browser);
      browser = null; // Para evitar liberarlo después
    }
    
    throw error;
  } finally {
    // Cleanup de página y contexto
    try {
      if (page && !page.isClosed()) await page.close();
      if (context) await context.close();
    } catch (cleanupError) {
      console.error('⚠️ Error en cleanup:', cleanupError.message);
    }

    // Liberar navegador de vuelta al pool
    if (browser) {
      browserPool.releaseBrowser(browser);
    }
  }
}

// ======================
// Rate Limiting & Validation
// ======================
const requestCounts = new Map();
const RATE_LIMIT = 10;
const RATE_WINDOW = 60 * 60 * 1000;

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!requestCounts.has(ip)) {
    requestCounts.set(ip, { count: 1, resetTime: now + RATE_WINDOW });
    return next();
  }
  
  const userRequests = requestCounts.get(ip);
  
  if (now > userRequests.resetTime) {
    userRequests.count = 1;
    userRequests.resetTime = now + RATE_WINDOW;
    return next();
  }
  
  if (userRequests.count >= RATE_LIMIT) {
    return res.status(429).json({ 
      error: "Demasiadas solicitudes. Intenta más tarde.",
      resetTime: userRequests.resetTime
    });
  }
  
  userRequests.count++;
  next();
}

function validateCredentials(req, res, next) {
  const { username, password } = req.method === 'GET' ? req.query : req.body;
  
  if (!username || !password) {
    return res.status(400).json({ 
      error: "Se requieren username y password" 
    });
  }
  
  if (username.length < 3 || password.length < 3) {
    return res.status(400).json({ 
      error: "Credenciales inválidas" 
    });
  }
  
  next();
}

// ======================
// Rutas
// ======================

app.post("/api/eventos", rateLimit, validateCredentials, async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const data = await scrapearEventosUTP(username, password);
    res.json(data);
  } catch (error) {
    console.error("Error en /api/eventos:", error);
    
    if (error.message.includes('Credenciales') || error.message.includes('Login')) {
      res.status(401).json({ error: error.message });
    } else if (error.message.includes('timeout') || error.message.includes('Timeout')) {
      res.status(408).json({ error: "Servicio temporalmente no disponible" });
    } else {
      res.status(500).json({ error: "Error interno del servidor" });
    }
  }
});

app.get("/api/eventos-stream", rateLimit, validateCredentials, async (req, res) => {
  const { username, password } = req.query;

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const send = (event, data) => {
    if (!res.destroyed) {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    }
  };

  try {
    const data = await scrapearEventosUTP(username, password, send);
    send("fin", data);
  } catch (error) {
    console.error("Error en SSE:", error);
    send("error", { error: error.message });
  } finally {
    if (!res.destroyed) {
      res.end();
    }
  }
});

app.get("/api/pool-stats", (req, res) => {
  res.json(browserPool.getStats());
});

app.get("/health", (req, res) => {
  const stats = browserPool.getStats();
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    browserPool: stats,
    config: SERVERLESS_CONFIG
  });
});

// Cleanup periódico
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of requestCounts) {
    if (now > data.resetTime) {
      requestCounts.delete(ip);
    }
  }
}, 5 * 60 * 1000);

// ======================
// Servidor
// ======================
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`📊 Rate limit: ${RATE_LIMIT} requests/hora por IP`);
  console.log(`🏊‍♂️ Browser pool robusto configurado (máximo: ${browserPool.maxSize})`);
});