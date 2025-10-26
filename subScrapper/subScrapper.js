// scraper.js
export async function obtenerNombreEstudiante(page) {
  await page.waitForSelector(".text-body.font-bold", { timeout: 30000 });
  return await page.evaluate(() => {
    const nombre = document.querySelector(".text-body.font-bold");
    return nombre ? nombre.innerText.trim() : null;
  });
}

export async function obtenerCursos(page) {
  await page.waitForSelector('div.items-center.grid.mt-xxlg.sc-kvZOFW.ibxudr', {
    timeout: 30000,
  });

  return await page.evaluate(() => {
    // Selecciona el primer div con la clase especificada
    const container = document.querySelector('div.items-center.grid.mt-xxlg.sc-kvZOFW.ibxudr');
    if (!container) return [];

    // Selecciona los cards dentro del contenedor
    const cards = container.querySelectorAll('[data-testid="course-card-container"]');
    const cursos = [];

    cards.forEach((card) => {
      const nombre = card.querySelector(".font-black")?.innerText.trim().replace(/\s+/g, " ") || null;
      const detalle = card.querySelector(".text-small-02.lg\\:text-body.text-neutral-02")?.innerText.trim() || "";
      const modalidad = detalle.includes("-") ? detalle.split("-")[1].trim() : detalle.trim();
      const docente = card.querySelector("p.text-small-02 span.capitalize")?.innerText.trim() || null;

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
