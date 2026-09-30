/* PNG export — no dependencies. Clones a DOM node with computed styles inlined,
   wraps it in an SVG <foreignObject>, and rasterises it on a canvas. */
(function () {
  'use strict';

  var SKIP = '[data-png-skip]';
  var MIN_WIDTH = 1400;

  function inlineStyles(src, dst) {
    var cs = window.getComputedStyle(src);
    var text = '';
    for (var i = 0; i < cs.length; i++) {
      var p = cs[i];
      text += p + ':' + cs.getPropertyValue(p) + ';';
    }
    dst.setAttribute('style', text);
    var sk = src.children, dk = dst.children;
    for (var j = 0; j < sk.length; j++) inlineStyles(sk[j], dk[j]);
  }

  function slug(s) {
    return String(s || 'report').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'report';
  }

  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('Could not render image')); };
      img.src = url;
    });
  }

  /** Render `node` to a PNG and trigger a download. Always exported in the light theme. */
  async function downloadPng(node, filename, onClone) {
    var root = document.documentElement;
    var prevTheme = root.getAttribute('data-theme');
    var prevWidth = node.style.width, prevMax = node.style.maxWidth;
    var clone, w, h, bg, pad = 24;
    // Temporarily reflow the live DOM in export mode: light theme, wide layout (no scrolling
    // panes), then restore. Computed styles are inlined synchronously before restoring.
    if (prevTheme) root.removeAttribute('data-theme');
    root.classList.add('png-export');
    try {
      var natural = Math.ceil(node.getBoundingClientRect().width);
      node.style.maxWidth = 'none';
      node.style.width = Math.max(natural, MIN_WIDTH) + 'px';
      await new Promise(function (r) { requestAnimationFrame(function () { requestAnimationFrame(r); }); });
      w = Math.ceil(node.getBoundingClientRect().width);
      clone = node.cloneNode(true);
      inlineStyles(node, clone);
      bg = window.getComputedStyle(document.body).backgroundColor;
    } finally {
      node.style.width = prevWidth;
      node.style.maxWidth = prevMax;
      root.classList.remove('png-export');
      if (prevTheme) root.setAttribute('data-theme', prevTheme);
    }
    clone.querySelectorAll(SKIP).forEach(function (el) { el.remove(); });
    if (onClone) onClone(clone);
    clone.style.width = w + 'px';
    clone.style.margin = '0';
    clone.style.position = 'static';

    var wrap = document.createElement('div');
    wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    wrap.setAttribute('style', 'box-sizing:border-box;padding:' + pad + 'px;background:' + bg +
      ';width:' + (w + pad * 2) + 'px;font-family:' + window.getComputedStyle(document.body).fontFamily + ';');
    wrap.appendChild(clone);

    // measure the wrapped height off-screen
    var probe = wrap.cloneNode(true);
    probe.style.position = 'fixed';
    probe.style.left = '-99999px';
    probe.style.top = '0';
    document.body.appendChild(probe);
    h = Math.ceil(probe.getBoundingClientRect().height);
    probe.remove();

    var totalW = w + pad * 2;
    var xml = new XMLSerializer().serializeToString(wrap);
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + totalW + '" height="' + h + '">' +
      '<foreignObject width="100%" height="100%">' + xml + '</foreignObject></svg>';
    var img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));

    var scale = Math.min(2, 16000 / h, 16000 / totalW);
    var canvas = document.createElement('canvas');
    canvas.width = Math.floor(totalW * scale);
    canvas.height = Math.floor(h * scale);
    var ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    ctx.drawImage(img, 0, 0, totalW, h);

    var blob = await new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('PNG encoding failed')); }, 'image/png');
    });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = slug(filename) + '.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  window.ReporterPng = { download: downloadPng };
})();
