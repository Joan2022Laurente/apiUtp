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
// 🔹 SCRAPER CORREGIDO
// =============================
// Función para scrapear eventos (compatible con Render + JSON organizado)
async function scrapearEventosUTP(username, password) {
  chromium.setGraphicsMode = false;

  const browser = await puppeteer.launch({
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

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
  );

  // Ir a Class UTP
  await page.goto("https://class.utp.edu.pe/", { waitUntil: "networkidle2" });
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

  // Abrir calendario
  await page.evaluate(() => {
    const link = document.querySelector('a[title="Calendario"]');
    if (link) link.click();
    else throw new Error("No se encontró el enlace del calendario.");
  });
  await page.waitForSelector(".fc-timegrid-event-harness", { timeout: 60000 });

  // Cambiar a vista semanal
  await page.evaluate(() => {
    const weekButton = document.querySelector(
      ".fc-timeGridWeek-button, .fc-week-button"
    );
    if (weekButton) weekButton.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 🔹 Extraer info de semana
  const semanaInfo = await page.evaluate(() => {
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
      ciclo: getTextByXPath(
        "/html/body/div[1]/div[2]/div[2]/div[2]/div/div/div/div/div[1]/div[1]/div[1]/p"
      ),
      semanaActual: getTextByXPath(
        "/html/body/div[1]/div[2]/div[2]/div[2]/div/div/div/div/div[1]/div[1]/div[2]/p[1]"
      ),
      fechas: getTextByXPath(
        "/html/body/div[1]/div[2]/div[2]/div[2]/div/div/div/div/div[1]/div[1]/div[2]/p[2]"
      ),
    };
  });

  // 🔹 Extraer eventos organizados
  const eventos = await page.evaluate(() => {
    const lista = [];

    document.querySelectorAll(".fc-timegrid-event-harness").forEach((harnes) => {
      const event = harnes.querySelector(".fc-timegrid-event");
      if (!event) return;

      const isActivity =
        event.querySelector('[data-testid="single-day-activity-card-container"]') !== null;
      const isClass =
        event.querySelector('[data-testid="single-day-event-card-container"]') !== null;

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
        const container = event.querySelector(
          '[data-testid="single-day-activity-card-container"]'
        );
        const nombreActividad =
          container.querySelector("#activity-name-text")?.innerText.trim() ||
          container.querySelector("p[data-tip]")?.getAttribute("data-tip") ||
          container.querySelector("p.font-black")?.innerText.trim();

        const curso = container.querySelector("#course-name-text")?.innerText.trim();

        const hora =
          container.querySelector("p.mt-xsm.text-neutral-03.text-small-02")
            ?.innerText.trim() || "Sin hora específica";

        const estado = container.querySelector(
          '[data-testid="activity-state-tag-container"] span'
        )?.innerText.trim();

        lista.push({
          tipo: "Actividad",
          nombreActividad,
          curso,
          hora,
          estado,
          dia: dayName,
          fecha: dayDate,
        });
      } else if (isClass) {
        const container = event.querySelector(
          '[data-testid="single-day-event-card-container"]'
        );
        const curso =
          container.querySelector("#course-name-text")?.innerText.trim() ||
          container.querySelector("p.font-black")?.innerText.trim();
        const hora = container.querySelector(
          "p.mt-sm.text-neutral-04.text-small-02"
        )?.innerText.trim();
        const modalidad = container.querySelector(
          "span.font-bold.text-body.rounded-lg"
        )?.innerText.trim();

        lista.push({
          tipo: "Clase",
          curso,
          hora,
          modalidad,
          dia: dayName,
          fecha: dayDate,
        });
      }
    });

    // Eventos de varios días
    document.querySelectorAll(".fc-daygrid-event-harness").forEach((h) => {
      const event = h.querySelector(".fc-daygrid-event");
      if (!event) return;
      const multi = event.querySelector(
        '[data-testid="multiple-day-event-card-container"]'
      );
      if (multi) {
        lista.push({
          tipo: "Curso",
          curso: multi.querySelector("span.font-black")?.innerText.trim(),
          modalidad: multi.querySelector("span.font-bold.text-body.rounded-lg")?.innerText.trim(),
          dia: "Todo el ciclo",
          fecha: null,
        });
      }
    });

    return lista;
  });

  await browser.close();
  return { nombreEstudiante, semanaInfo, eventos };
}

// Función para scrapear eventos (compatible con Render + JSON organizado)
async function scrapearEventosUTP(username, password) {
  chromium.setGraphicsMode = false;

  const browser = await puppeteer.launch({
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

  const page = await browser.newPage();
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
  );

  // Ir a Class UTP
  await page.goto("https://class.utp.edu.pe/", { waitUntil: "networkidle2" });
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

  // Abrir calendario
  await page.evaluate(() => {
    const link = document.querySelector('a[title="Calendario"]');
    if (link) link.click();
    else throw new Error("No se encontró el enlace del calendario.");
  });
  await page.waitForSelector(".fc-timegrid-event-harness", { timeout: 60000 });

  // Cambiar a vista semanal
  await page.evaluate(() => {
    const weekButton = document.querySelector(
      ".fc-timeGridWeek-button, .fc-week-button"
    );
    if (weekButton) weekButton.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // 🔹 Extraer info de semana
  const semanaInfo = await page.evaluate(() => {
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
      ciclo: getTextByXPath(
        "/html/body/div[1]/div[2]/div[2]/div[2]/div/div/div/div/div[1]/div[1]/div[1]/p"
      ),
      semanaActual: getTextByXPath(
        "/html/body/div[1]/div[2]/div[2]/div[2]/div/div/div/div/div[1]/div[1]/div[2]/p[1]"
      ),
      fechas: getTextByXPath(
        "/html/body/div[1]/div[2]/div[2]/div[2]/div/div/div/div/div[1]/div[1]/div[2]/p[2]"
      ),
    };
  });

  // 🔹 Extraer eventos organizados
  const eventos = await page.evaluate(() => {
    const lista = [];

    document.querySelectorAll(".fc-timegrid-event-harness").forEach((harnes) => {
      const event = harnes.querySelector(".fc-timegrid-event");
      if (!event) return;

      const isActivity =
        event.querySelector('[data-testid="single-day-activity-card-container"]') !== null;
      const isClass =
        event.querySelector('[data-testid="single-day-event-card-container"]') !== null;

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
        const container = event.querySelector(
          '[data-testid="single-day-activity-card-container"]'
        );
        const nombreActividad =
          container.querySelector("#activity-name-text")?.innerText.trim() ||
          container.querySelector("p[data-tip]")?.getAttribute("data-tip") ||
          container.querySelector("p.font-black")?.innerText.trim();

        const curso = container.querySelector("#course-name-text")?.innerText.trim();

        const hora =
          container.querySelector("p.mt-xsm.text-neutral-03.text-small-02")
            ?.innerText.trim() || "Sin hora específica";

        const estado = container.querySelector(
          '[data-testid="activity-state-tag-container"] span'
        )?.innerText.trim();

        lista.push({
          tipo: "Actividad",
          nombreActividad,
          curso,
          hora,
          estado,
          dia: dayName,
          fecha: dayDate,
        });
      } else if (isClass) {
        const container = event.querySelector(
          '[data-testid="single-day-event-card-container"]'
        );
        const curso =
          container.querySelector("#course-name-text")?.innerText.trim() ||
          container.querySelector("p.font-black")?.innerText.trim();
        const hora = container.querySelector(
          "p.mt-sm.text-neutral-04.text-small-02"
        )?.innerText.trim();
        const modalidad = container.querySelector(
          "span.font-bold.text-body.rounded-lg"
        )?.innerText.trim();

        lista.push({
          tipo: "Clase",
          curso,
          hora,
          modalidad,
          dia: dayName,
          fecha: dayDate,
        });
      }
    });

    // Eventos de varios días
    document.querySelectorAll(".fc-daygrid-event-harness").forEach((h) => {
      const event = h.querySelector(".fc-daygrid-event");
      if (!event) return;
      const multi = event.querySelector(
        '[data-testid="multiple-day-event-card-container"]'
      );
      if (multi) {
        lista.push({
          tipo: "Curso",
          curso: multi.querySelector("span.font-black")?.innerText.trim(),
          modalidad: multi.querySelector("span.font-bold.text-body.rounded-lg")?.innerText.trim(),
          dia: "Todo el ciclo",
          fecha: null,
        });
      }
    });

    return lista;
  });

  await browser.close();
  return { nombreEstudiante, semanaInfo, eventos };
}

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor API escuchando en el puerto ${PORT}`);
});
