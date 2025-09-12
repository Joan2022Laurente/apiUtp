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
// Browser Pool
// ======================

class BrowserPool {
  constructor(maxSize = 3) {
    this.pool = [];
    this.maxSize = maxSize;
    this.inUse = new Set();
    this.waitingQueue = [];
    this.healthCheckInterval = null;
    
    // Iniciar health check
    this.startHealthCheck();
  }

  async init() {
    console.log(`🔧 Inicializando pool de navegadores (máximo: ${this.maxSize})`);
    // Pre-crear un navegador para faster first response
    try {
      const browser = await this.createBrowser();
      this.pool.push(browser);
      console.log(`✅ Navegador inicial creado. Pool size: ${this.pool.length}`);
    } catch (error) {
      console.error("❌ Error creando navegador inicial:", error);
    }
  }

  async createBrowser() {
    const args = [
      ...chromium.args,
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-web-security',
      '--disable-features=TranslateUI',
      '--disable-ipc-flooding-protection',
      '--disable-hang-monitor',
      '--disable-client-side-phishing-detection',
      '--disable-popup-blocking',
      '--disable-prompt-on-repost',
      '--disable-sync',
      '--metrics-recording-only',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--enable-automation',
      '--password-store=basic',
      '--use-mock-keychain',
      '--memory-pressure-off'
    ];

    const browser = await puppeteer.launch({
      args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport,
      timeout: 30000,
      ignoreDefaultArgs: ['--disable-extensions'],
    });

    // Marcar timestamp de creación
    browser._createdAt = Date.now();
    return browser;
  }

  async getBrowser(timeout = 30000) {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeout) {
      // 1. Buscar navegador disponible en el pool
      const availableBrowser = this.pool.find(browser => 
        !this.inUse.has(browser) && browser.connected
      );

      if (availableBrowser) {
        this.inUse.add(availableBrowser);
        console.log(`🔄 Navegador reutilizado. En uso: ${this.inUse.size}/${this.pool.length}`);
        return availableBrowser;
      }

      // 2. Si no hay disponibles, crear uno nuevo si no se alcanzó el límite
      if (this.pool.length < this.maxSize) {
        try {
          const newBrowser = await this.createBrowser();
          this.pool.push(newBrowser);
          this.inUse.add(newBrowser);
          console.log(`➕ Nuevo navegador creado. Pool size: ${this.pool.length}, En uso: ${this.inUse.size}`);
          return newBrowser;
        } catch (error) {
          console.error("❌ Error creando navegador:", error);
        }
      }

      // 3. Si estamos en el límite, esperar a que se libere uno
      console.log(`⏳ Pool lleno (${this.pool.length}/${this.maxSize}), esperando...`);
      await this.waitForAvailable(1000);
    }

    throw new Error('Timeout esperando navegador disponible');
  }

  async waitForAvailable(checkInterval = 500) {
    return new Promise(resolve => {
      const check = () => {
        const available = this.pool.find(browser => 
          !this.inUse.has(browser) && browser.connected
        );
        
        if (available || this.pool.length < this.maxSize) {
          resolve();
        } else {
          setTimeout(check, checkInterval);
        }
      };
      check();
    });
  }

  releaseBrowser(browser) {
    if (this.inUse.has(browser)) {
      this.inUse.delete(browser);
      console.log(`🔓 Navegador liberado. En uso: ${this.inUse.size}/${this.pool.length}`);
    }
  }

  async removeBrowser(browser) {
    try {
      this.inUse.delete(browser);
      const index = this.pool.indexOf(browser);
      if (index > -1) {
        this.pool.splice(index, 1);
      }
      
      if (browser.connected) {
        await browser.close();
      }
      console.log(`🗑️ Navegador removido del pool. Pool size: ${this.pool.length}`);
    } catch (error) {
      console.error("Error removiendo navegador:", error);
    }
  }

  startHealthCheck() {
    this.healthCheckInterval = setInterval(async () => {
      console.log(`🏥 Health check - Pool: ${this.pool.length}, En uso: ${this.inUse.size}`);
      
      const now = Date.now();
      const maxAge = 10 * 60 * 1000; // 10 minutos
      const browsersToRemove = [];

      for (const browser of this.pool) {
        // Remover navegadores desconectados
        if (!browser.connected) {
          browsersToRemove.push(browser);
          continue;
        }

        // Remover navegadores muy viejos que no están en uso
        if (!this.inUse.has(browser) && (now - browser._createdAt) > maxAge) {
          browsersToRemove.push(browser);
          continue;
        }
      }

      // Remover navegadores problemáticos
      for (const browser of browsersToRemove) {
        await this.removeBrowser(browser);
      }

      // Mantener al menos un navegador disponible
      if (this.pool.length === 0 && this.inUse.size === 0) {
        try {
          const browser = await this.createBrowser();
          this.pool.push(browser);
          console.log("🔄 Navegador de respaldo creado");
        } catch (error) {
          console.error("Error creando navegador de respaldo:", error);
        }
      }
    }, 2 * 60 * 1000); // Cada 2 minutos
  }

  async closeAll() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }

    console.log("🔥 Cerrando todos los navegadores...");
    const closePromises = this.pool.map(browser => {
      return browser.connected ? browser.close().catch(console.error) : Promise.resolve();
    });
    
    await Promise.all(closePromises);
    this.pool = [];
    this.inUse.clear();
    console.log("✅ Todos los navegadores cerrados");
  }

  getStats() {
    return {
      poolSize: this.pool.length,
      maxSize: this.maxSize,
      inUse: this.inUse.size,
      available: this.pool.length - this.inUse.size,
      connected: this.pool.filter(b => b.connected).length
    };
  }
}

