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
  await page.waitForSelector(".fc-timegrid-event-harness", { timeout: 60000 });

  // Vista semanal
  await page.evaluate(() => {
    const weekButton = document.querySelector(
      ".fc-timeGridWeek-button, .fc-week-button"
    );
    if (weekButton) weekButton.click();
  });
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Extraer información de la semana
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

  // Extraer eventos corregidos
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
          const container = event.querySelector(
            '[data-testid="single-day-activity-card-container"]'
          );
          const nombreActividad =
            container.querySelector("#activity-name-text")?.innerText.trim() ||
            container.querySelector("p[data-tip]")?.getAttribute("data-tip") ||
            container.querySelector("p.font-black")?.innerText.trim();

          const curso = container
            .querySelector("#course-name-text")
            ?.innerText.trim();

          const horaElements = container.querySelectorAll(
            "p.mt-xsm.text-neutral-03.text-small-02"
          );
          let hora = null;
          if (horaElements.length > 1) {
            hora = horaElements[1]?.innerText.trim();
          } else if (horaElements.length === 1) {
            const text = horaElements[0]?.innerText.trim();
            if (
              text &&
              (text.includes("a.m.") ||
                text.includes("p.m.") ||
                text.includes(":"))
            ) {
              hora = text;
            }
          }
          if (!hora) {
            const elements = container.querySelectorAll("[data-tip]");
            for (let el of elements) {
              const tip = el.getAttribute("data-tip");
              if (tip && (tip.includes("a.m.") || tip.includes("p.m."))) {
                hora = tip;
                break;
              }
            }
          }

          const estado = container
            .querySelector('[data-testid="activity-state-tag-container"] span')
            ?.innerText.trim();

          lista.push({
            tipo: "Actividad",
            nombreActividad,
            curso,
            hora: hora || "Sin hora específica",
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
          const hora = container
            .querySelector("p.mt-sm.text-neutral-04.text-small-02")
            ?.innerText.trim();
          const modalidad = container
            .querySelector("span.font-bold.text-body.rounded-lg")
            ?.innerText.trim();

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
          modalidad: multi
            .querySelector("span.font-bold.text-body.rounded-lg")
            ?.innerText.trim(),
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

// ===================================================
// 🔹 NUEVA RUTA SSE usando scrapearEventosUTP por pasos
// ===================================================
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

  try {
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

    // Paso 1: Ir al calendario
    send("estado", { mensaje: "Abriendo Class UTP (calendario)..." });
    await page.goto("https://class.utp.edu.pe/student/calendar", {
      waitUntil: "networkidle2",
    });
    await page.waitForSelector("#username", { timeout: 30000 });

    // Paso 2: Login
    send("estado", { mensaje: "Iniciando sesión..." });
    await page.type("#username", username);
    await page.type("#password", password);
    await page.click("#kc-login");
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 60000 });

    // Paso 3: Nombre del estudiante
    await page.waitForSelector(".text-body.font-bold", { timeout: 30000 });
    const nombreEstudiante = await page.evaluate(() => {
      const nombre = document.querySelector(".text-body.font-bold");
      return nombre ? nombre.innerText.trim() : null;
    });
    send("nombre", { nombreEstudiante });

    // Paso 4: Info de la semana
    send("estado", { mensaje: "Obteniendo información de la semana..." });
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
    send("semana", { semanaInfo });

    // Paso 5: Vista semanal
    send("estado", { mensaje: "Cambiando a vista semanal..." });
    await page.evaluate(() => {
      const weekButton = document.querySelector(
        ".fc-timeGridWeek-button, .fc-week-button"
      );
      if (weekButton) weekButton.click();
    });
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Paso 6: Eventos
    send("estado", { mensaje: "Extrayendo eventos..." });
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
              container
                .querySelector("#activity-name-text")
                ?.innerText.trim() ||
              container
                .querySelector("p[data-tip]")
                ?.getAttribute("data-tip") ||
              container.querySelector("p.font-black")?.innerText.trim();

            const curso = container
              .querySelector("#course-name-text")
              ?.innerText.trim();

            const horaElements = container.querySelectorAll(
              "p.mt-xsm.text-neutral-03.text-small-02"
            );
            let hora = null;
            if (horaElements.length > 1) {
              hora = horaElements[1]?.innerText.trim();
            } else if (horaElements.length === 1) {
              const text = horaElements[0]?.innerText.trim();
              if (
                text &&
                (text.includes("a.m.") ||
                  text.includes("p.m.") ||
                  text.includes(":"))
              ) {
                hora = text;
              }
            }
            if (!hora) {
              const elements = container.querySelectorAll("[data-tip]");
              for (let el of elements) {
                const tip = el.getAttribute("data-tip");
                if (tip && (tip.includes("a.m.") || tip.includes("p.m."))) {
                  hora = tip;
                  break;
                }
              }
            }

            const estado = container
              .querySelector(
                '[data-testid="activity-state-tag-container"] span'
              )
              ?.innerText.trim();

            lista.push({
              tipo: "Actividad",
              nombreActividad,
              curso,
              hora: hora || "Sin hora específica",
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
            const hora = container
              .querySelector("p.mt-sm.text-neutral-04.text-small-02")
              ?.innerText.trim();
            const modalidad = container
              .querySelector("span.font-bold.text-body.rounded-lg")
              ?.innerText.trim();

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
            modalidad: multi
              .querySelector("span.font-bold.text-body.rounded-lg")
              ?.innerText.trim(),
            dia: "Todo el ciclo",
            fecha: null,
          });
        }
      });

      return lista;
    });

    send("eventos", { eventos });

    await browser.close();
    send("fin", { mensaje: "Scraping finalizado ✅" });
    res.end();
  } catch (error) {
    console.error("Error en SSE:", error);
    send("error", { mensaje: error.message });
    res.end();
  }
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor API escuchando en el puerto ${PORT}`);
});
