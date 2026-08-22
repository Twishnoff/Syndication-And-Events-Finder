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

  const boxes = {
    events: document.querySelector("#box-events .box-body"),
    meetups: document.querySelector("#box-meetups .box-body"),
    newsletters: document.querySelector("#box-newsletters .box-body"),
    influencers: document.querySelector("#box-influencers .box-body"),
    publications: document.querySelector("#box-publications .box-body"),
    syndication: document.querySelector("#box-syndication .box-body"),
    social: document.querySelector("#box-social .box-body"),
  };

  const MAX_ROWS = 15;

  // In-memory only, on purpose: a refresh should reset everything to "No Data Collected".
  let lastSubmittedKey = null;

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

  function resetBoxesToLoading() {
    Object.values(boxes).forEach((el) => {
      el.innerHTML =
        '<span class="loading"><span class="spinner" aria-hidden="true"></span>Searching…</span>';
    });
  }

  function resetBoxesToNoData() {
    Object.values(boxes).forEach((el) => {
      el.textContent = "No Data Collected";
    });
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
          ? `<a href="${url}" target="_blank" rel="noopener noreferrer">Visit</a>`
          : "N/A";
        return `<tr><td>${name}</td><td>${link}</td></tr>`;
      })
      .join("");
    el.innerHTML = `
      <table>
        <thead><tr><th>Name</th><th>Link</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
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

      renderResults(payload);
      lastSubmittedKey = key;
    } catch (err) {
      resetBoxesToNoData();
      showAlert("Could not reach the backend. Please try again.");
    } finally {
      submitBtn.disabled = false;
    }
  });

  savePdfBtn.addEventListener("click", async function () {
    const { jsPDF } = window.jspdf;
    const target = document.querySelector(".page");
    savePdfBtn.disabled = true;
    savePdfBtn.textContent = "Preparing PDF…";
    try {
      const canvas = await html2canvas(target, { scale: 2, backgroundColor: "#f7f7f8" });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF({ orientation: "portrait", unit: "pt", format: "a4" });
      const pageWidth = pdf.internal.pageSize.getWidth();
      const pageHeight = pdf.internal.pageSize.getHeight();
      const imgWidth = pageWidth;
      const imgHeight = (canvas.height * imgWidth) / canvas.width;

      let heightLeft = imgHeight;
      let position = 0;

      pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
      heightLeft -= pageHeight;

      while (heightLeft > 0) {
        position = heightLeft - imgHeight;
        pdf.addPage();
        pdf.addImage(imgData, "PNG", 0, position, imgWidth, imgHeight);
        heightLeft -= pageHeight;
      }

      pdf.save("syndication-event-finder.pdf");
    } catch (err) {
      showAlert("Could not generate the PDF. Please try again.");
    } finally {
      savePdfBtn.disabled = false;
      savePdfBtn.textContent = "Create PDF";
    }
  });
})();
