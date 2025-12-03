// scraper.js
export async function obtenerNombreEstudiante(page) {
  await page.waitForSelector(".text-body.font-bold", { timeout: 30000 });
  return await page.evaluate(() => {
    const nombre = document.querySelector(".text-body.font-bold");
    return nombre ? nombre.innerText.trim() : null;
  });
}

export async function obtenerCursos(page) {
  await page.waitForSelector("div.items-center.grid.mt-xxlg.sc-kvZOFW.ibxudr", {
    timeout: 30000,
  });

  return await page.evaluate(() => {
    // Selecciona el primer div con la clase especificadaa
    const container = document.querySelector(
      "div.items-center.grid.mt-xxlg.sc-kvZOFW.ibxudr"
    );
    if (!container) return [];

    // Selecciona los cards dentro del contenedor
    const cards = container.querySelectorAll(
      '[data-testid="course-card-container"]'
    );
    const cursos = [];

    cards.forEach((card) => {
      const nombre =
        card
          .querySelector(".font-black")
          ?.innerText.trim()
          .replace(/\s+/g, " ") || null;
      const detalle =
        card
          .querySelector(".text-small-02.lg\\:text-body.text-neutral-02")
          ?.innerText.trim() || "";
      const modalidad = detalle.includes("-")
        ? detalle.split("-")[1].trim()
        : detalle.trim();
      const docente =
        card
          .querySelector("p.text-small-02 span.capitalize")
          ?.innerText.trim() || null;

      cursos.push({ nombre, modalidad, docente });
    });

    return cursos;
  });
}

export async function obtenerSemanaInfo(page) {
  return await page.evaluate(() => {
    const getTextByXPath = (xpath) => {
      const el = document.evaluate(
        xpath,
        document,
        null,
        XPathResult.FIRST_ORDERED_NODE_TYPE,
        null
      ).singleNodeValue;
      return el ? el.innerText.trim() : null;
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
}

export async function obtenerEventos(page) {
  return await page.evaluate(() => {
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
          if (headerCell)
            dayName = headerCell
              .querySelector(".fc-col-header-cell-cushion div")
              ?.innerText.trim();
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
          const hora =
            container
              .querySelector("p.mt-xsm.text-neutral-03.text-small-02")
              ?.innerText.trim() || "Sin hora específica";
          const estado = container
            .querySelector('[data-testid="activity-state-tag-container"] span')
            ?.innerText.trim();
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

    return lista;
  });
}

export async function obtenerActividadesSemanales(page) {
  // Esperamos a que cargue el título de la sección para asegurar que el contenido está listo
  // Si no aparece en 5 segundos, asumimos que no hay actividades o cargó diferente
  try {
    await page.waitForSelector('p[data-testid="title"]', { timeout: 5000 });
  } catch (e) {
    return []; // Retorna array vacío si no encuentra la sección
  }

  return await page.evaluate(() => {
    // Seleccionamos todas las tarjetas que tienen el testid="card"
    const cards = document.querySelectorAll('a[data-testid="card"]');
    const actividades = [];

    cards.forEach((card) => {
      // 1. Obtener Link
      const link = card.getAttribute("href") || "#";

      // 2. Obtener Tipo (ej: Tarea calificada, Foro, etc.)
      // Buscamos el primer span con icono y texto
      const tipoElement = card.querySelector(".sc-epnACN p");
      const tipo = tipoElement ? tipoElement.innerText.trim() : "Actividad";

      // 3. Obtener Título de la Actividad
      // Dentro de la clase sc-cmthru, a veces hay un div sc-esOvli con el texto completo
      const tituloContainer = card.querySelector(".sc-cmthru");
      const tituloInner = card.querySelector(".sc-esOvli");
      const nombreActividad = tituloInner
        ? tituloInner.innerText.trim()
        : tituloContainer
        ? tituloContainer.innerText.trim()
        : "Sin nombre";

      // 4. Obtener Estado (ej: Por entregar, Programada)
      // El estado suele estar en el segundo span (sc-iQNlJl), en un <p> que NO es el título
      const estadoContainer = card.querySelector(".sc-iQNlJl");
      let estado = "Desconocido";
      if (estadoContainer) {
        // Buscamos un párrafo que tenga texto pero que no sea el título (sc-cmthru)
        const estadoP = Array.from(estadoContainer.querySelectorAll("p")).find(
          (p) => !p.classList.contains("sc-cmthru")
        );
        if (estadoP) {
          estado = estadoP.innerText.trim();
        } else {
          // Fallback: Si no hay estructura interna clara, tomamos el texto del contenedor y quitamos el título
          const fullText = estadoContainer.innerText;
          estado = fullText.replace(nombreActividad, "").trim();
        }
      }

      // 5. Obtener Curso
      const cursoElement = card.querySelector(".sc-hZSUBg");
      const curso = cursoElement
        ? cursoElement.innerText.trim()
        : "Curso general";

      // 6. Obtener Fecha de Vencimiento / Info
      const fechaElement = card.querySelector(".sc-cMhqgX .truncate");
      const fechaLimite = fechaElement ? fechaElement.innerText.trim() : "";

      // 7. Obtener Puntos (si existen)
      const puntosElement =
        card.querySelector(".sc-cMhqgX span + span") ||
        card.querySelector(".sc-cMhqgX");
      let puntos = "";
      if (puntosElement && puntosElement.innerText.includes("pts")) {
        puntos = puntosElement.innerText.split("pts")[0].trim() + " pts"; // extracción simple
      }

      actividades.push({
        nombreActividad,
        tipo,
        curso,
        estado,
        fechaLimite,
        link: `https://class.utp.edu.pe${link}`, // Aseguramos ruta absoluta
      });
    });

    return actividades;
  });
}
