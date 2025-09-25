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

// Función para iniciar navegador si no existe
async function getBrowser() {
  if (!browser) {
    try {
      chromium.setGraphicsMode = false;
      
      // 🔹 FIX: Filtrar y validar los argumentos de chromium
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

      console.log("Launching browser with args:", launchArgs.length, "arguments");
      
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
// Ruta SSE con navegador persistente, cookies borradas, cache mantenida
// ===================================================
app.post("/api/eventos-stream", async (req, res) => {
  if (isBusy) {
    res.writeHead(503, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        success: false,
        error: "El servicio está ocupado, intenta nuevamente en unos minutos.",
      })
    );
  }

  isBusy = true; // Bloquear servicio

  const { username, password } = req.body;
  if (!username || !password) {
    isBusy = false; // 🔹 FIX: Liberar el servicio en caso de error
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        success: false,
        error: "Se requieren usuario y contraseña.",
      })
    );
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.flushHeaders();

  const send = (event, data) => {
    try {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (error) {
      console.error("Error sending SSE data:", error);
    }
  };

  let page;
  let isCompleted = false;

  // Cancelar scraping si el cliente se desconecta
  req.on("close", async () => {
    console.log("Cliente desconectado, cancelando scraping");
    if (page && !isCompleted) {
      try {
        await page.close();
      } catch (e) {
        console.error("Error closing page on client disconnect:", e);
      }
    }
    isBusy = false;
  });

  try {
    console.log("Starting browser session for user:", username);
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();
    
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    );

    // 🔹 FIX: Configurar timeouts más largos y manejar errores de navegación
    page.setDefaultTimeout(90000);
    page.setDefaultNavigationTimeout(90000);

    // Paso 1: Navegar
    send("estado", { mensaje: "Conectando" });
    console.log("Navigating to login page...");
    
    await page.goto("https://class.utp.edu.pe/student/calendar", {
      waitUntil: "networkidle2",
      timeout: 60000
    });
    
    await page.waitForSelector("#username", { timeout: 30000 });
    console.log("Login page loaded successfully");

    // Paso 2: Login
    send("estado", { mensaje: "Iniciando sesión" });
    console.log("Attempting login...");
    
    await page.type("#username", username, { delay: 100 });
    await page.type("#password", password, { delay: 100 });
    await page.click("#kc-login");
    
    await page.waitForNavigation({ 
      waitUntil: "networkidle2", 
      timeout: 90000 
    });
    console.log("Login successful");

    // Paso 3: Nombre del estudiante
    console.log("Getting student name...");
    const nombreEstudiante = await obtenerNombreEstudiante(page);
    send("nombre", { nombreEstudiante });

    // Paso 4: Vista semanal
    send("estado", { mensaje: "Analizando horario" });
    console.log("Waiting for calendar events...");
    
    await page.waitForSelector(".fc-timegrid-event-harness", {
      timeout: 90000,
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
    send("semana", { semanaInfo });

    // Paso 6: Eventos
    send("estado", { mensaje: "Extrayendo eventos" });
    console.log("Extracting events...");
    const eventos = await obtenerEventos(page);

    send("eventos", { eventos });

    // 🔹 Borrar cookies y almacenamiento local para la siguiente sesión
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
    }

    isCompleted = true;
    await page.close();
    console.log("Session completed successfully for user:", username);
    
    send("fin", { mensaje: "Finalizado" });
    res.end();
    
  } catch (error) {
    console.error("Error en SSE:", error);
    send("error", { mensaje: error.message || "Error interno del servidor" });
    res.end();
    
    if (page && !isCompleted) {
      try {
        await page.close();
      } catch (closeError) {
        console.error("Error closing page after error:", closeError);
      }
    }
    
    // 🔹 FIX: Si el navegador falla completamente, reiniciarlo
    if (error.message && error.message.includes('Browser closed')) {
      console.log("Browser seems to have crashed, will reinitialize on next request");
      browser = null;
    }
  } finally {
    isBusy = false;
  }
});

app.get("/status", (req, res) => {
  res.json({ 
    busy: isBusy,
    timestamp: new Date().toISOString(),
    browserActive: !!browser
  });
});

// Ruta de salud del servidor
app.get("/health", (req, res) => {
  res.json({ 
    status: "OK", 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor API escuchando en puerto ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});