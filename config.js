// ============================================================
//  Connexion à Supabase (bibliothèque en ligne)
//  Supabase → Project Settings → API :
//    - "Project URL"            → supabaseUrl
//    - clé "publishable" (sb_publishable_…) ou ancienne clé "anon" → supabaseAnonKey
//  Cette clé est faite pour être publique : ce sont les règles du
//  fichier supabase-setup.sql qui protègent tes livres.
//  Laisse vide pour utiliser la liseuse sans compte en ligne.
// ============================================================
window.LISEUSE_CONFIG = {
  supabaseUrl: 'https://gsxnhpvoymashcfumvfj.supabase.co',
  supabaseAnonKey: 'sb_publishable_eUoizR7RH1FArOUpZI7Ezw_FcaR0wye',
};
