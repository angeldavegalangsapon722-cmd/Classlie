// Web push is optional: the app runs normally without VAPID keys configured.
// We load the library lazily so a missing/optional dependency never blocks boot.
let webpush = null;
let loadFailed = false;
function lib() {
  if (webpush || loadFailed) return webpush;
  try {
    webpush = require("web-push");
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    if (publicKey && privateKey) webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:hello@classlie.app", publicKey, privateKey);
    return webpush;
  } catch {
    loadFailed = true;
    return null;
  }
}

function pushConfigured() {
  return Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY && lib());
}
function publicKey() {
  return process.env.VAPID_PUBLIC_KEY || null;
}

// Sends one notification. Returns false when the subscription is gone (caller should delete it).
async function sendPush(subscription, payload) {
  if (!pushConfigured()) return true;
  try {
    await lib().sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload)
    );
    return true;
  } catch (error) {
    if (error && (error.statusCode === 404 || error.statusCode === 410)) return false;
    console.error("Push failed:", error.message);
    return true;
  }
}

module.exports = { pushConfigured, publicKey, sendPush };
