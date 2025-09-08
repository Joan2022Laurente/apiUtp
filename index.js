const express = require('express');
const puppeteer = require('puppeteer');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// Ruta POST para obtener eventos
app.post('/api/eventos', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({
      success: false,
      error: "Se requieren usuario y contraseña."
    });
  }

  try {
    const eventos = await scrapearEventosUTP(username, password);
    res.json({ success: true, eventos });
  } catch (error) {
    console.error("Error al scrapear eventos:", error);
    res.status(500).json({
      success: false,
      error: "Error al obtener eventos. Verifica tus credenciales o intenta más tarde."
    });
  }
});

// Función para scrapear eventos
async function scrapearEventosUTP(username, password) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--disable-gpu',
      '--single-process',
    ],
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium-browser',
  });

  const page = await browser.newPage();

  // Configurar el viewport
  await page.setViewport({ width: 1920, height: 1080 });

  // Ir a Class UTP
  await page.goto("https://class.utp.edu.pe/", { waitUntil: "networkidle2" });

  // Login
  await page.waitForSelector("#username");
  await page.type("#username", username);
  await page.type("#password", password);
  await page.click("#kc-login");

  // Esperar redirección
  try {
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 10000 });
  } catch (e) {
    throw new Error("Error al iniciar sesión. Verifica tus credenciales.");
  }

  console.log("✅ Logueado en Class UTP");

  // Esperar a que cargue el dashboard
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Hacer clic en Calendario
  await page.evaluate(() => {
    const link = document.querySelector('a[title="Calendario"]');
    if (link) link.click();
    else throw new Error("No se encontró el enlace del calendario.");
  });

  // Esperar a que aparezcan los eventos
  try {
    await page.waitForSelector('.fc-timegrid-event-harness', { timeout: 10000 });
  } catch (e) {
    throw new Error("No se encontraron eventos en el calendario.");
  }

  // Cambiar a vista semanal
  await page.evaluate(() => {
    const weekButton = document.querySelector('.fc-timeGridWeek-button, .fc-week-button');
    if (weekButton) weekButton.click();
  });

  // Esperar a que se actualice la vista
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Extraer eventos
  const eventos = await page.evaluate(() => {
    const lista = [];
    document.querySelectorAll('.fc-timegrid-event-harness').forEach(harnes => {
      const event = harnes.querySelector('.fc-timegrid-event');
      if (!event) return;

      const isActivity = event.querySelector('[data-testid="single-day-activity-card-container"]') !== null;
      const isClass = event.querySelector('[data-testid="single-day-event-card-container"]') !== null;

      if (isActivity) {
        lista.push({
          tipo: "Actividad",
          nombreActividad: event.querySelector('[data-testid="activity-name-text"]')?.innerText.trim() ||
                           event.querySelector('[data-tip^="🔴"]')?.getAttribute('data-tip') ||
                           event.querySelector('p.font-black')?.innerText.trim(),
          curso: event.querySelector('[data-testid="course-name-text"]')?.innerText.trim() ||
                 event.querySelector('[data-tip*="Seguridad"]')?.getAttribute('data-tip'),
          hora: event.querySelector('.mt-xsm.text-neutral-03.text-small-02')?.innerText.trim(),
          estado: event.querySelector('.truncate')?.innerText.trim(),
        });
      } else if (isClass) {
        lista.push({
          tipo: "Clase",
          curso: event.querySelector('[data-testid="course-name-text"]')?.innerText.trim() ||
                 event.querySelector('p.font-black')?.innerText.trim(),
          hora: event.querySelector('.mt-sm.text-neutral-04.text-small-02')?.innerText.trim(),
          modalidad: event.querySelector('span.font-bold.text-body.rounded-lg')?.innerText.trim(),
        });
      } else {
        lista.push({
          tipo: "Otro",
          nombre: event.querySelector('p.font-black')?.innerText.trim() ||
                  event.querySelector('p')?.innerText.trim(),
        });
      }
    });
    return lista;
  });

  await browser.close();
  return eventos;
}

// Iniciar el servidor
app.listen(PORT, () => {
  console.log(`Servidor API escuchando en el puerto ${PORT}`);
});
