/**
 * SNUGGLE X — createFakeContact helper
 *
 * Wraps a fake "contact message" around replies so the bot's reply
 * appears quoted to a contact card showing the owner's WhatsApp info.
 *
 * The contact card shows the OWNER's number (read from the session's
 * creds.json), not the sender's number — so users can tap "Save" to
 * add the owner as a contact directly.
 *
 * Usage:
 *   const { createFakeContact } = require('./createFakeContact');
 *   await sock.sendMessage(jid, { text: 'hi' }, { quoted: createFakeContact(ownerNumber, ownerName) });
 */

const BOT_NAME = 'SNUGGLE X';
const PAIRING_URL = 'https://pair-snugglex.onrender.com/';
const GITHUB_URL = 'https://github.com/yobbyking/snuggle-x-vps';
const DEV_CONTACT = '0795314221 / 0181163563';

function createFakeContact(ownerNumber, ownerName) {
  const cleanNumber = String(ownerNumber || '0').replace(/[^\d]/g, '') || '0';
  const displayName = ownerName && ownerName !== 'Not Set!' ? ownerName : 'Yobby King';

  const vcard = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `N:X;${displayName.split(' ')[0]};${displayName.split(' ').slice(1).join(' ') || ''};;`,
    `FN:${displayName}`,
    `ORG:${BOT_NAME} PLATFORM`,
    'TITLE:Bot Owner',
    `item1.TEL;waid=${cleanNumber}:${cleanNumber}`,
    'item1.X-ABLabel:WhatsApp 💬',
    `item2.URL;type=Pairing:${PAIRING_URL}`,
    'item2.X-ABLabel:Pairing Site 🔗',
    `item3.URL;type=GitHub:${GITHUB_URL}`,
    'item3.X-ABLabel:GitHub 💻',
    `item4.NOTE:Official owner of ${BOT_NAME}. Tap the number above to chat with the owner. Dev: ${DEV_CONTACT}`,
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
