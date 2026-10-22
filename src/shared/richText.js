// Formatted messages. A message's TextStyle column holds HTML: the mobile
// app's editor writes real formatting there, and the web's rich mode sends
// it as Html (stored in TextStyle). Everything shown or sent goes through
// DOMPurify with a short allow-list -- no scripts, styles, images or
// event handlers -- so a message can only format text.
import DOMPurify from 'dompurify';

const SHOW = {
  ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'br', 'p', 'div', 'span', 'ul', 'ol', 'li',
    'h1', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr'],
  ALLOWED_ATTR: ['href', 'border', 'colspan', 'rowspan'],
  ALLOWED_URI_REGEXP: /^(https?:|mailto:|tel:)/i,
};
// what the web composer itself produces (a smaller set)
const SEND = {
  ALLOWED_TAGS: ['b', 'strong', 'i', 'em', 'u', 's', 'strike', 'br', 'p', 'div', 'ul', 'ol', 'li', 'h3', 'blockquote'],
  ALLOWED_ATTR: [],
};

// links open in a new tab, without access to this page
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

export const sanitizeForShow = (html) => DOMPurify.sanitize(String(html || ''), SHOW);
export const sanitizeForSend = (html) => DOMPurify.sanitize(String(html || ''), SEND);

// TextStyle that only escapes plain text (what plain messages store) has no
// formatting tags; real formatting does.
const FORMAT_TAG = /<(b|strong|i|em|u|s|strike|ul|ol|li|h[1-6]|blockquote|pre|code|a|table|p)[\s>/]/i;
export const hasFormatting = (html) => FORMAT_TAG.test(String(html || ''));

// The plain text of formatted HTML (what goes in Text): line breaks kept,
// bullets as "• ".
export function toPlainText(html) {
  const box = document.createElement('div');
  box.innerHTML = sanitizeForSend(html)
    .replace(/<(div|p|ul|ol|blockquote|h3)(\s[^>]*)?>/gi, '\n<$1>')   // a block starts on its own line
    .replace(/<li[^>]*>/gi, '<li>• ')
    .replace(/<\/(p|div|li|h3|blockquote)>/gi, '</$1>\n')
    .replace(/<br\s*\/?>/gi, '\n');
  return (box.textContent || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
