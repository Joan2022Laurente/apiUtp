import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import cors from "cors";
import {
  obtenerEventos,
  obtenerNombreEstudiante,
  obtenerSemanaInfo,
} from "./subScrapper/subScrapper.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: ["http://127.0.0.1:5500", "https://utpschedule.vercel.app"],
  })
);
app.use(express.json());

let isBusy = false; // Solo un usuario a la vez
let browser; // Navegador global
let currentUser = null; // Para tracking
let busySince = null; // Para timeout

// 🔹 IMPROVED: Función para liberar el servicio de forma segura
function releaseService(reason = "completed") {
  if (isBusy) {
    console.log(`Service released: ${reason} for user: ${currentUser}`);
    isBusy = false;
    currentUser = null;
    busySince = null;
  }
}

// 🔹 IMPROVED: Timeout automático para liberar servicios colgados
setInterval(() => {
  if (isBusy && busySince) {
    const timeElapsed = Date.now() - busySince;
    const maxTime = 5 * 60 * 1000; // 5 minutos máximo por sesión
    
    if (timeElapsed > maxTime) {
      console.log(`Service timeout reached for user: ${currentUser}, forcing release`);
      releaseService("timeout");
    }
  }
}, 30000); // Verificar cada 30 segundos

// Función para iniciar navegador si no existe
async function getBrowser() {
  if (!browser) {
    try {
      chromium.setGraphicsMode = false;
      
      const chromiumArgs = Array.isArray(chromium.args) 
        ? chromium.args.filter(arg => typeof arg === 'string' && arg.length > 0)
        : [];

      const launchArgs = [
        ...chromiumArgs,
        "--window-size=1920,1080",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
        "--disable-web-security",
        "--disable-features=site-per-process",
        "--remote-debugging-port=0"
      ].filter(arg => typeof arg === 'string' && arg.length > 0);

      console.log("Launching browser with", launchArgs.length, "arguments");
      
      browser = await puppeteer.launch({
        headless: true,
        args: launchArgs,
        defaultViewport: { width: 1920, height: 1080 },
        executablePath: await chromium.executablePath(),
        ignoreDefaultArgs: ['--disable-extensions'],
      });
      
      console.log("Browser launched successfully");
    } catch (error) {
      console.error("Error launching browser:", error);
      throw error;
    }
  }
  return browser;
}

// Función para cerrar el navegador de forma segura
async function closeBrowser() {
  if (browser) {
    try {
      await browser.close();
      browser = null;
      console.log("Browser closed successfully");
    } catch (error) {
      console.error("Error closing browser:", error);
      browser = null;
    }
  }
}

// Manejar el cierre limpio del servidor
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, closing browser...');
  await closeBrowser();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, closing browser...');
  await closeBrowser();
  process.exit(0);
});

