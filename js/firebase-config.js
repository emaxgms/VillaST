// Firebase configuration — VillaST
// SETUP: Replace REPLACE_ME values with your Firebase project settings from:
// Firebase Console > Project Settings > Your apps > SDK setup and configuration
//
// The Firebase API key is safe to expose client-side — security is enforced by
// Firestore security rules (firestore.rules), not by keeping this key secret.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyDL0y9ztdnM_5-fFmla-rBZpeRaSRTM3OQ",
  authDomain: "villa-serenita-san-teodoro.firebaseapp.com",
  projectId: "villa-serenita-san-teodoro",
  storageBucket: "villa-serenita-san-teodoro.firebasestorage.app",
  messagingSenderId: "125678913278",
  appId: "1:125678913278:web:e7f799921d339647bfc7af"
};

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
