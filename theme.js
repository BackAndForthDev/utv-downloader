// Applies the saved Light/Dark choice before the page paints (no flash of the wrong theme).
try {
  const t = localStorage.getItem('theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch { /* follow the system */ }
