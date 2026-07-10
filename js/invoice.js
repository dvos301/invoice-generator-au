/* ============================================================
   Invoice generator engine — invoice-generator.com.au
   Reads per-page defaults from window.INVOICE_CONFIG.
   ============================================================ */

(function () {
  "use strict";

  var CFG = Object.assign({
    storageKey: "invoice-generator-data",
    currency: "AUD",
    docTitle: "INVOICE",
    taxLabel: "Tax",
    taxRate: 0,
    taxInclusive: false,
    showAbn: false,
    numberPrefix: "INV-"
  }, window.INVOICE_CONFIG || {});

  var CURRENCIES = [
    ["AUD", "$", "Australian Dollar"],
    ["USD", "$", "US Dollar"],
    ["EUR", "€", "Euro"],
    ["GBP", "£", "British Pound"],
    ["NZD", "$", "New Zealand Dollar"],
    ["CAD", "$", "Canadian Dollar"],
    ["SGD", "$", "Singapore Dollar"],
    ["JPY", "¥", "Japanese Yen"],
    ["INR", "Rs ", "Indian Rupee"],
    ["ZAR", "R ", "South African Rand"],
    ["HKD", "$", "Hong Kong Dollar"],
    ["CHF", "CHF ", "Swiss Franc"],
    ["AED", "AED ", "UAE Dirham"],
    ["PHP", "PHP ", "Philippine Peso"],
    ["FJD", "$", "Fijian Dollar"]
  ];

  var ZERO_DECIMAL = { JPY: true };

  var $ = function (sel) { return document.querySelector(sel); };
  var $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  var logoDataUrl = null;
  var saveTimer = null;

  /* ---------- helpers ---------- */

  function currencySymbol(code) {
    for (var i = 0; i < CURRENCIES.length; i++) {
      if (CURRENCIES[i][0] === code) return CURRENCIES[i][1];
    }
    return code + " ";
  }

  function money(n) {
    var code = $("#currency").value;
    var decimals = ZERO_DECIMAL[code] ? 0 : 2;
    var fixed = Math.abs(n).toFixed(decimals);
    var parts = fixed.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    var out = currencySymbol(code) + parts.join(".");
    return (n < 0 ? "−" : "") + out;
  }

  function num(v) {
    var n = parseFloat(String(v).replace(/,/g, ""));
    return isFinite(n) ? n : 0;
  }

  function todayISO(offsetDays) {
    var d = new Date();
    if (offsetDays) d.setDate(d.getDate() + offsetDays);
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function formatDate(iso) {
    if (!iso) return "";
    var parts = iso.split("-");
    if (parts.length !== 3) return iso;
    var months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return parseInt(parts[2], 10) + " " + months[parseInt(parts[1], 10) - 1] + " " + parts[0];
  }

  /* ---------- line items ---------- */

  function addItemRow(item) {
    item = item || { desc: "", qty: 1, rate: "" };
    var tbody = $("#items-body");
    var tr = document.createElement("tr");
    tr.innerHTML =
      '<td><input type="text" class="i-desc" placeholder="Description of service or product" aria-label="Item description"></td>' +
      '<td class="col-qty"><input type="number" class="i-qty" min="0" step="any" aria-label="Quantity"></td>' +
      '<td class="col-rate"><input type="number" class="i-rate" min="0" step="any" placeholder="0.00" aria-label="Rate"></td>' +
      '<td class="col-amount i-amount">' + money(0) + "</td>" +
      '<td class="col-del"><button type="button" class="row-del" title="Remove line" aria-label="Remove line">×</button></td>';
    tr.querySelector(".i-desc").value = item.desc;
    tr.querySelector(".i-qty").value = item.qty;
    tr.querySelector(".i-rate").value = item.rate;
    tr.querySelector(".row-del").addEventListener("click", function () {
      tr.remove();
      if (!$("#items-body").children.length) addItemRow();
      recalc();
    });
    tbody.appendChild(tr);
  }

  function getItems() {
    return $$("#items-body tr").map(function (tr) {
      return {
        desc: tr.querySelector(".i-desc").value,
        qty: tr.querySelector(".i-qty").value,
        rate: tr.querySelector(".i-rate").value
      };
    });
  }

  /* ---------- totals ---------- */

  function computeTotals() {
    var subtotal = 0;
    $$("#items-body tr").forEach(function (tr) {
      var amount = num(tr.querySelector(".i-qty").value) * num(tr.querySelector(".i-rate").value);
      tr.querySelector(".i-amount").textContent = money(amount);
      subtotal += amount;
    });

    var discountValue = num($("#discount-value").value);
    var discountType = $("#discount-type").value;
    var discount = discountType === "percent" ? subtotal * discountValue / 100 : discountValue;
    if (discount > subtotal) discount = subtotal;

    var taxable = subtotal - discount;
    var rate = num($("#tax-rate").value) / 100;
    var inclusive = $("#tax-inclusive").checked;
    var tax, total;
    var shipping = num($("#shipping").value);

    if (inclusive) {
      tax = rate > 0 ? taxable - taxable / (1 + rate) : 0;
      total = taxable + shipping;
    } else {
      tax = taxable * rate;
      total = taxable + tax + shipping;
    }

    var paid = num($("#amount-paid").value);
    var balance = total - paid;

    return {
      subtotal: subtotal, discount: discount, tax: tax, shipping: shipping,
      total: total, paid: paid, balance: balance, inclusive: inclusive,
      rate: num($("#tax-rate").value), discountType: discountType, discountValue: discountValue
    };
  }

  function recalc() {
    var t = computeTotals();
    $("#v-subtotal").textContent = money(t.subtotal);
    $("#v-discount").textContent = t.discount ? "−" + money(t.discount) : money(0);
    $("#v-tax").textContent = money(t.tax);
    $("#v-shipping").textContent = money(t.shipping);
    $("#v-total").textContent = money(t.total);
    $("#v-balance").textContent = money(t.balance);
    $("#tax-mode-note").textContent = t.inclusive ? "(included in prices)" : "";
    if (CFG.atoChecklist) updateAtoChecklist(t);
    scheduleSave();
  }

  /* ---------- ATO tax invoice compliance checklist (AU page) ---------- */

  function setCheck(id, state, note) {
    var li = document.getElementById(id);
    if (!li) return;
    li.classList.remove("ok", "todo", "na");
    li.classList.add(state);
    var noteEl = li.querySelector(".check-note");
    if (noteEl) noteEl.textContent = note || "";
  }

  function updateAtoChecklist(t) {
    var title = ($("#doc-title").value || "").toLowerCase();
    setCheck("ck-title", title.indexOf("tax invoice") !== -1 ? "ok" : "todo");

    setCheck("ck-seller", $("#from-name").value.trim() ? "ok" : "todo");

    var abn = ($("#abn").value || "").replace(/\s+/g, "");
    setCheck("ck-abn", /^\d{11}$/.test(abn) ? "ok" : "todo",
      abn && !/^\d{11}$/.test(abn) ? "ABN should be 11 digits" : "");

    setCheck("ck-date", $("#issue-date").value ? "ok" : "todo");

    var hasItem = $$("#items-body tr").some(function (tr) {
      return tr.querySelector(".i-desc").value.trim() &&
        num(tr.querySelector(".i-qty").value) * num(tr.querySelector(".i-rate").value) > 0;
    });
    setCheck("ck-items", hasItem ? "ok" : "todo");

    var gstShown = t.rate > 0;
    setCheck("ck-gst", gstShown ? "ok" : "todo",
      gstShown ? (t.inclusive ? "Shown as included in prices" : "") : "Set GST to 10% (or note if not registered)");

    if (t.total >= 1000) {
      setCheck("ck-buyer", $("#to-name").value.trim() ? "ok" : "todo",
        "Required — this invoice is $1,000 or more");
    } else {
      setCheck("ck-buyer", "na", "Only required for invoices of $1,000+");
    }
  }

  /* ---------- persistence ---------- */

  function collectState() {
    return {
      logo: logoDataUrl,
      docTitle: $("#doc-title").value,
      number: $("#inv-number").value,
      fromName: $("#from-name").value,
      fromDetails: $("#from-details").value,
      abn: CFG.showAbn ? $("#abn").value : "",
      toName: $("#to-name").value,
      toDetails: $("#to-details").value,
      issueDate: $("#issue-date").value,
      dueDate: $("#due-date").value,
      reference: $("#reference").value,
      items: getItems(),
      notes: $("#notes").value,
      terms: $("#terms").value,
      payDetails: $("#pay-details").value,
      discountValue: $("#discount-value").value,
      discountType: $("#discount-type").value,
      taxLabel: $("#tax-label").value,
      taxRate: $("#tax-rate").value,
      taxInclusive: $("#tax-inclusive").checked,
      shipping: $("#shipping").value,
      amountPaid: $("#amount-paid").value,
      currency: $("#currency").value
    };
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      try {
        localStorage.setItem(CFG.storageKey, JSON.stringify(collectState()));
        var note = $("#autosave-note");
        if (note) note.textContent = "Saved automatically in your browser";
      } catch (e) { /* storage full or blocked — non-fatal */ }
    }, 400);
  }

  function restoreState() {
    var raw = null;
    try { raw = localStorage.getItem(CFG.storageKey); } catch (e) {}
    if (!raw) return false;
    var s;
    try { s = JSON.parse(raw); } catch (e) { return false; }

    if (s.logo) setLogo(s.logo);
    $("#doc-title").value = s.docTitle || CFG.docTitle;
    $("#inv-number").value = s.number || CFG.numberPrefix + "0001";
    $("#from-name").value = s.fromName || "";
    $("#from-details").value = s.fromDetails || "";
    if (CFG.showAbn) $("#abn").value = s.abn || "";
    $("#to-name").value = s.toName || "";
    $("#to-details").value = s.toDetails || "";
    $("#issue-date").value = s.issueDate || todayISO();
    $("#due-date").value = s.dueDate || "";
    $("#reference").value = s.reference || "";
    $("#notes").value = s.notes || "";
    $("#terms").value = s.terms || "";
    $("#pay-details").value = s.payDetails || "";
    $("#discount-value").value = s.discountValue || "";
    $("#discount-type").value = s.discountType || "percent";
    $("#tax-label").value = s.taxLabel || CFG.taxLabel;
    $("#tax-rate").value = (s.taxRate !== undefined && s.taxRate !== "") ? s.taxRate : CFG.taxRate;
    $("#tax-inclusive").checked = !!s.taxInclusive;
    $("#shipping").value = s.shipping || "";
    $("#amount-paid").value = s.amountPaid || "";
    if (s.currency) $("#currency").value = s.currency;

    $("#items-body").innerHTML = "";
    (s.items && s.items.length ? s.items : [null]).forEach(function (it) { addItemRow(it || undefined); });
    return true;
  }

  function nextInvoiceNumber(current) {
    var m = String(current || "").match(/^(.*?)(\d+)\s*$/);
    if (!m) return CFG.numberPrefix + "0001";
    var next = String(parseInt(m[2], 10) + 1);
    while (next.length < m[2].length) next = "0" + next;
    return m[1] + next;
  }

  function newInvoice() {
    var keepNumber = nextInvoiceNumber($("#inv-number").value);
    $("#inv-number").value = keepNumber;
    $("#to-name").value = "";
    $("#to-details").value = "";
    $("#issue-date").value = todayISO();
    $("#due-date").value = "";
    $("#reference").value = "";
    $("#discount-value").value = "";
    $("#shipping").value = "";
    $("#amount-paid").value = "";
    $("#items-body").innerHTML = "";
    addItemRow();
    recalc();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ---------- logo ---------- */

  function setLogo(dataUrl) {
    logoDataUrl = dataUrl;
    var drop = $("#logo-drop");
    var img = $("#logo-img");
    img.src = dataUrl;
    drop.classList.add("has-logo");
  }

  function clearLogo() {
    logoDataUrl = null;
    $("#logo-img").removeAttribute("src");
    $("#logo-drop").classList.remove("has-logo");
    scheduleSave();
  }

  function handleLogoFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    var reader = new FileReader();
    reader.onload = function (e) {
      // downscale large images so localStorage + PDF stay small
      var image = new Image();
      image.onload = function () {
        var max = 600;
        var scale = Math.min(1, max / Math.max(image.width, image.height));
        var canvas = document.createElement("canvas");
        canvas.width = Math.round(image.width * scale);
        canvas.height = Math.round(image.height * scale);
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        setLogo(canvas.toDataURL("image/png"));
        scheduleSave();
      };
      image.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  /* ---------- PDF ---------- */

  function downloadPDF() {
    var jsPDFCtor = window.jspdf && window.jspdf.jsPDF;
    if (!jsPDFCtor) { window.print(); return; }

    var t = computeTotals();
    // helvetica has no U+2212 minus — swap for ASCII hyphen in PDF text
    var pmoney = function (v) { return money(v).replace(/−/g, "-"); };
    var doc = new jsPDFCtor({ unit: "mm", format: "a4" });
    var PW = 210, MARGIN = 16, RIGHT = PW - MARGIN;
    var y = 18;
    var accent = [16, 113, 90];
    var ink = [23, 37, 46];
    var soft = [90, 105, 115];
    var faint = [150, 162, 170];

    function checkPage(needed) {
      if (y + needed > 282) { doc.addPage(); y = 18; }
    }

    function splitText(text, width) {
      return doc.splitTextToSize(String(text || ""), width);
    }

    /* header: logo + title */
    var headerBottom = y;
    if (logoDataUrl) {
      try {
        var props = doc.getImageProperties(logoDataUrl);
        var maxW = 52, maxH = 24;
        var s = Math.min(maxW / props.width, maxH / props.height);
        var w = props.width * s, h = props.height * s;
        doc.addImage(logoDataUrl, "PNG", MARGIN, y, w, h);
        headerBottom = Math.max(headerBottom, y + h);
      } catch (e) { /* bad image data — skip logo */ }
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(26);
    doc.setTextColor(ink[0], ink[1], ink[2]);
    doc.text(($("#doc-title").value || "INVOICE").toUpperCase(), RIGHT, y + 8, { align: "right" });
    doc.setFontSize(11);
    doc.setTextColor(soft[0], soft[1], soft[2]);
    doc.setFont("helvetica", "normal");
    doc.text("# " + ($("#inv-number").value || ""), RIGHT, y + 15, { align: "right" });
    headerBottom = Math.max(headerBottom, y + 15);

    y = headerBottom + 12;

    /* from / to / meta */
    function block(label, name, details, x, width) {
      var startY = y;
      doc.setFontSize(8);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(faint[0], faint[1], faint[2]);
      doc.text(label.toUpperCase(), x, startY);
      var yy = startY + 5;
      doc.setFontSize(10.5);
      doc.setTextColor(ink[0], ink[1], ink[2]);
      if (name) {
        doc.text(splitText(name, width), x, yy);
        yy += splitText(name, width).length * 4.6 + 0.8;
      }
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(soft[0], soft[1], soft[2]);
      if (details) {
        var lines = splitText(details, width);
        doc.text(lines, x, yy);
        yy += lines.length * 4.4;
      }
      return yy;
    }

    var colW = 58;
    var fromDetails = $("#from-details").value;
    if (CFG.showAbn && $("#abn").value.trim()) {
      fromDetails = "ABN: " + $("#abn").value.trim() + (fromDetails ? "\n" + fromDetails : "");
    }
    var y1 = block("From", $("#from-name").value, fromDetails, MARGIN, colW);
    var y2 = block("Bill To", $("#to-name").value, $("#to-details").value, MARGIN + colW + 10, colW);

    /* meta block right */
    var metaX = RIGHT - 52;
    var metaY = y;
    function metaRow(label, value) {
      if (!value) return;
      doc.setFontSize(9);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(faint[0], faint[1], faint[2]);
      doc.text(label, metaX, metaY);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(ink[0], ink[1], ink[2]);
      doc.text(String(value), RIGHT, metaY, { align: "right" });
      metaY += 5.4;
    }
    metaRow("Issue date", formatDate($("#issue-date").value));
    metaRow("Due date", formatDate($("#due-date").value));
    metaRow("Reference", $("#reference").value);

    y = Math.max(y1, y2, metaY) + 8;

    /* items table */
    var qtyX = 132, rateX = 158, amtX = RIGHT;
    var descW = qtyX - MARGIN - 8;

    function tableHead() {
      doc.setFillColor(ink[0], ink[1], ink[2]);
      doc.roundedRect(MARGIN, y, PW - MARGIN * 2, 8, 1.2, 1.2, "F");
      doc.setFontSize(8.5);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(255, 255, 255);
      doc.text("DESCRIPTION", MARGIN + 3, y + 5.4);
      doc.text("QTY", qtyX, y + 5.4, { align: "right" });
      doc.text("RATE", rateX, y + 5.4, { align: "right" });
      doc.text("AMOUNT", amtX - 3, y + 5.4, { align: "right" });
      y += 12;
    }

    tableHead();

    $$("#items-body tr").forEach(function (tr) {
      var desc = tr.querySelector(".i-desc").value;
      var qty = tr.querySelector(".i-qty").value;
      var rate = num(tr.querySelector(".i-rate").value);
      var amount = num(qty) * rate;
      if (!desc && !amount) return;
      var lines = splitText(desc || "—", descW);
      var rowH = Math.max(lines.length * 4.4, 5);
      checkPage(rowH + 6);
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9.5);
      doc.setTextColor(ink[0], ink[1], ink[2]);
      doc.text(lines, MARGIN + 3, y);
      doc.setTextColor(soft[0], soft[1], soft[2]);
      doc.text(String(qty || 0), qtyX, y, { align: "right" });
      doc.text(pmoney(rate), rateX, y, { align: "right" });
      doc.setTextColor(ink[0], ink[1], ink[2]);
      doc.text(pmoney(amount), amtX - 3, y, { align: "right" });
      y += rowH + 2.5;
      doc.setDrawColor(232, 238, 241);
      doc.setLineWidth(0.2);
      doc.line(MARGIN, y - 1.2, RIGHT, y - 1.2);
      y += 2.5;
    });

    y += 4;
    checkPage(70);

    /* totals right, notes left */
    var totalsX = 128, totalsRight = RIGHT;
    var ty = y;

    function totalRow(label, value, opts) {
      opts = opts || {};
      doc.setFontSize(opts.big ? 11.5 : 9.5);
      doc.setFont("helvetica", opts.big ? "bold" : "normal");
      var c = opts.big ? ink : soft;
      doc.setTextColor(c[0], c[1], c[2]);
      doc.text(label, totalsX, ty);
      doc.setFont("helvetica", "bold");
      if (opts.accent) doc.setTextColor(accent[0], accent[1], accent[2]);
      else doc.setTextColor(ink[0], ink[1], ink[2]);
      doc.text(value, totalsRight, ty, { align: "right" });
      ty += opts.big ? 8 : 6;
    }

    totalRow("Subtotal", pmoney(t.subtotal));
    if (t.discount > 0) {
      totalRow("Discount" + (t.discountType === "percent" ? " (" + t.discountValue + "%)" : ""), "-" + pmoney(t.discount));
    }
    var taxLabel = ($("#tax-label").value || "Tax") + (t.rate ? " (" + t.rate + "%" + (t.inclusive ? " incl." : "") + ")" : "");
    if (t.tax > 0 || t.rate > 0) totalRow(taxLabel, pmoney(t.tax));
    if (t.shipping > 0) totalRow("Shipping", pmoney(t.shipping));

    doc.setDrawColor(ink[0], ink[1], ink[2]);
    doc.setLineWidth(0.5);
    doc.line(totalsX, ty - 2.5, totalsRight, ty - 2.5);
    ty += 2;
    totalRow("Total", pmoney(t.total), { big: true });
    if (t.paid > 0) {
      totalRow("Amount paid", "-" + pmoney(t.paid));
      totalRow("Balance due", pmoney(t.balance), { big: true, accent: true });
    }

    /* notes / terms / payment details on the left */
    var ny = y;
    function noteBlock(label, text) {
      if (!text || !text.trim()) return;
      var lines = splitText(text, 100);
      doc.setFontSize(8);
      doc.setFont("helvetica", "bold");
      doc.setTextColor(faint[0], faint[1], faint[2]);
      doc.text(label.toUpperCase(), MARGIN, ny);
      ny += 4.6;
      doc.setFontSize(9);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(soft[0], soft[1], soft[2]);
      doc.text(lines, MARGIN, ny);
      ny += lines.length * 4.2 + 6;
    }
    noteBlock("Payment details", $("#pay-details").value);
    noteBlock("Notes", $("#notes").value);
    noteBlock("Terms", $("#terms").value);

    /* footer */
    var pages = doc.getNumberOfPages();
    for (var p = 1; p <= pages; p++) {
      doc.setPage(p);
      doc.setFontSize(8);
      doc.setFont("helvetica", "normal");
      doc.setTextColor(faint[0], faint[1], faint[2]);
      doc.text("Created free with invoice-generator.com.au", MARGIN, 291);
      if (pages > 1) doc.text("Page " + p + " of " + pages, RIGHT, 291, { align: "right" });
    }

    var numPart = ($("#inv-number").value || "invoice").replace(/[^\w\-]+/g, "-");
    doc.save("Invoice-" + numPart + ".pdf");

    track("invoice_pdf_download", { page: CFG.storageKey });
    showSonicToast();
  }

  /* ---------- InvoiceSonic cross-promo ---------- */

  var SONIC_URL = "https://invoicesonic.com/";

  function sonicLink(placement) {
    return SONIC_URL + "?utm_source=invoice-generator.com.au&utm_medium=referral&utm_campaign=" + placement;
  }

  function track(name, params) {
    if (typeof window.gtag === "function") window.gtag("event", name, params || {});
  }

  function showSonicToast() {
    if (document.querySelector(".sonic-toast")) return;
    var el = document.createElement("div");
    el.className = "sonic-toast";
    el.setAttribute("role", "status");
    el.innerHTML =
      '<button type="button" class="st-close" aria-label="Dismiss">×</button>' +
      '<div class="st-head"><span class="tick">✓</span> Invoice downloaded</div>' +
      "<p>Now send it, track the payment, and auto-remind late payers — free with <strong>InvoiceSonic</strong>, our full invoicing app.</p>" +
      '<a class="btn btn-primary" target="_blank" rel="noopener" href="' + sonicLink("post_download") + '">Try InvoiceSonic free</a>';
    el.querySelector(".st-close").addEventListener("click", function () { el.remove(); });
    el.querySelector("a").addEventListener("click", function () {
      track("sonic_click", { placement: "post_download" });
    });
    document.body.appendChild(el);
    setTimeout(function () { if (el.parentNode) el.remove(); }, 30000);
  }

  function wireSonicLinks() {
    $$("[data-sonic]").forEach(function (a) {
      var placement = a.getAttribute("data-sonic");
      a.href = sonicLink(placement);
      a.addEventListener("click", function () { track("sonic_click", { placement: placement }); });
    });
  }

  /* ---------- init ---------- */

  function init() {
    /* currency options */
    var sel = $("#currency");
    CURRENCIES.forEach(function (c) {
      var opt = document.createElement("option");
      opt.value = c[0];
      opt.textContent = c[0] + " — " + c[2];
      sel.appendChild(opt);
    });
    sel.value = CFG.currency;

    var restored = restoreState();
    if (!restored) {
      $("#doc-title").value = CFG.docTitle;
      $("#inv-number").value = CFG.numberPrefix + "0001";
      $("#issue-date").value = todayISO();
      $("#tax-label").value = CFG.taxLabel;
      $("#tax-rate").value = CFG.taxRate;
      $("#tax-inclusive").checked = CFG.taxInclusive;
      addItemRow();
    }

    /* events — recalc + autosave on any input */
    document.addEventListener("input", function (e) {
      if (e.target.closest(".invoice-paper") || e.target.closest(".side-panel")) recalc();
    });
    document.addEventListener("change", function (e) {
      if (e.target.closest(".invoice-paper") || e.target.closest(".side-panel")) recalc();
    });

    $("#add-item").addEventListener("click", function () { addItemRow(); recalc(); });

    /* logo */
    var drop = $("#logo-drop");
    var fileInput = $("#logo-file");
    drop.addEventListener("click", function (e) {
      if (e.target.classList.contains("logo-remove")) return;
      fileInput.click();
    });
    fileInput.addEventListener("change", function () { handleLogoFile(fileInput.files[0]); fileInput.value = ""; });
    drop.addEventListener("dragover", function (e) { e.preventDefault(); drop.classList.add("dragover"); });
    drop.addEventListener("dragleave", function () { drop.classList.remove("dragover"); });
    drop.addEventListener("drop", function (e) {
      e.preventDefault();
      drop.classList.remove("dragover");
      if (e.dataTransfer.files.length) handleLogoFile(e.dataTransfer.files[0]);
    });
    $(".logo-remove").addEventListener("click", clearLogo);

    /* actions */
    $$(".js-download").forEach(function (b) { b.addEventListener("click", downloadPDF); });
    var printBtn = $("#btn-print");
    if (printBtn) printBtn.addEventListener("click", function () { window.print(); });
    var newBtn = $("#btn-new");
    if (newBtn) newBtn.addEventListener("click", function () {
      if (confirm("Start a new invoice? Your business details and settings are kept; client and line items are cleared.")) newInvoice();
    });

    wireSonicLinks();
    recalc();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
