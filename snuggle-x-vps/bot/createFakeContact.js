/**
 * SNUGGLE X — createFakeContact helper
 *
 * Creates a fake "contact message" that can be used as the `quoted` parameter
 * in sock.sendMessage(). The reply will appear as if it's quoting a contact
 * card showing the bot's info.
 *
 * Usage:
 *   const { createFakeContact } = require('./createFakeContact');
 *   await sock.sendMessage(jid, { text: 'menu...' }, { quoted: createFakeContact(ownerNumber, ownerName) });
 *
 * The contact card shows:
 *   - Bot name (SNUGGLE X)
 *   - Owner's WhatsApp number (tappable to save)
 *   - Pairing site URL
 *   - GitHub URL
 *   - Note: "Developed by yobby_mking"
 */

const BOT_NAME = 'SNUGGLE X';
const PAIRING_URL = 'https://pair-snugglex.onrender.com/';
const GITHUB_URL = 'https://github.com/yobbyking/snuggle-x-vps';
const DEV_NOTE = 'Developed by yobby_mking';

function createFakeContact(ownerNumber, ownerName) {
  const cleanNumber = String(ownerNumber || '0').replace(/[^\d]/g, '') || '0';
  const displayName = BOT_NAME; // Show bot name, not owner name
  const ownerDisplay = (ownerName && ownerName !== 'Not Set!') ? ownerName : 'Yobby King';

  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:X;${displayName};Bot;;;`,
    `FN:${displayName}`,
    `ORG:${DEV_NOTE}`,
    'TITLE:WhatsApp Bot',
    `item1.TEL;waid=${cleanNumber}:${cleanNumber}`,
    'item1.X-ABLabel:Owner WhatsApp 💬',
    `item2.URL;type=Pairing:${PAIRING_URL}`,
    'item2.X-ABLabel:Pairing Site 🔗',
    `item3.URL;type=GitHub:${GITHUB_URL}`,
    'item3.X-ABLabel:GitHub 💻',
    `item4.NOTE:${DEV_NOTE}. Owner: ${ownerDisplay}. Tap the number above to chat with the owner.`,
    'END:VCARD',
  ].join('\n');

  return {
    key: {
      participants: '0@s.whatsapp.net',
      remoteJid: '0@s.whatsapp.net',
      fromMe: false,
      id: 'SNUGGX' + Math.random().toString(36).substring(2, 12).toUpperCase(),
    },
    message: {
      contactMessage: {
        displayName,
        vcard,
      },
    },
    participant: '0@s.whatsapp.net',
  };
}

module.exports = { createFakeContact };
