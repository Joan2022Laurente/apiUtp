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
// Browser Singleton
// ======================
let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport,
    });
  }
  return browserInstance;
}

// Cerrar navegador al terminar proceso
process.on("exit", async () => {
  if (browserInstance) await browserInstance.close();
});
process.on("SIGINT", async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  if (browserInstance) await browserInstance.close();
  process.exit(0);
});

// ======================
// Helpers
// ======================

// Configuración inicial de página en contexto privado
async function setupPage(browser) {
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
  );
  return { context, page };
}

// Login
async function login(page, username, password) {
  await page.goto("https://class.utp.edu.pe/student/calendar", {
    waitUntil: "networkidle2",
  });
  await page.waitForSelector("#username", { timeout: 30000 });
  await page.type("#username", username);
  await page.type("#password", password);
  await page.click("#kc-login");
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 });
}

// Obtener nombre de estudiante
async function getNombreEstudiante(page) {
  await page.waitForSelector(".text-body.font-bold", { timeout: 30000 });
  return page.$eval(".text-body.font-bold", (el) => el.innerText.trim());
}

// Info de la semana (ejemplo con XPaths, ajusta según tu HTML real)
async function getSemanaInfo(page) {
  return page.evaluate(() => {
    const getTextByXPath = (xpath) =>
      document
        .evaluate(
          xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        )
        .singleNodeValue?.innerText.trim() || null;
    return {
      ciclo: getTextByXPath("/html/body/div/.../p"), // ⚠️ Ajusta los XPaths
      semanaActual: getTextByXPath("/html/body/div/.../p[1]"),
      fechas: getTextByXPath("/html/body/div/.../p[2]"),
    };
  });
}

// Eventos (ejemplo simplificado)
async function getEventos(page) {
  return page.evaluate(() => {
    const eventos = [];
    const items = document.querySelectorAll(".event-card");
    items.forEach((el) => {
      const titulo =
        el.querySelector(".event-title")?.innerText.trim() || "Sin título";
      const hora = el.querySelector(".event-time")?.innerText.trim() || "";
      const dia =
        el
          .closest(".day-column")
          ?.querySelector(".day-label")
          ?.innerText.trim() || "";
      eventos.push({ titulo, hora, dia });
    });
    return eventos;
  });
}

// ======================
// Scraper principal
// ======================
async function scrapearEventosUTP(username, password, onStep = () => {}) {
  const browser = await getBrowser();
  const { context, page } = await setupPage(browser);

  try {
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
  } finally {
    await page.close();
    await context.close();
  }
}

// ======================
// Rutas
// ======================

// Ruta normal (retorna JSON)
app.post("/api/eventos", async (req, res) => {
  const { username, password } = req.body;
  try {
    const data = await scrapearEventosUTP(username, password);
    res.json(data);
  } catch (error) {
    console.error("Error en /api/eventos:", error);
    res.status(500).json({ error: "Error al obtener eventos" });
  }
});

// Ruta con SSE (stream de progreso)
app.get("/api/eventos-stream", async (req, res) => {
  const { username, password } = req.query;

  if (!username || !password) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "Faltan credenciales" }));
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const data = await scrapearEventosUTP(username, password, send);
    send("fin", data);
    res.end();
  } catch (error) {
    console.error("Error en SSE:", error);
    send("error", { error: error.message });
    res.end();
  }
});

// ======================
// Servidor
// ======================
app.listen(PORT, () => {
  console.log(`Servidor escuchando en puerto ${PORT}`);
});
