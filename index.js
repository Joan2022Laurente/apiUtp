import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

// =============================
// 🔹 Navegador global (singleton)
// =============================
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
    console.log("✅ Navegador lanzado");
  }
  return browser;
}

// Middleware
app.use(
  cors({
    origin: ["http://127.0.0.1:5500", "https://utpschedule.vercel.app"],
  })
);
app.use(express.json());

// =============================
// 🔹 Ruta POST clásica
// =============================
app.post("/api/eventos", async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      error: "Se requieren usuario y contraseña.",
    });
  }

  try {
    const { nombreEstudiante, semanaInfo, eventos } = await scrapearEventosUTP(
      username,
      password
    );
    res.json({
      success: true,
      nombreEstudiante,
      semanaInfo,
      eventos,
    });
  } catch (error) {
    console.error("Error al scrapear eventos:", error);
    res.status(500).json({
      success: false,
      error:
        "Error al obtener eventos. Verifica tus credenciales o intenta más tarde.",
    });
  }
});

// =============================
// 🔹 SCRAPER usando navegador global
// =============================
async function scrapearEventosUTP(username, password) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    // Ir directamente al calendario
    await page.goto("https://class.utp.edu.pe/student/calendar", {
      waitUntil: "networkidle2",
    });

    await page.waitForSelector("#username", { timeout: 30000 });

    // Login
    await page.type("#username", username);
    await page.type("#password", password);
    await page.click("#kc-login");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 });

    // Nombre del estudiante
    await page.waitForSelector(".text-body.font-bold", { timeout: 30000 });
    const nombreEstudiante = await page.evaluate(() => {
      const nombre = document.querySelector(".text-body.font-bold");
      return nombre ? nombre.innerText.trim() : null;
    });

    // Esperar calendario
    await page.waitForSelector(".fc-timegrid-event-harness", {
      timeout: 60000,
    });

    // Vista semanal
    await page.evaluate(() => {
      const weekButton = document.querySelector(
        ".fc-timeGridWeek-button, .fc-week-button"
      );
      if (weekButton) weekButton.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Extraer info semana
    const semanaInfo = await page.evaluate(() => {
      const cicloXPath =
        "/html/body/div[1]/div[2]/div[2]/div[2]/div/div/div/div/div[1]/div[1]/div[1]/p";
      const semanaActualXPath =
        "/html/body/div[1]/div[2]/div[2]/div[2]/div/div/div/div/div[1]/div[1]/div[2]/p[1]";
      const fechasXPath =
        "/html/body/div[1]/div[2]/div[2]/div[2]/div/div/div/div/div[1]/div[1]/div[2]/p[2]";

      const getTextByXPath = (xpath) => {
        const element = document.evaluate(
          xpath,
          document,
          null,
          XPathResult.FIRST_ORDERED_NODE_TYPE,
          null
        ).singleNodeValue;
        return element ? element.innerText.trim() : null;
      };

      return {
        ciclo: getTextByXPath(cicloXPath),
        semanaActual: getTextByXPath(semanaActualXPath),
        fechas: getTextByXPath(fechasXPath),
      };
    });

    // Extraer eventos
    const eventos = await page.evaluate(() => {
      const lista = [];
      document
        .querySelectorAll(".fc-timegrid-event-harness")
        .forEach((harnes) => {
          const event = harnes.querySelector(".fc-timegrid-event");
          if (!event) return;

          const isActivity =
            event.querySelector(
              '[data-testid="single-day-activity-card-container"]'
            ) !== null;
          const isClass =
            event.querySelector(
              '[data-testid="single-day-event-card-container"]'
            ) !== null;

          // Día y fecha
          const dayCell = harnes.closest(".fc-timegrid-col");
          const dayDate = dayCell?.getAttribute("data-date");

          let dayName = null;
          if (dayDate) {
            const headerCell = document.querySelector(
              `th.fc-col-header-cell[data-date="${dayDate}"]`
            );
            if (headerCell) {
              const dayText = headerCell
                .querySelector(".fc-col-header-cell-cushion div")
                ?.innerText.trim();
              dayName = dayText ? dayText.replace(/\s+/g, " ").trim() : null;
            }
          }

          if (isActivity) {
            lista.push({
              tipo: "Actividad",
              curso: event
                .querySelector('[data-testid="course-name-text"]')
                ?.innerText.trim(),
              hora: event
                .querySelector(".mt-xsm.text-neutral-03.text-small-02")
                ?.innerText.trim(),
              dia: dayName,
              fecha: dayDate,
            });
          } else if (isClass) {
            lista.push({
              tipo: "Clase",
              curso: event
                .querySelector('[data-testid="course-name-text"]')
                ?.innerText.trim(),
              hora: event
                .querySelector(".mt-sm.text-neutral-04.text-small-02")
                ?.innerText.trim(),
              modalidad: event
                .querySelector("span.font-bold.text-body.rounded-lg")
                ?.innerText.trim(),
              dia: dayName,
              fecha: dayDate,
            });
          }
        });
      return lista;
    });

    return { nombreEstudiante, semanaInfo, eventos };
  } finally {
    await page.close(); // 👈 cerramos solo la página, no el navegador
  }
}

// =============================
// 🔹 SSE usando navegador global
// =============================
app.get("/api/eventos-stream", async (req, res) => {
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

  // Headers para SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  let page;
  try {
    const browser = await getBrowser();
    page = await browser.newPage();

    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    );

    send("estado", { mensaje: "Abriendo calendario..." });
    await page.goto("https://class.utp.edu.pe/student/calendar", {
      waitUntil: "networkidle2",
    });

    await page.waitForSelector("#username", { timeout: 30000 });
    send("estado", { mensaje: "Iniciando sesión..." });
    await page.type("#username", username);
    await page.type("#password", password);
    await page.click("#kc-login");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 });

    send("estado", { mensaje: "Obteniendo datos..." });
    const nombreEstudiante = await page.evaluate(() => {
      const nombre = document.querySelector(".text-body.font-bold");
      return nombre ? nombre.innerText.trim() : null;
    });
    send("nombre", { nombreEstudiante });

    const semanaInfo = await page.evaluate(() => {
      const ciclo = document.querySelector("p")?.innerText || null;
      return { ciclo };
    });
    send("semana", { semanaInfo });

    const eventos = await page.evaluate(() => {
      const lista = [];
      document
        .querySelectorAll(".fc-timegrid-event-harness")
        .forEach((harnes) => {
          const event = harnes.querySelector(".fc-timegrid-event");
          if (event) {
            lista.push({ detalle: event.innerText.trim() });
          }
        });
      return lista;
    });
    send("eventos", { eventos });

    send("fin", { mensaje: "Scraping finalizado ✅" });
    res.end();
  } catch (error) {
    console.error("Error en SSE:", error);
    send("error", { mensaje: error.message });
    res.end();
  } finally {
    if (page) await page.close(); // 👈 cerramos solo la página
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor API escuchando en el puerto ${PORT}`);
});
