import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import cors from "cors";
import {
  obtenerEventos,
  obtenerNombreEstudiante,
  obtenerSemanaInfo,
  obtenerCursos,
  obtenerActividadesSemanales, // 👈 nuevo import
} from "./subScrapper/subScrapper.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(
  cors({
    origin: ["http://127.0.0.1:5500", "http://localhost:5173", "https://utpschedule.vercel.app"],
  })
);
app.use(express.json());

let isBusy = false;
let browser;

async function getBrowser() {
  if (!browser) {
    chromium.setGraphicsMode = false;
    browser = await puppeteer.launch({
      headless: true,
      args: [
        ...chromium.args,
        "--window-size=1920,1080",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--disable-gpu",
      ],
      defaultViewport: { width: 1920, height: 1080 },
      executablePath: await chromium.executablePath(),
    });
  }
  return browser;
}

app.get("/api/eventos-stream", async (req, res) => {
  if (isBusy) {
    res.writeHead(503, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        success: false,
        error: "El servicio está ocupado, intenta nuevamente en unos minutos.",
      })
    );
  }

  isBusy = true;

  const { username, password } = req.query;
  if (!username || !password) {
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
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let page;
  req.on("close", async () => {
    console.log("Cliente desconectado, cancelando scraping...");
    if (page)
      try {
        await page.close();
      } catch {}
    isBusy = false;
  });

  try {
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    // Paso 1: Login
    send("estado", { mensaje: "Autenticando" });
    await page.goto("https://class.utp.edu.pe/student", {
      waitUntil: "networkidle2",
    });
    await page.waitForSelector("#username", { timeout: 30000 });
    await page.type("#username", username);
    await page.type("#password", password);
    await page.click("#kc-login");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 });

    // Paso 2: Obtener nombre
    const nombreEstudiante = await obtenerNombreEstudiante(page);
    send("nombre", { nombreEstudiante });

    // ✅ Paso 3: Obtener cursos y actividades
    send("estado", { mensaje: "Extrayendo cursos" });
    const cursos = await obtenerCursos(page);
    send("cursos", { cursos });

    send("estado", { mensaje: "Extrayendo tareas y actividades" });
    const actividades = await obtenerActividadesSemanales(page);
    send("actividades", { actividades });

    // Paso 4: Ir al calendario
    send("estado", { mensaje: "Abriendo calendario" });
    await page.goto("https://class.utp.edu.pe/student/calendar", {
      waitUntil: "networkidle2",
    });
    // Paso 4: Vista semanal
    send("estado", { mensaje: "Analizando horario" });
    await page.waitForSelector(".fc-timegrid-event-harness", {
      timeout: 60000,
    });

    await page.evaluate(() => {
      const weekButton = document.querySelector(
        ".fc-timeGridWeek-button, .fc-week-button"
      );
      if (weekButton) weekButton.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Paso 5: Info de la semana
    const semanaInfo = await obtenerSemanaInfo(page);
    send("semana", { semanaInfo });

    // Paso 6: Eventos
    send("estado", { mensaje: "Extrayendo eventos" });
    const eventos = await obtenerEventos(page);

    send("eventos", { eventos });

    // 🔹 Borrar cookies y almacenamiento local para la siguiente sesión
    const client = await page.target().createCDPSession();
    await client.send("Network.clearBrowserCookies");
    await client.send("Storage.clearDataForOrigin", {
      origin: "https://class.utp.edu.pe",
      storageTypes: "local_storage,session_storage",
    });

    await page.close();
    send("fin", { mensaje: "finalizado" });
    res.end();
  } catch (error) {
    console.error("Error en SSE:", error);
    send("error", { mensaje: error.message });
    res.end();
    if (page) await page.close();
  } finally {
    isBusy = false;
  }
});

app.get("/status", (req, res) => {
  res.json({ busy: isBusy });
});

// Iniciar servidor
app.listen(PORT, () =>
  console.log(`Servidor API escuchando en puerto ${PORT}`)
);
