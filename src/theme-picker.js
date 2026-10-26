import { icon } from './icons.js';

// Add themes here and define their palette in styles.css. The preview shares
// those palette variables so it stays in sync with the full-size interface.
const THEMES = [
  { value: 'light', label: '浅色模式', icon: 'sun', description: '明亮底色 · 清新绿调' },
  { value: 'dark', label: '深色模式', icon: 'moon', description: '深色底色 · 柔和绿调' },
  { value: 'dusk', label: '暮色模式', icon: 'sunset', description: '暗色底色 · 彩虹分区' },
];

function themePreview(theme) {
  return `<span class="theme-preview" data-preview-theme="${theme.value}" aria-hidden="true">
    <span class="theme-preview-sidebar"><span class="theme-preview-logo"></span><span></span><span></span><span></span></span>
    <span class="theme-preview-workspace"><span class="theme-preview-topbar"></span><span class="theme-preview-toolbar"><span></span></span><span class="theme-preview-content"><span class="theme-preview-user"></span><span class="theme-preview-reply"><span></span><span></span></span><span class="theme-preview-activity"></span></span></span>
  </span>`;
}

export function themePickerMarkup() {
  return `<div class="theme-select">
    <button class="theme-toggle" id="theme-toggle" type="button" role="combobox" aria-label="界面主题" aria-haspopup="listbox" aria-expanded="false" aria-controls="theme-options"></button>
    <div class="theme-menu" id="theme-options" role="listbox" aria-label="主题选项" hidden>
      ${THEMES.map((theme) => `<button class="theme-option" id="theme-option-${theme.value}" type="button" role="option" data-theme-value="${theme.value}" aria-selected="false" aria-labelledby="theme-name-${theme.value}" aria-describedby="theme-description-${theme.value}" tabindex="-1">
        ${themePreview(theme)}<span class="theme-option-text"><span class="theme-option-name" id="theme-name-${theme.value}">${theme.label}</span><span class="theme-option-description" id="theme-description-${theme.value}">${theme.description}</span></span>${icon('check', 'theme-check')}
      </button>`).join('')}
    </div>
  </div>`;
}

export function setupThemePicker({ storage }) {
  const select = document.querySelector('.theme-select');
  const trigger = document.querySelector('#theme-toggle');
  const menu = document.querySelector('#theme-options');
  const options = [...menu.children];
  const storedTheme = storage.get('theme');
  let current = THEMES.find((theme) => theme.value === storedTheme) || THEMES[0];
  let activeIndex = 0;

  function updateTheme() {
    document.documentElement.dataset.theme = current.value;
    trigger.innerHTML = `${icon(current.icon)}<span>${current.label}</span>${icon('down', 'theme-chevron')}`;
    trigger.title = `当前：${current.label} · 选择主题`;
    for (const option of options) option.setAttribute('aria-selected', String(option.dataset.themeValue === current.value));
  }

  function focusOption(index, scroll = true) {
    activeIndex = (index + options.length) % options.length;
    trigger.setAttribute('aria-activedescendant', options[activeIndex].id);
    for (const [index, option] of options.entries()) option.classList.toggle('is-focused', index === activeIndex);
    if (scroll) options[activeIndex].scrollIntoView({ block: 'nearest' });
  }

  function setOpen(open) {
    menu.hidden = !open;
    trigger.setAttribute('aria-expanded', String(open));
    if (open) focusOption(THEMES.indexOf(current));
    else {
      trigger.removeAttribute('aria-activedescendant');
      for (const option of options) option.classList.remove('is-focused');
    }
  }

  function chooseTheme(index) {
    current = THEMES[index];
    storage.set('theme', current.value);
    updateTheme();
    setOpen(false);
    trigger.focus();
  }

  trigger.addEventListener('click', () => setOpen(menu.hidden));
  trigger.addEventListener('keydown', (event) => {
    const open = !menu.hidden;
    if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      if (!open) setOpen(true);
      if (event.key === 'Home') focusOption(0);
      else if (event.key === 'End') focusOption(options.length - 1);
      else if (open) focusOption(activeIndex + (event.key === 'ArrowDown' ? 1 : -1));
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) chooseTheme(activeIndex);
      else setOpen(true);
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === 'Tab') setOpen(false);
  });
  for (const [index, option] of options.entries()) {
    // Keep mouse and keyboard focus on the combobox, while allowing touch
    // scrolling when the theme collection grows beyond the menu's height.
    option.addEventListener('mousedown', (event) => event.preventDefault());
    option.addEventListener('pointerenter', () => { if (!menu.hidden) focusOption(index, false); });
    option.addEventListener('click', () => chooseTheme(index));
  }
  document.addEventListener('pointerdown', (event) => { if (!select.contains(event.target)) setOpen(false); });
  select.addEventListener('focusout', (event) => { if (!select.contains(event.relatedTarget)) setOpen(false); });
  updateTheme();
}
