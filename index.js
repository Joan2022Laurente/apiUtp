import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import cors from "cors";

// Configuración del servidor
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Ruta POST para obtener eventos
app.post("/api/eventos", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({
      success: false,
      error: "Se requieren usuario y contraseña.",
    });
  }

  try {
    const { nombreEstudiante, eventos } = await scrapearEventosUTP(username, password);
    res.json({ success: true, nombreEstudiante, eventos });
  } catch (error) {
    console.error("Error al scrapear eventos:", error);
    res.status(500).json({
      success: false,
      error: "Error al obtener eventos. Verifica tus credenciales o intenta más tarde.",
    });
  }
});

// Función para scrapear eventos (versión optimizada)
async function scrapearEventosUTP(username, password) {
  chromium.setGraphicsMode = false;

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      ...chromium.args,
      "--window-size=1280,800",
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu",
      "--single-process",
    ],
    executablePath: await chromium.executablePath(),
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
  );

  // Bloquear recursos innecesarios
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (["image", "stylesheet", "font"].includes(req.resourceType())) {
      req.abort();
    } else {
      req.continue();
    }
  });

  // Navegar a la página de login
  await page.goto("https://class.utp.edu.pe/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#username", { timeout: 10000 });

  // Login
  await page.type("#username", username);
  await page.type("#password", password);
  await Promise.all([
    page.click("#kc-login"),
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 10000 }),
  ]);

  // Verificar que el login fue exitoso
  const urlAfterLogin = page.url();
  if (!urlAfterLogin.includes("dashboard") && !urlAfterLogin.includes("calendario")) {
    throw new Error("Login fallido: Verifica tus credenciales.");
  }

  // Extraer nombre del estudiante
  const nombreEstudiante = await page.evaluate(() => {
    const nombre = document.querySelector(".text-body.font-bold");
    return nombre ? nombre.innerText.trim() : null;
  });
  console.log("Nombre del estudiante:", nombreEstudiante);

  // Navegar a Calendario
  await page.evaluate(() => {
    const link = document.querySelector('a[title="Calendario"]');
    if (link) link.click();
    else throw new Error("No se encontró el enlace del calendario.");
  });

  // Esperar a que la vista del calendario esté cargada
  await page.waitForFunction(
    () => document.querySelector(".fc-view-harness") !== null,
    { timeout: 15000 }
  );

  // Cambiar a vista semanal
  await page.evaluate(() => {
    const weekButton = document.querySelector(".fc-timeGridWeek-button, .fc-week-button");
    if (weekButton) weekButton.click();
    else throw new Error("No se encontró el botón de vista semanal.");
  });

  // Esperar a que los eventos estén cargados
  await page.waitForFunction(
    () => {
      const events = document.querySelectorAll(".fc-timegrid-event-harness");
      return events.length > 0;
    },
    { timeout: 15000 }
  );

  // Extraer eventos
  const eventos = await page.evaluate(() => {
    const lista = [];
    document.querySelectorAll(".fc-timegrid-event-harness").forEach((harnes) => {
      const event = harnes.querySelector(".fc-timegrid-event");
      if (!event) return;

      const isActivity = event.querySelector('[data-testid="single-day-activity-card-container"]') !== null;
      const isClass = event.querySelector('[data-testid="single-day-event-card-container"]') !== null;

      if (isActivity) {
        lista.push({
          tipo: "Actividad",
          nombreActividad:
            event.querySelector('[data-testid="activity-name-text"]')?.innerText.trim() ||
            event.querySelector('[data-tip^="🔴"]')?.getAttribute("data-tip") ||
            event.querySelector("p.font-black")?.innerText.trim(),
          curso: event.querySelector('[data-testid="course-name-text"]')?.innerText.trim(),
          hora: event.querySelector(".mt-xsm.text-neutral-03.text-small-02")?.innerText.trim(),
          estado: event.querySelector(".truncate")?.innerText.trim(),
        });
      } else if (isClass) {
        lista.push({
          tipo: "Clase",
          curso: event.querySelector('[data-testid="course-name-text"]')?.innerText.trim(),
          hora: event.querySelector(".mt-sm.text-neutral-04.text-small-02")?.innerText.trim(),
          modalidad: event.querySelector("span.font-bold.text-body.rounded-lg")?.innerText.trim(),
        });
      } else {
        lista.push({
          tipo: "Otro",
          nombre: event.querySelector("p.font-black")?.innerText.trim() || event.querySelector("p")?.innerText.trim(),
        });
      }
    });
    return lista;
  });

  await browser.close();
  return { nombreEstudiante, eventos };
}


// 🔹 Iniciar el servidor
app.listen(PORT, () => {
  console.log(`Servidor API escuchando en el puerto ${PORT}`);
});
