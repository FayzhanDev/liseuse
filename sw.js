// Service worker : garde une copie de l'application pour qu'elle marche sans connexion.
// (Les livres, eux, sont déjà enregistrés dans le navigateur, pas ici.)
// Change le numéro de version à chaque mise à jour du site.
const VERSION = 'liseuse-v3';

const FICHIERS = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'config.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js',
  'manifest.webmanifest',
  'icone.svg',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://cdn.jsdelivr.net/npm/epubjs@0.3.93/dist/epub.min.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FICHIERS)).then(() => self.skipWaiting()));
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
  e.respondWith(
    fetch(e.request)
      .then(rep => {
        if (rep.ok) { const copie = rep.clone(); caches.open(VERSION).then(c => c.put(e.request, copie)); }
        return rep;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html')))
  );
});
