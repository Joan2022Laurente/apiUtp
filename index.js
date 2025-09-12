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
// Browser Management
// ======================

// Crear navegador con configuración robusta para producción
async function createBrowser() {
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
    '--use-mock-keychain'
  ];

  return await puppeteer.launch({
    args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    defaultViewport: chromium.defaultViewport,
    timeout: 30000,
  });
}

// ======================
// Helpers
// ======================

// Configuración inicial de página en contexto privado
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

// Login con mejor manejo de errores
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

// Obtener nombre de estudiante con retry
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

// Info de la semana - versión más robusta
async function getSemanaInfo(page) {
  return page.evaluate(() => {
    // Función helper para buscar texto por múltiples selectores
    const findTextBySelectors = (selectors) => {
      for (const selector of selectors) {
        const element = document.querySelector(selector);
        if (element) return element.innerText.trim();
      }
      return null;
    };

    // Buscar ciclo con múltiples estrategias
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

// Eventos - versión más robusta
async function getEventos(page) {
  return page.evaluate(() => {
    const eventos = [];
    
    // Múltiples selectores para encontrar eventos
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
      // Múltiples estrategias para extraer datos
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
    onStep("estado", { mensaje: "Creando navegador..." });
    browser = await createBrowser();

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
    throw error;
  } finally {
    // Cleanup garantizado
    try {
      if (page && !page.isClosed()) await page.close();
      if (context) await context.close();
      if (browser && browser.connected) await browser.close();
    } catch (cleanupError) {
      console.error("Error en cleanup:", cleanupError);
    }
  }
}

// ======================
// Middleware de rate limiting
// ======================
const requestCounts = new Map();
const RATE_LIMIT = 10; // requests por IP por hora
const RATE_WINDOW = 60 * 60 * 1000; // 1 hora

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
      error: "Demasiadas solicitudes. Intenta más tarde." 
    });
  }
  
  userRequests.count++;
  next();
}

// ======================
// Rutas
// ======================

// Middleware de validación
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

// Ruta normal (retorna JSON)
app.post("/api/eventos", rateLimit, validateCredentials, async (req, res) => {
  const { username, password } = req.body;
  
  try {
    const data = await scrapearEventosUTP(username, password);
    res.json(data);
  } catch (error) {
    console.error("Error en /api/eventos:", error);
    
    if (error.message.includes('Credenciales')) {
      res.status(401).json({ error: error.message });
    } else if (error.message.includes('timeout')) {
      res.status(408).json({ error: "Timeout - Intenta nuevamente" });
    } else {
      res.status(500).json({ error: "Error interno del servidor" });
    }
  }
});

// Ruta con SSE (stream de progreso)
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

// Health check
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Cleanup periódico de rate limiting
setInterval(() => {
  const now = Date.now();
  for (const [ip, data] of requestCounts) {
    if (now > data.resetTime) {
      requestCounts.delete(ip);
    }
  }
}, 5 * 60 * 1000); // Cada 5 minutos

// ======================
// Servidor
// ======================
app.listen(PORT, () => {
  console.log(`🚀 Servidor escuchando en puerto ${PORT}`);
  console.log(`📊 Rate limit: ${RATE_LIMIT} requests/hora por IP`);
});