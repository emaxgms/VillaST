/**
 * notify-client.js — FCM web push client for the admin PWA.
 *
 * Client half of Flow 1 (see docs/admin-panel-v4-design.md): the host taps
 * "Attiva notifiche" inside the installed app (a user gesture is required by
 * iOS), the FCM token lands in `pushTokens/{sha256(token)}` and the Apps Script
 * notifier reads that collection to send the pushes.
 */

import { db } from './firebase-config.js';
import {
  collection, doc, setDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { getMessaging, getToken, isSupported, onMessage } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js";

// Web Push certificate (VAPID) public key — Firebase console > Settings >
// Cloud Messaging > Web Push certificates. Public by design; the private half
// stays with FCM. Empty until the one-off console setup is done.
export const VAPID_PUBLIC_KEY = "BCMkeWJDRXNBJmz3arZ2qhejnTK1FkprJft9TmH_p1Uv19EPO5RNfTqG89hAXDQ0rOGRJ1kgw4pD6iViyGMcGDE";

const SW_URL = '/sw.js';
const SW_SCOPE = '/admin';

let swRegistration = null;

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    swRegistration = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
    return swRegistration;
  } catch (err) {
    console.error('Service worker registration failed:', err);
    return null;
  }
}

/** Human-readable state for the Impostazioni panel. */
export async function getNotificationState() {
  const standalone = window.navigator.standalone === true ||
    window.matchMedia('(display-mode: standalone)').matches;
  const supported = await isSupported().catch(() => false);

  if (!VAPID_PUBLIC_KEY) {
    return { level: 'off', text: 'Non configurate (manca la chiave VAPID)', canEnable: false };
  }
  if (!supported) {
    return { level: 'off', text: 'Non supportate su questo browser', canEnable: false };
  }
  if (Notification.permission === 'denied') {
    return { level: 'off', text: 'Bloccate — riattivale dalle impostazioni del telefono', canEnable: false };
  }
  if (Notification.permission === 'granted' && swRegistration) {
    return { level: 'on', text: 'Attive su questo dispositivo', canEnable: false };
  }
  if (!standalone && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    return { level: 'warn', text: 'Aggiungi prima la pagina alla schermata Home', canEnable: false };
  }
  return { level: 'warn', text: 'Non attive su questo dispositivo', canEnable: true };
}

/** Must be called from a click handler: iOS only shows the prompt on a gesture. */
export async function enableNotifications() {
  if (!VAPID_PUBLIC_KEY) throw new Error('Chiave VAPID non configurata.');
  if (!swRegistration) swRegistration = await registerServiceWorker();
  if (!swRegistration) throw new Error('Service worker non disponibile.');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permesso notifiche negato.');

  const messaging = getMessaging();
  const token = await getToken(messaging, {
    vapidKey: VAPID_PUBLIC_KEY,
    serviceWorkerRegistration: swRegistration
  });
  if (!token) throw new Error('Token non ottenuto.');

  await storeToken(token);
  return token;
}

async function tokenDocId(token) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function storeToken(token) {
  const id = await tokenDocId(token);
  await setDoc(doc(db, 'pushTokens', id), {
    token,
    ua: navigator.userAgent.slice(0, 180),
    platform: navigator.platform || '',
    standalone: window.navigator.standalone === true ||
      window.matchMedia('(display-mode: standalone)').matches,
    updatedAt: serverTimestamp()
  });
}

/** The Apps Script notifier picks this up on its next tick and sends a push. */
export async function sendTestPush() {
  await setDoc(doc(collection(db, 'pushTests')), {
    requestedBy: 'admin-panel',
    sent: false,
    createdAt: serverTimestamp()
  });
}

/** Foreground messages (panel open): let the toast do the talking. */
export function initForegroundHandler(onNote) {
  try {
    onMessage(getMessaging(), (payload) => {
      const note = payload.notification || {};
      if (typeof onNote === 'function') onNote(note);
    });
  } catch (err) {
    console.error('Foreground message wiring failed:', err);
  }
}
