// Stockyard portfolio demo — stand-in for firebase-app.js.
// This demo never talks to a real backend: everything lives in memory in
// demo-firebase-firestore.js / demo-firebase-auth.js, seeded fresh on every
// page load. Nothing you do here reaches any server, and nothing here is a
// real business's data.
export function initializeApp(config){
  return { config: config, demo: true };
}