// Crear instancia global del pool
const browserPool = new BrowserPool(process.env.BROWSER_POOL_SIZE || 3);

// Inicializar el pool al arrancar
browserPool.init();

// Cleanup al cerrar la aplicación
process.on("exit", async () => {
  await browserPool.closeAll();
});
process.on("SIGINT", async () => {
  await browserPool.closeAll();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await browserPool.closeAll();
  process.exit(0);
});

// ======================
// Helpers
// ======================

async function setupPage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  
  // Configurar página para mejor rendimiento
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );
  
  // Deshabilitar recursos pesados
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  return { context, page };
}

async function login(page, username, password) {
  try {
    await page.goto("https://class.utp.edu.pe/student/calendar", {
      waitUntil: "networkidle2",
      timeout: 30000
    });

    // Verificar si ya estamos logueados
    const alreadyLoggedIn = await page.$('.text-body.font-bold');
    if (alreadyLoggedIn) {
      return; // Ya logueado
    }

    await page.waitForSelector("#username", { timeout: 15000 });
    await page.type("#username", username);
    await page.type("#password", password);
    
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 }),
      page.click("#kc-login")
    ]);

    // Verificar si el login fue exitoso
    const loginError = await page.$('.alert-error, .error-message, .invalid-credentials');
    if (loginError) {
      throw new Error('Credenciales inválidas');
    }

  } catch (error) {
    throw new Error(`Error en login: ${error.message}`);
  }
}

async function getNombreEstudiante(page) {
  const maxRetries = 3;
  for (let i = 0; i < maxRetries; i++) {
    try {
      await page.waitForSelector(".text-body.font-bold", { timeout: 10000 });
      return await page.$eval(".text-body.font-bold", (el) => el.innerText.trim());
    } catch (error) {
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

    const cicloSelectors = [
      '[data-testid="ciclo"]',
      '.ciclo-info',
      'p:contains("Ciclo")',
      'span:contains("Ciclo")',
      '.semester-info'
    ];

    const semanaSelectors = [
      '[data-testid="semana"]',
      '.week-info',
      'p:contains("Semana")',
      '.current-week'
    ];

    const fechasSelectors = [
      '[data-testid="fechas"]',
      '.date-range',
      '.week-dates',
      'p:contains("/")'
    ];

    return {
      ciclo: findTextBySelectors(cicloSelectors),
      semanaActual: findTextBySelectors(semanaSelectors),
      fechas: findTextBySelectors(fechasSelectors),
    };
  });
}

async function getEventos(page) {
  return page.evaluate(() => {
    const eventos = [];
    
    const eventSelectors = [
      '.event-card',
      '.calendar-event',
      '.schedule-item',
      '[data-event]',
      '.day-event'
    ];

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

      const tipo = 
        el.querySelector('.event-type, .type, .category')?.innerText.trim() ||
        "";

      const salon = 
        el.querySelector('.room, .salon, .classroom')?.innerText.trim() ||
        "";

      eventos.push({ titulo, hora, dia, tipo, salon });
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

  try {
    onStep("estado", { mensaje: "Obteniendo navegador del pool..." });
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

    return { nombreEstudiante, semanaInfo, eventos };

  } catch (error) {
    console.error("Error en scraping:", error);
    
    // Si el navegador se desconectó, removerlo del pool
    if (browser && !browser.connected) {
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
      console.error("Error en cleanup:", cleanupError);
    }

    // Liberar navegador de vuelta al pool
    if (browser) {
      browserPool.releaseBrowser(browser);
    }
  }
}

// ======================
// Rate Limiting
// ======================
const requestCounts = new Map();
const RATE_LIMIT = 15; // Increased due to better efficiency
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
    
    if (error.message.includes('Credenciales')) {
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

// Endpoint de estadísticas del pool
app.get("/api/pool-stats", (req, res) => {
  res.json(browserPool.getStats());
});

// Health check
app.get("/health", (req, res) => {
  const stats = browserPool.getStats();
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    browserPool: stats
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
  console.log(`🏊‍♂️ Browser pool configurado (máximo: ${browserPool.maxSize})`);
});