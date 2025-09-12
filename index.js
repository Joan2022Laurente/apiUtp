import express from "express";
import puppeteer from "puppeteer-core";
import chromium from "@sparticuz/chromium";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
  origin: ["http://127.0.0.1:5500", "https://utpschedule.vercel.app"],
}));
app.use(express.json());

let isBusy = false; // Solo un usuario a la vez
let browser;       // Navegador global

// Función para iniciar navegador si no existe
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

// ===================================================
// Ruta SSE con navegador persistente, cookies borradas, cache mantenida
// ===================================================
app.get("/api/eventos-stream", async (req, res) => {
  if (isBusy) {
    res.writeHead(503, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      success: false,
      error: "El servicio está ocupado, intenta nuevamente en unos minutos."
    }));
  }

  isBusy = true; // Bloquear servicio

  const { username, password } = req.query;
  if (!username || !password) {
    res.writeHead(400, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      success: false,
      error: "Se requieren usuario y contraseña."
    }));
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

  // Cancelar scraping si el cliente se desconecta
  req.on("close", async () => {
    console.log("Cliente desconectado, cancelando scraping...");
    if (page) {
      try { await page.close(); } catch (e) { console.error(e); }
    }
    isBusy = false;
  });

  try {
    const browserInstance = await getBrowser();
    page = await browserInstance.newPage();
    await page.setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36");

    // Paso 1: Navegar
    send("estado", { mensaje: "Navegando a Class UTP..." });
    await page.goto("https://class.utp.edu.pe/student/calendar", { waitUntil: "networkidle2" });
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

    // Paso 4: Vista semanal
    send("estado", { mensaje: "Cambiando a vista semanal..." });
    await page.waitForSelector(".fc-timegrid-event-harness", { timeout: 60000 });
    await page.evaluate(() => {
      const weekButton = document.querySelector(".fc-timeGridWeek-button, .fc-week-button");
      if (weekButton) weekButton.click();
    });
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Paso 5: Info de la semana
    const semanaInfo = await page.evaluate(() => {
      const getTextByXPath = xpath => {
        const el = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null).singleNodeValue;
        return el ? el.innerText.trim() : null;
      };
      return {
        ciclo: getTextByXPath("/html/body/div[1]/div[2]/div[2]/div[2]/div/div/div/div/div[1]/div[1]/div[1]/p"),
        semanaActual: getTextByXPath("/html/body/div[1]/div[2]/div[2]/div[2]/div/div/div/div/div[1]/div[1]/div[2]/p[1]"),
        fechas: getTextByXPath("/html/body/div[1]/div[2]/div[2]/div[2]/div/div/div/div/div[1]/div[1]/div[2]/p[2]")
      };
    });
    send("semana", { semanaInfo });

    // Paso 6: Eventos
    send("estado", { mensaje: "Extrayendo eventos..." });
    const eventos = await page.evaluate(() => {
      const lista = [];
      document.querySelectorAll(".fc-timegrid-event-harness").forEach(harnes => {
        const event = harnes.querySelector(".fc-timegrid-event");
        if (!event) return;
        const isActivity = event.querySelector('[data-testid="single-day-activity-card-container"]') !== null;
        const isClass = event.querySelector('[data-testid="single-day-event-card-container"]') !== null;
        const dayCell = harnes.closest(".fc-timegrid-col");
        const dayDate = dayCell?.getAttribute("data-date");
        let dayName = null;
        if (dayDate) {
          const headerCell = document.querySelector(`th.fc-col-header-cell[data-date="${dayDate}"]`);
          if (headerCell) dayName = headerCell.querySelector(".fc-col-header-cell-cushion div")?.innerText.trim();
        }

        if (isActivity) {
          const container = event.querySelector('[data-testid="single-day-activity-card-container"]');
          const nombreActividad = container.querySelector("#activity-name-text")?.innerText.trim() ||
                                  container.querySelector("p[data-tip]")?.getAttribute("data-tip") ||
                                  container.querySelector("p.font-black")?.innerText.trim();
          const curso = container.querySelector("#course-name-text")?.innerText.trim();
          const hora = container.querySelector("p.mt-xsm.text-neutral-03.text-small-02")?.innerText.trim() || "Sin hora específica";
          const estado = container.querySelector('[data-testid="activity-state-tag-container"] span')?.innerText.trim();
          lista.push({ tipo:"Actividad", nombreActividad, curso, hora, estado, dia: dayName, fecha: dayDate });
        } else if (isClass) {
          const container = event.querySelector('[data-testid="single-day-event-card-container"]');
          const curso = container.querySelector("#course-name-text")?.innerText.trim() || container.querySelector("p.font-black")?.innerText.trim();
          const hora = container.querySelector("p.mt-sm.text-neutral-04.text-small-02")?.innerText.trim();
          const modalidad = container.querySelector("span.font-bold.text-body.rounded-lg")?.innerText.trim();
          lista.push({ tipo:"Clase", curso, hora, modalidad, dia: dayName, fecha: dayDate });
        }
      });
      return lista;
    });

    send("eventos", { eventos });

    // 🔹 Borrar cookies y almacenamiento local para la siguiente sesión
    const client = await page.target().createCDPSession();
    await client.send("Network.clearBrowserCookies");
    await client.send("Storage.clearDataForOrigin", {
      origin: "https://class.utp.edu.pe",
      storageTypes: "local_storage,session_storage"
    });

    await page.close(); // Solo cerramos la pestaña, el navegador global sigue abierto
    send("fin", { mensaje: "Scraping finalizado ✅" });
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

// Iniciar servidor
app.listen(PORT, () => console.log(`Servidor API escuchando en puerto ${PORT}`));