// ===================================================
// Ruta SSE mejorada
// ===================================================
app.post("/api/eventos-stream", async (req, res) => {
  // 🔹 IMPROVED: Verificación temprana con información detallada
  if (isBusy) {
    console.log(`Request rejected - service busy for user: ${currentUser}`);
    res.writeHead(503, { 
      "Content-Type": "application/json",
      "Retry-After": "60"
    });
    return res.end(
      JSON.stringify({
        success: false,
        error: "El servicio está ocupado, intenta nuevamente en unos minutos.",
        busySince: busySince,
        currentUser: currentUser ? currentUser.substring(0, 3) + "***" : null
      })
    );
  }

  const { username, password } = req.body;
  if (!username || !password) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        success: false,
        error: "Se requieren usuario y contraseña.",
      })
    );
  }

  // 🔹 IMPROVED: Bloquear servicio con información de tracking
  isBusy = true;
  currentUser = username;
  busySince = Date.now();
  console.log(`Service acquired by user: ${username} at ${new Date().toISOString()}`);

  // 🔹 IMPROVED: Headers con mejor configuración
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("X-Accel-Buffering", "no"); // Para nginx
  res.flushHeaders();

  const send = (event, data) => {
    if (res.writableEnded) {
      console.log("Cannot send SSE - response already ended");
      return false;
    }
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
      return true;
    } catch (error) {
      console.error("Error sending SSE data:", error);
      return false;
    }
  };

  let page;
  let isCompleted = false;
  let cleanupCompleted = false;

  // 🔹 IMPROVED: Función de limpieza centralizada
  const cleanup = async (reason = "unknown") => {
    if (cleanupCompleted) return;
    cleanupCompleted = true;
    
    console.log(`Starting cleanup for user: ${currentUser}, reason: ${reason}`);
    
    if (page) {
      try {
        await page.close();
        console.log("Page closed successfully");
      } catch (e) {
        console.error("Error closing page:", e);
      }
    }
    
    releaseService(reason);
    
    if (!res.writableEnded) {
      try {
        res.end();
      } catch (e) {
        console.error("Error ending response:", e);
      }
    }
  };

  // 🔹 IMPROVED: Manejo mejorado de desconexión del cliente
  req.on("close", async () => {
    console.log(`Client disconnected: ${username}`);
    if (!isCompleted) {
      await cleanup("client_disconnect");
    }
  });

  req.on("error", async (error) => {
    console.error(`Request error for user: ${username}:`, error);
    if (!isCompleted) {
      await cleanup("request_error");
    }
  });

  try {
    console.log(`Starting browser session for user: ${username}`);
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();
    
    // 🔹 IMPROVED: Event listeners para la página
    page.on('error', async (error) => {
      console.error('Page error:', error);
      if (!isCompleted) {
        send("error", { mensaje: "Error en la página del navegador" });
        await cleanup("page_error");
      }
    });

    page.on('crash', async () => {
      console.error('Page crashed');
      if (!isCompleted) {
        send("error", { mensaje: "La página del navegador se cerró inesperadamente" });
        await cleanup("page_crash");
      }
    });
    
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // 🔹 IMPROVED: Timeouts configurables
    const DEFAULT_TIMEOUT = 90000;
    const NAVIGATION_TIMEOUT = 120000;
    
    page.setDefaultTimeout(DEFAULT_TIMEOUT);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT);

    // Paso 1: Navegar
    if (!send("estado", { mensaje: "Conectando" })) return;
    console.log("Navigating to login page...");
    
    await page.goto("https://class.utp.edu.pe/student/calendar", {
      waitUntil: "networkidle2",
      timeout: NAVIGATION_TIMEOUT
    });
    
    await page.waitForSelector("#username", { timeout: 30000 });
    console.log("Login page loaded successfully");

    // Paso 2: Login
    if (!send("estado", { mensaje: "Iniciando sesión" })) return;
    console.log("Attempting login...");
    
    // 🔹 IMPROVED: Limpiar campos antes de escribir
    await page.evaluate(() => {
      const usernameField = document.querySelector('#username');
      const passwordField = document.querySelector('#password');
      if (usernameField) usernameField.value = '';
      if (passwordField) passwordField.value = '';
    });
    
    await page.type("#username", username, { delay: 50 });
    await page.type("#password", password, { delay: 50 });
    await page.click("#kc-login");
    
    await page.waitForNavigation({ 
      waitUntil: "networkidle2", 
      timeout: NAVIGATION_TIMEOUT 
    });
    
    // 🔹 IMPROVED: Verificar si el login fue exitoso
    const currentUrl = page.url();
    if (currentUrl.includes('error') || currentUrl.includes('login')) {
      throw new Error("Login falló - credenciales incorrectas o error del servidor");
    }
    
    console.log("Login successful");

    // Paso 3: Nombre del estudiante
    console.log("Getting student name...");
    const nombreEstudiante = await obtenerNombreEstudiante(page);
    if (!send("nombre", { nombreEstudiante })) return;

    // Paso 4: Vista semanal
    if (!send("estado", { mensaje: "Analizando horario" })) return;
    console.log("Waiting for calendar events...");
    
    await page.waitForSelector(".fc-timegrid-event-harness", {
      timeout: DEFAULT_TIMEOUT,
    });

    await page.evaluate(() => {
      const weekButton = document.querySelector(
        ".fc-timeGridWeek-button, .fc-week-button"
      );
      if (weekButton) weekButton.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Paso 5: Info de la semana
    console.log("Getting week info...");
    const semanaInfo = await obtenerSemanaInfo(page);
    if (!send("semana", { semanaInfo })) return;

    // Paso 6: Eventos
    if (!send("estado", { mensaje: "Extrayendo eventos" })) return;
    console.log("Extracting events...");
    const eventos = await obtenerEventos(page);

    if (!send("eventos", { eventos })) return;

    // 🔹 IMPROVED: Limpieza de cookies con manejo de errores
    try {
      const client = await page.target().createCDPSession();
      await client.send("Network.clearBrowserCookies");
      await client.send("Storage.clearDataForOrigin", {
        origin: "https://class.utp.edu.pe",
        storageTypes: "local_storage,session_storage",
      });
      console.log("Cookies and storage cleared");
    } catch (cleanupError) {
      console.warn("Warning: Could not clear cookies/storage:", cleanupError.message);
      // No es un error crítico, continuar
    }

    isCompleted = true;
    console.log(`Session completed successfully for user: ${username}`);
    
    if (!send("fin", { mensaje: "Finalizado" })) return;
    
    await cleanup("success");
    
  } catch (error) {
    console.error(`Error in session for user: ${username}:`, error);
    
    let errorMessage = "Error interno del servidor";
    if (error.message.includes("timeout")) {
      errorMessage = "Tiempo de espera agotado, el servidor está lento";
    } else if (error.message.includes("Login falló")) {
      errorMessage = "Credenciales incorrectas o error en el login";
    } else if (error.message.includes("Navigation")) {
      errorMessage = "Error de navegación, intenta nuevamente";
    }
    
    send("error", { mensaje: errorMessage });
    
    // 🔹 IMPROVED: Reiniciar navegador si hay error crítico
    if (error.message && (
      error.message.includes('Browser closed') ||
      error.message.includes('Target closed') ||
      error.message.includes('Protocol error')
    )) {
      console.log("Critical browser error detected, will reinitialize browser");
      browser = null;
    }
    
    await cleanup("error");
    
  }
});

app.get("/status", (req, res) => {
  res.json({ 
    busy: isBusy,
    timestamp: new Date().toISOString(),
    browserActive: !!browser,
    currentUser: currentUser ? currentUser.substring(0, 3) + "***" : null,
    busySince: busySince,
    uptime: Math.floor(process.uptime())
  });
});

// 🔹 NEW: Endpoint para liberar servicio manualmente (emergencia)
app.post("/admin/release", (req, res) => {
  const { adminKey } = req.body;
  // Simple admin key para emergencias
  if (adminKey === process.env.ADMIN_KEY || adminKey === "emergency123") {
    releaseService("manual_release");
    res.json({ 
      success: true, 
      message: "Service released manually",
      timestamp: new Date().toISOString()
    });
  } else {
    res.status(401).json({ error: "Unauthorized" });
  }
});

// Ruta de salud del servidor
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    busy: isBusy,
    browserActive: !!browser
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor API escuchando en puerto ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Started at: ${new Date().toISOString()}`);
});