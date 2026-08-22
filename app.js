(function () {
  const form = document.getElementById("finder-form");
  const emailInput = document.getElementById("email-input");
  const urlInput = document.getElementById("url-input");
  const jobTitle1Input = document.getElementById("job-title-1");
  const jobTitle2Input = document.getElementById("job-title-2");
  const jobTitle3Input = document.getElementById("job-title-3");
  const industryInput = document.getElementById("industry-input");
  const submitBtn = document.getElementById("submit-btn");
  const alertEl = document.getElementById("alert-message");
  const savePdfBtn = document.getElementById("save-pdf-btn");

  // Display labels for each category key — used both for the "Channel"
  // column in the All Results table and for the PDF template's section
  // headings, so they always match the on-page box titles exactly.
  const CATEGORY_LABELS = {
    events: "Events and Tradeshows",
    meetups: "Smaller Group Events",
    newsletters: "Newsletters",
    influencers: "Influencers",
    publications: "Publications",
    syndication: "Other Syndication Platforms",
    social: "Social Media and Blogs",
  };
  const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);

  const boxes = {
    events: document.querySelector("#box-events .box-body"),
    meetups: document.querySelector("#box-meetups .box-body"),
    newsletters: document.querySelector("#box-newsletters .box-body"),
    influencers: document.querySelector("#box-influencers .box-body"),
    publications: document.querySelector("#box-publications .box-body"),
    syndication: document.querySelector("#box-syndication .box-body"),
    social: document.querySelector("#box-social .box-body"),
  };
  const allResultsBox = document.querySelector("#box-all-results .box-body");

  const MAX_ROWS = 15;

  // In-memory only, on purpose: a refresh should reset everything to "No Data Collected".
  let lastSubmittedKey = null;

  // Holds everything the PDF template needs from the most recent successful
  // run: the submitted inputs plus the exact results that were rendered.
  // Cleared whenever a new search starts or fails, so the PDF button can't
  // export stale data.
  let lastRunData = null;

  function normalizeKey({ email, companyUrl, jobTitles, industry }) {
    return JSON.stringify({
      email: email.trim().toLowerCase(),
      companyUrl: companyUrl.trim().toLowerCase().replace(/\/+$/, ""),
      jobTitles: jobTitles.map((t) => t.trim().toLowerCase()),
      industry: (industry || "").trim().toLowerCase(),
    });
  }

  function showAlert(message) {
    alertEl.textContent = message;
    alertEl.hidden = false;
  }

  function clearAlert() {
    alertEl.hidden = true;
    alertEl.textContent = "";
  }

  function allBoxElements() {
    return [allResultsBox, ...Object.values(boxes)];
  }

  function resetBoxesToLoading() {
    allBoxElements().forEach((el) => {
      el.innerHTML =
        '<span class="loading"><span class="spinner" aria-hidden="true"></span>Searching…</span>';
    });
  }

  function resetBoxesToNoData() {
    allBoxElements().forEach((el) => {
      el.textContent = "No Data Collected";
    });
  }

  function disablePdfButton() {
    savePdfBtn.disabled = true;
    savePdfBtn.title = "Run a search first";
    lastRunData = null;
  }

  function enablePdfButton() {
    savePdfBtn.disabled = false;
    savePdfBtn.title = "";
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderResultBox(el, items) {
    if (!items || items.length === 0) {
      el.textContent = "No Relevant Results Found";
      return;
    }
    const rows = items
      .slice(0, MAX_ROWS)
      .map((item) => {
        const name = escapeHtml(item.name || "Untitled");
        const url = item.url ? escapeHtml(item.url) : "";
        const link = url
          ? `<a href="${url}" target="_blank" rel="noopener noreferrer">Visit Site</a>`
          : "N/A";
        return `<tr><td>${name}</td><td class="col-link">${link}</td></tr>`;
      })
      .join("");
    el.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th class="col-link">Link</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // The "All Results" box has no 15-row cap and adds a "Channel" column
  // showing which of the seven boxes each row came from. Order is whatever
  // the backend returned in data.allResults — it reflects overall fit
  // across every category, not results grouped by category.
  function renderAllResultsBox(el, items) {
    if (!items || items.length === 0) {
      el.textContent = "No Relevant Results Found";
      return;
    }
    const rows = items
      .map((item) => {
        const name = escapeHtml(item.name || "Untitled");
        const channel = escapeHtml(item.channel || CATEGORY_LABELS[item.category] || "");
        const url = item.url ? escapeHtml(item.url) : "";
        const link = url
          ? `<a href="${url}" target="_blank" rel="noopener noreferrer">Visit Site</a>`
          : "N/A";
        return `<tr><td>${name}</td><td class="col-channel">${channel}</td><td class="col-link">${link}</td></tr>`;
      })
      .join("");
    el.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th class="col-channel">Channel</th><th class="col-link">Link</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function buildAllResultsFallback(results) {
    // If the backend doesn't send data.allResults for some reason, fall
    // back to concatenating the capped per-category lists in box order
    // rather than showing an empty box.
    const combined = [];
    CATEGORY_ORDER.forEach((key) => {
      (results[key] || []).forEach((item) => {
        combined.push({ name: item.name, url: item.url, channel: CATEGORY_LABELS[key] });
      });
    });
    return combined;
  }

  function renderResults(data) {
    const results = data.results || {};
    renderResultBox(boxes.events, results.events);
    renderResultBox(boxes.meetups, results.meetups);
    renderResultBox(boxes.newsletters, results.newsletters);
    renderResultBox(boxes.influencers, results.influencers);
    renderResultBox(boxes.publications, results.publications);
    renderResultBox(boxes.syndication, results.syndication);
    renderResultBox(boxes.social, results.social);

    const allResults =
      Array.isArray(data.allResults) && data.allResults.length > 0
        ? data.allResults
        : buildAllResultsFallback(results);
    renderAllResultsBox(allResultsBox, allResults);

    return allResults;
  }

  function validate({ email, companyUrl, jobTitle1 }) {
    const missing = {
      email: !email,
      companyUrl: !companyUrl,
      jobTitle1: !jobTitle1,
    };
    const missingCount = Object.values(missing).filter(Boolean).length;

    if (missingCount === 0) return null;
    if (missingCount >= 2) return "Please Provide Required Information";
    if (missing.email) return "No Email Provided";
    if (missing.jobTitle1) return "One Job Title Is Required";
    if (missing.companyUrl) return "Company URL Is Required";
    return "Please Provide Required Information";
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    clearAlert();

    const email = emailInput.value.trim();
    const companyUrl = urlInput.value.trim();
    const jobTitle1 = jobTitle1Input.value.trim();
    const jobTitle2 = jobTitle2Input.value.trim();
    const jobTitle3 = jobTitle3Input.value.trim();
    const industry = industryInput.value.trim();

    const validationError = validate({ email, companyUrl, jobTitle1 });
    if (validationError) {
      showAlert(validationError);
      return;
    }

    const jobTitles = [jobTitle1, jobTitle2, jobTitle3].filter(Boolean);
    const key = normalizeKey({ email, companyUrl, jobTitles, industry });

    if (lastSubmittedKey && key === lastSubmittedKey) {
      showAlert("Results already collected and displayed below.");
      return;
    }

    if (!SYNDICATION_API_URL || SYNDICATION_API_URL.indexOf("REPLACE_WITH_YOUR_WORKER_URL") !== -1) {
      showAlert("The backend isn't configured yet (see config.js).");
      return;
    }

    submitBtn.disabled = true;
    disablePdfButton();
    resetBoxesToLoading();

    try {
      const res = await fetch(SYNDICATION_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email,
          companyUrl,
          jobTitles,
          industry: industry || null,
          today: new Date().toISOString().slice(0, 10),
        }),
      });

      const payload = await res.json().catch(() => null);

      if (!res.ok || !payload || payload.status === "error") {
        resetBoxesToNoData();
        const message = payload && payload.message ? payload.message : "Something went wrong. Please try again.";
        showAlert(message);
        return;
      }

      const allResults = renderResults(payload);
      lastSubmittedKey = key;

      // The PDF template needs the submitted inputs alongside the results —
      // capture them now, right after a successful run, per "Create PDF"
      // only being enabled once the tool has run and data is presented.
      lastRunData = {
        companyUrl,
        companyName: payload.companyName || null,
        jobTitles,
        industry: industry || null,
        results: payload.results || {},
        allResults,
      };
      enablePdfButton();
    } catch (err) {
      resetBoxesToNoData();
      showAlert("Could not reach the backend. Please try again.");
    } finally {
      submitBtn.disabled = false;
    }
  });

  // --- PDF template -------------------------------------------------------
  // Builds a proper document (title page summary + one table per section)
  // straight from the data that was rendered, rather than a screenshot of
  // the page, so it reads as a clean, professional report on its own.

  function slugify(str) {
    return String(str)
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "results";
  }

  function addLinkCell(doc, data) {
    // autotable "didDrawCell" hook: the visible "Visit Site" text is drawn
    // by autotable itself (from cell.raw.content); this layers an actual
    // clickable link annotation on top of it. Only the link column's raw
    // value is an object with a `url` property, so that's what identifies
    // it — with array-style head/body, dataKey is a numeric index rather
    // than "link", so it can't be used to find the column.
    if (data.cell.section !== "body") return;
    const raw = data.cell.raw;
    const url = raw && typeof raw === "object" ? raw.url : null;
    if (!url) return;
    doc.link(data.cell.x, data.cell.y, data.cell.width, data.cell.height, { url });
  }

  function addSectionTable(doc, { title, head, rows, startY }) {
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 40;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(31, 32, 35);
    doc.text(title, margin, startY);

    if (rows.length === 0) {
      doc.setFont("helvetica", "italic");
      doc.setFontSize(10);
      doc.setTextColor(107, 109, 118);
      doc.text("No Relevant Results Found", margin, startY + 16);
      return startY + 34;
    }

    doc.autoTable({
      startY: startY + 8,
      margin: { left: margin, right: margin },
      head: [head],
      body: rows,
      theme: "grid",
      styles: { fontSize: 9, cellPadding: 5, overflow: "linebreak", valign: "middle" },
      headStyles: { fillColor: [47, 111, 235], textColor: 255, fontStyle: "bold" },
      alternateRowStyles: { fillColor: [247, 247, 248] },
      columnStyles:
        head.length === 3
          ? { 0: { cellWidth: (pageWidth - margin * 2) * 0.42 }, 1: { cellWidth: (pageWidth - margin * 2) * 0.28 } }
          : { 0: { cellWidth: (pageWidth - margin * 2) * 0.65 } },
      didDrawCell: (data) => addLinkCell(doc, data),
    });

    return doc.lastAutoTable.finalY + 24;
  }

  function toTableRows(items, includeChannel) {
    return items.map((item) => {
      const link = { content: "Visit Site", url: item.url || "" };
      return includeChannel
        ? [item.name || "Untitled", item.channel || "", link]
        : [item.name || "Untitled", link];
    });
  }

  function buildPdf(run) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
    const pageWidth = doc.internal.pageSize.getWidth();
    const margin = 40;
    let y = 56;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(20);
    doc.setTextColor(31, 32, 35);
    doc.text("Syndication & Event Finder — Results", margin, y);
    y += 22;

    doc.setDrawColor(226, 226, 230);
    doc.line(margin, y, pageWidth - margin, y);
    y += 24;

    const summaryRows = [
      ["Company", run.companyName ? `${run.companyName} (${run.companyUrl})` : run.companyUrl],
      ["Job Titles Provided", run.jobTitles.join(", ") || "N/A"],
      ["Industry Provided", run.industry || "N/A"],
      ["Generated", new Date().toLocaleString()],
    ];

    doc.autoTable({
      startY: y,
      margin: { left: margin, right: margin },
      body: summaryRows,
      theme: "plain",
      styles: { fontSize: 10, cellPadding: 4 },
      columnStyles: {
        0: { fontStyle: "bold", textColor: [107, 109, 118], cellWidth: 130 },
        1: { textColor: [31, 32, 35] },
      },
    });
    y = doc.lastAutoTable.finalY + 28;

    y = addSectionTable(doc, {
      title: "All Results",
      head: ["Name", "Channel", "Link"],
      rows: toTableRows(run.allResults, true),
      startY: y,
    });

    CATEGORY_ORDER.forEach((key) => {
      if (y > doc.internal.pageSize.getHeight() - 120) {
        doc.addPage();
        y = 56;
      }
      y = addSectionTable(doc, {
        title: CATEGORY_LABELS[key],
        head: ["Name", "Link"],
        rows: toTableRows(run.results[key] || [], false),
        startY: y,
      });
    });

    const pageCount = doc.internal.getNumberOfPages();
    for (let i = 1; i <= pageCount; i += 1) {
      doc.setPage(i);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(8);
      doc.setTextColor(150, 150, 155);
      doc.text(`Page ${i} of ${pageCount}`, pageWidth - margin, doc.internal.pageSize.getHeight() - 20, {
        align: "right",
      });
    }

    doc.save(`syndication-event-finder-${slugify(run.companyName || run.companyUrl)}.pdf`);
  }

  savePdfBtn.addEventListener("click", function () {
    if (!lastRunData) return;
    savePdfBtn.disabled = true;
    savePdfBtn.textContent = "Preparing PDF…";
    try {
      buildPdf(lastRunData);
    } catch (err) {
      showAlert("Could not generate the PDF. Please try again.");
    } finally {
      savePdfBtn.disabled = false;
      savePdfBtn.textContent = "Create PDF";
    }
  });

  // Starts disabled until a successful search populates lastRunData.
  disablePdfButton();
})();
