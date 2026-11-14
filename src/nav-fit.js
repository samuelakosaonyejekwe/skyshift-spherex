// Runs before first paint (classic script in <head>): narrow screens start with the compact menu, so there is no
// flash of the full menu bar. app.js keeps html.nav-compact up to date on resize and language changes.
document.documentElement.classList.toggle('nav-compact', window.innerWidth <= 900);
