import express from 'express';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import cors from 'cors';

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
  chromium.setGraphicsMode = false;

  const browser = await puppeteer.launch({
    headless: true,
    args: chromium.args,
    defaultViewport: chromium.defaultViewport,
    executablePath: await chromium.executablePath(),
  });

  const page = await browser.newPage();

  // Configurar user-agent para simular un navegador real
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36');

  // Ir a Class UTP
  await page.goto("https://class.utp.edu.pe/", { waitUntil: "networkidle2" });
  console.log("🔹 [Paso 1] URL después de goto:", page.url()); // Verifica la URL después de cargar la página inicial

  // Esperar a que el selector #username esté disponible
  try {
    await page.waitForSelector("#username", { timeout: 30000 });
    console.log("✅ [Paso 2] Selector #username encontrado. URL actual:", page.url());
  } catch (error) {
    console.error("❌ [Paso 2] Error: No se encontró #username. URL actual:", page.url());
    throw new Error(`No se encontró el selector #username. URL actual: ${page.url()}`);
  }

  // Login
  await page.type("#username", username);
  await page.type("#password", password);
  console.log("🔹 [Paso 3] Credenciales ingresadas. URL actual:", page.url());

  await page.click("#kc-login");
  console.log("🔹 [Paso 4] Botón de login clickeado. URL actual:", page.url());

  // Esperar redirección
  try {
    await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 30000 });
    console.log("✅ [Paso 5] Redirección exitosa después de login. URL actual:", page.url());
  } catch (e) {
    console.error("❌ [Paso 5] Error al esperar redirección. URL actual:", page.url());
    throw new Error(`Error al iniciar sesión. URL actual: ${page.url()}`);
  }

  // Esperar a que cargue el dashboard
  await new Promise(resolve => setTimeout(resolve, 2000));
  console.log("🔹 [Paso 6] Esperando dashboard. URL actual:", page.url());

  // Hacer clic en Calendario
  try {
    await page.evaluate(() => {
      const link = document.querySelector('a[title="Calendario"]');
      if (link) link.click();
      else throw new Error("No se encontró el enlace del calendario.");
    });
    console.log("✅ [Paso 7] Clic en Calendario. URL actual:", page.url());
  } catch (error) {
    console.error("❌ [Paso 7] Error al hacer clic en Calendario. URL actual:", page.url());
    throw new Error(`No se encontró el enlace del calendario. URL actual: ${page.url()}`);
  }

  // Esperar a que aparezcan los eventos
  try {
    await page.waitForSelector('.fc-timegrid-event-harness', { timeout: 30000 });
    console.log("✅ [Paso 8] Eventos del calendario encontrados. URL actual:", page.url());
  } catch (e) {
    console.error("❌ [Paso 8] Error al esperar eventos. URL actual:", page.url());
    throw new Error(`No se encontraron eventos en el calendario. URL actual: ${page.url()}`);
  }

  // Cambiar a vista semanal
  await page.evaluate(() => {
    const weekButton = document.querySelector('.fc-timeGridWeek-button, .fc-week-button');
    if (weekButton) weekButton.click();
  });
  console.log("🔹 [Paso 9] Cambiado a vista semanal. URL actual:", page.url());

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
