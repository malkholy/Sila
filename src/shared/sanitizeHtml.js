import DOMPurify from 'dompurify';

// Clean user-authored HTML (PO terms, rich-text fields) before it is put into
// the page. Removes everything that can run code -- <script>, on* event
// handlers (<img onerror=…>), javascript: URLs, <iframe>/<object>/<embed> --
// and form controls, while keeping normal formatting (bold, lists, headings,
// tables, links). Use it at EVERY place saved HTML reaches innerHTML /
// dangerouslySetInnerHTML; a regex that only strips <script> is not enough.
const CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea', 'iframe', 'object', 'embed'],
};

export function sanitizeHtml(html) {
  return DOMPurify.sanitize(String(html ?? ''), CONFIG);
}
