// Stockyard portfolio demo — stand-in for firebase-auth.js.
// Starts already "signed in" as a demo account so visitors can explore
// immediately. Sign out / sign back in both work for real (any email +
// password is accepted) so the sign-in flow itself can be demoed too — but
// none of it touches a real account anywhere.
var DEMO_USER = { email: "demo@stockyard.app" };
var currentUser = DEMO_USER;
var listeners = [];

function notify(){
  listeners.forEach(function(cb){ cb(currentUser); });
}

export function getAuth(app){
  return { get currentUser(){ return currentUser; } };
}

export function onAuthStateChanged(auth, cb){
  listeners.push(cb);
  // Mirror real Firebase: the first callback fires async, not synchronously.
  setTimeout(function(){ cb(currentUser); }, 10);
  return function(){
    listeners = listeners.filter(function(l){ return l !== cb; });
  };
}

export function signInWithEmailAndPassword(auth, email, password){
  currentUser = { email: (email || "demo@stockyard.app").trim() || "demo@stockyard.app" };
  notify();
  return Promise.resolve({ user: currentUser });
}

export function signOut(){
  currentUser = null;
  notify();
  return Promise.resolve();
}
