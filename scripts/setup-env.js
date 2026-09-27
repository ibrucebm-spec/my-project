// First-run helper: creates .env from .env.example with a random
// INGEST_TOKEN and prints the token to paste into the cTrader cBot.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const envFile = path.join(root, '.env');
const DEFAULT_TOKEN = 'zmien-mnie-na-dlugi-losowy-token';

let text = fs.existsSync(envFile)
  ? fs.readFileSync(envFile, 'utf8')
  : fs.readFileSync(path.join(root, '.env.example'), 'utf8');

let token = (text.match(/^INGEST_TOKEN=(.*)$/m) || [])[1]?.trim() || '';
if (!token || token === DEFAULT_TOKEN || token.length < 16) {
  token = crypto.randomBytes(18).toString('hex');
  text = /^INGEST_TOKEN=.*$/m.test(text) ? text.replace(/^INGEST_TOKEN=.*$/m, `INGEST_TOKEN=${token}`) : `${text}\nINGEST_TOKEN=${token}\n`;
  fs.writeFileSync(envFile, text);
  console.log('Utworzono plik ustawień .env z nowym tokenem.');
}

console.log('');
console.log('==============================================================');
console.log(' TWÓJ TOKEN (wklej go w cTraderze w parametr "Ingest token"):');
console.log('');
console.log(`   ${token}`);
console.log('');
console.log(' Token jest też zapisany w pliku .env w tym folderze.');
console.log('==============================================================');
console.log('');
