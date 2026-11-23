// Service worker : garde une copie de l'application pour qu'elle marche sans connexion.
// (Les livres, eux, sont déjà enregistrés dans le navigateur, pas ici.)
// Change le numéro de version à chaque mise à jour du site (le même que VERSION_APPLI dans app.js).
const VERSION = 'liseuse-v9';

const FICHIERS_SITE = ['./', 'index.html', 'style.css', 'app.js', 'config.js', 'manifest.webmanifest', 'icone.svg'];
const FICHIERS_CDN = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll([
    // cache: 'reload' = on ignore la mémoire du navigateur, on télécharge vraiment la nouvelle version
    ...FICHIERS_SITE.map(f => new Request(f, { cache: 'reload' })),
    ...FICHIERS_CDN,
  ])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(cles => Promise.all(cles.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Réseau d'abord (pour avoir les mises à jour), copie en cache si pas de connexion
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // Jamais de cache pour les données : API du PC, fichiers des livres, Supabase
  if (url.pathname.includes('/api/') || url.pathname.includes('/livres/') || url.hostname.endsWith('.supabase.co')) return;
  // Fichiers du site : on redemande toujours au serveur s'il y a plus récent
  // (sinon l'iPhone peut garder l'ancienne version jusqu'à 10 minutes)
  const memeSite = url.origin === self.location.origin;
  const requete = memeSite ? fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }) : fetch(e.request);
  e.respondWith(
    requete
      .then(rep => {
        if (rep.ok) { const copie = rep.clone(); caches.open(VERSION).then(c => c.put(e.request, copie)); }
        return rep;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
