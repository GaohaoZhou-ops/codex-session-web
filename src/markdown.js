import { Marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { icon } from './icons.js';

for (const [name, language] of Object.entries({ bash, cpp, css, diff, javascript, json, python, sql, typescript, xml, yaml })) hljs.registerLanguage(name, language);

export const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const isLocalPath = (href) => /^(?:\/(?!\/)|\.{1,2}\/|[a-zA-Z]:[\\/]|file:\/\/)/.test(href);
const isExternalLink = (href) => /^(?:https?:\/\/|mailto:)/i.test(href);

const markdown = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang || 'text').split(/\s+/)[0].toLowerCase();
      let code = escapeHTML(text);
      if (text.length < 50000 && hljs.getLanguage(language)) {
        try { code = hljs.highlight(text, { language, ignoreIllegals: true }).value; } catch { /* Keep escaped plain text. */ }
      }
      return `<div class="code-block"><div class="code-toolbar"><span>${escapeHTML(language)}</span><button type="button" class="copy-code" data-copy-code aria-label="复制代码">复制代码</button></div><pre><code class="hljs">${code}</code></pre></div>`;
    },
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (isLocalPath(href)) return `<button type="button" class="source-link" data-source-path="${escapeHTML(href)}" title="${escapeHTML(href)} · 点击复制路径">${label}</button>`;
      if (isExternalLink(href)) return `<a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escapeHTML(title)}"` : ''}>${label}</a>`;
      if (href.startsWith('#')) return `<a href="${escapeHTML(href)}">${label}</a>`;
      // Relative code references are useful to copy, even without a leading ./.
      if (!/^[\w+.-]+:/.test(href) && !href.startsWith('//')) return `<button type="button" class="source-link" data-source-path="${escapeHTML(href)}" title="点击复制路径">${label}</button>`;
      return label;
    },
    image({ href, text }) {
      // Do not load remote images automatically while reading private exports.
      const link = isExternalLink(href) ? ` <a href="${escapeHTML(href)}" target="_blank" rel="noopener noreferrer">打开图片 ↗</a>` : '';
      return `<span class="image-reference">[图片：${escapeHTML(text || '未命名')}]${link}</span>`;
    },
  },
});

export function renderMarkdown(content) {
  const fragment = DOMPurify.sanitize(markdown.parse(content), {
    RETURN_DOM_FRAGMENT: true,
    USE_PROFILES: { html: true },
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'form', 'input', 'textarea', 'select', 'img', 'video', 'audio', 'source', 'link', 'meta'],
    FORBID_ATTR: ['style', 'srcset', 'autofocus'],
    ADD_ATTR: ['target'],
  });
  for (const link of fragment.querySelectorAll('a')) {
    const href = link.getAttribute('href') || '';
    if (isExternalLink(href)) {
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
    } else if (!href.startsWith('#')) {
      link.removeAttribute('href');
    }
  }
  for (const table of fragment.querySelectorAll('table')) {
    const wrapper = document.createElement('div');
    wrapper.className = 'table-scroll';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('aria-label', '表格，可横向滚动');
    table.replaceWith(wrapper);
    wrapper.append(table);
  }
  for (const button of fragment.querySelectorAll('.copy-code')) button.insertAdjacentHTML('afterbegin', icon('copy'));
  return fragment;
}

export function highlightMatches(container, query) {
  for (const mark of container.querySelectorAll('mark.search-highlight')) mark.replaceWith(document.createTextNode(mark.textContent));
  container.normalize();
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) { return node.parentElement.closest('.code-toolbar') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let count = 0;
  for (const node of nodes) {
    const text = node.textContent;
    const lower = text.toLocaleLowerCase();
    let position = 0;
    let index = lower.indexOf(needle);
    if (index === -1) continue;
    const fragment = document.createDocumentFragment();
    while (index !== -1 && count < 500) {
      fragment.append(text.slice(position, index));
      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = text.slice(index, index + needle.length);
      fragment.append(mark);
      position = index + needle.length;
      index = lower.indexOf(needle, position);
      count++;
    }
    fragment.append(text.slice(position));
    node.replaceWith(fragment);
    if (count >= 500) break;
  }
}
