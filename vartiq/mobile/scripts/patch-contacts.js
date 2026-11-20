'use strict';

/**
 * The contacts plugin declares both READ_CONTACTS and WRITE_CONTACTS as its permission group, so Android refuses to use it
 * unless both are in the manifest, and the phone would then ask to "modify contacts". VartiQ only reads contacts (Find
 * friends, when the person taps it), so this keeps the plugin to READ_CONTACTS. Runs after `npm install`.
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'node_modules', '@capacitor-community', 'contacts', 'android', 'src', 'main', 'java',
  'getcapacitor', 'community', 'contacts', 'ContactsPlugin.java');
if (!fs.existsSync(file)) { console.log('contacts plugin not installed: nothing to patch'); process.exit(0); }
const src = fs.readFileSync(file, 'utf8');
const from = 'Manifest.permission.READ_CONTACTS, Manifest.permission.WRITE_CONTACTS';
if (!src.includes(from)) {
  console.log(src.includes('Manifest.permission.READ_CONTACTS }') ? 'contacts plugin already patched' : 'contacts plugin changed: check scripts/patch-contacts.js');
  process.exit(0);
}
fs.writeFileSync(file, src.replace(from, 'Manifest.permission.READ_CONTACTS'));
console.log('contacts plugin now asks for READ_CONTACTS only');
