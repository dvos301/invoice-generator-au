/* Blog post enhancements: reading-progress bar, auto table of contents,
   and author box. Progressive — the article is fully readable without it. */
(function () {
  "use strict";

  // reading progress bar
  var bar = document.createElement("div");
  bar.className = "read-progress";
  document.body.appendChild(bar);
  function onScroll() {
    var doc = document.documentElement;
    var scrolled = doc.scrollTop || document.body.scrollTop;
    var height = (doc.scrollHeight || document.body.scrollHeight) - doc.clientHeight;
    bar.style.width = (height > 0 ? (scrolled / height) * 100 : 0) + "%";
  }
  document.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  var article = document.querySelector(".content.article");
  if (!article) return;

  // build a table of contents from the section headings
  var heads = [].slice.call(article.querySelectorAll("h2")).filter(function (h) {
    var t = h.textContent.toLowerCase();
    return t.indexOf("frequently asked") === -1 && t.indexOf("faq") === -1;
  });

  if (heads.length >= 3) {
    var toc = document.createElement("nav");
    toc.className = "toc";
    toc.setAttribute("aria-label", "Table of contents");
    var items = "";
    heads.forEach(function (h, i) {
      if (!h.id) {
        h.id = "s" + i + "-" + h.textContent.toLowerCase()
          .replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40);
      }
      items += '<li><a href="#' + h.id + '">' + h.textContent + "</a></li>";
    });
    toc.innerHTML = '<p class="toc-title">In this article</p><ol class="toc-list">' + items + "</ol>";
    heads[0].parentNode.insertBefore(toc, heads[0]);
  }

  // author box, placed just before the closing call-to-action
  var box = document.createElement("div");
  box.className = "author-box";
  box.innerHTML =
    '<span class="post-avatar" aria-hidden="true">IG</span>' +
    "<div><h3>The Invoice-Generator.com.au team</h3>" +
    "<p>We build free, privacy-first invoicing tools for freelancers and small businesses across Australia. " +
    "No signup, no watermarks — your invoice data never leaves your browser.</p></div>";
  var cta = article.querySelector(".cta-band");
  if (cta) article.insertBefore(box, cta);
  else article.appendChild(box);
})();
