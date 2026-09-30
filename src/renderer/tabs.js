'use strict';

// The section tabs in the header. Each tab's panel is the element its
// aria-controls names; a view registers what to load when it's shown with
// Tabs.onShow(name, fn), where name is the tab's data-tab.
window.Tabs = (function () {
  const buttons = [...document.querySelectorAll('.tabs [role="tab"]')];
  const handlers = {};

  function show(name) {
    for (const tab of buttons) {
      const active = tab.dataset.tab === name;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
    }
    handlers[name]?.();
  }

  buttons.forEach((tab, index) => {
    tab.addEventListener('click', () => show(tab.dataset.tab));
    tab.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const next = buttons[(index + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length];
      show(next.dataset.tab);
      next.focus();
    });
  });

  return { show, onShow: (name, fn) => { handlers[name] = fn; } };
})();
