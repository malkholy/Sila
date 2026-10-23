// Pasting a table (Excel, Sheets, Word, a web page) into the formatted-text
// editor sends it as a picture, like WhatsApp: the image the source put on the
// clipboard when there is one (Excel on Windows does), else the table's HTML
// drawn to a PNG here. Pasting a plain image (a screenshot) works the same way.

const MAX_SIDE = 8000;   // px, after scaling: bigger tables are scaled down
const SCALE = 2;         // sharp on high-DPI screens

// the clipboard's picture, if any
export function clipboardImage(dt) {
  for (const item of dt?.items || []) {
    if (item.kind === 'file' && /^image\/(png|jpeg)$/.test(item.type)) {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return null;
}

export const hasTable = (html) => /<table[\s>]/i.test(html || '');

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
};
// a named file for the upload ("Table 2026-10-23 14.05.09.png")
export const asImageFile = (blob, base = 'Table') => {
  const type = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  return new File([blob], `${base} ${stamp()}.${type === 'image/jpeg' ? 'jpg' : 'png'}`, { type });
};

// The first table of the pasted HTML, with the source's own styles (Excel's
// cell classes: borders, fills, fonts), laid out in a hidden sandboxed frame
// (no scripts run there), then drawn through an SVG foreignObject onto a
// canvas. Images and links to other files are dropped (they would block the
// canvas). Resolves to a PNG File.
export async function tableToPng(html) {
  const src = new DOMParser().parseFromString(html, 'text/html');
  src.querySelectorAll('script, link, meta, iframe, object, embed, img, picture, video, audio, svg').forEach(n => n.remove());
  const table = src.querySelector('table');
  if (!table) throw new Error('No table.');
  const css = [...src.querySelectorAll('style')].map(s => s.textContent).join('\n')
    .replace(/url\([^)]*\)/gi, 'none').replace(/@import[^;]*;/gi, '');

  const frame = document.createElement('iframe');
  frame.setAttribute('sandbox', 'allow-same-origin');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;left:-30000px;top:0;width:6000px;height:200px;border:0;visibility:hidden';
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    doc.open();
    doc.write('<!doctype html><html><head></head><body></body></html>');
    doc.close();
    const wrap = doc.createElement('div');
    wrap.style.cssText = 'display:inline-block;padding:8px;background:#fff;color:#000;font-family:Calibri,Arial,sans-serif;font-size:11pt';
    const style = doc.createElement('style');
    style.textContent = `table{border-collapse:collapse}td,th{padding:1px 4px;vertical-align:bottom}\n${css}`;
    wrap.appendChild(style);
    wrap.appendChild(doc.importNode(table, true));
    doc.body.style.margin = '0';
    doc.body.appendChild(wrap);
    const rect = wrap.getBoundingClientRect();
    const w = Math.ceil(rect.width), h = Math.ceil(rect.height);
    if (!w || !h) throw new Error('Empty table.');

    wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    const xhtml = new XMLSerializer().serializeToString(wrap);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><foreignObject x="0" y="0" width="${w}" height="${h}">${xhtml}</foreignObject></svg>`;
    const img = new Image();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    await img.decode();

    const scale = Math.min(SCALE, MAX_SIDE / w, MAX_SIDE / h);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(w * scale));
    canvas.height = Math.max(1, Math.round(h * scale));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve, reject) => {
      try { canvas.toBlob(b => (b ? resolve(b) : reject(new Error('Could not draw the table.'))), 'image/png'); }
      catch (err) { reject(err); }   // a browser that blocks foreignObject drawings
    });
    return asImageFile(blob);
  } finally {
    frame.remove();
  }
}
