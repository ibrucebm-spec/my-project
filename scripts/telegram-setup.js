// Connects phone notifications: finds your Telegram chat id and saves it in .env.
//   1. In Telegram talk to @BotFather, send /newbot, copy the token.
//   2. Put TELEGRAM_BOT_TOKEN=<token> in .env, send any message to your new bot.
//   3. npm run telegram

const fs = require('fs');
const path = require('path');
require('../server/config'); // loads .env

const envFile = path.join(__dirname, '..', '.env');
const token = process.env.TELEGRAM_BOT_TOKEN;

async function main() {
  if (!token) {
    console.log('Brak TELEGRAM_BOT_TOKEN w pliku .env.');
    console.log('1) W Telegramie napisz do @BotFather: /newbot i skopiuj token.');
    console.log('2) Dopisz do .env linię: TELEGRAM_BOT_TOKEN=twój_token');
    console.log('3) Napisz dowolną wiadomość do swojego nowego bota i uruchom to ponownie.');
    process.exit(1);
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates`);
  const body = await res.json();
  if (!body.ok) {
    console.error('Telegram odrzucił token:', body.description);
    process.exit(1);
  }
  const msg = [...body.result].reverse().find((u) => u.message?.chat?.id);
  if (!msg) {
    console.log('Nie widzę wiadomości do bota. Napisz do niego cokolwiek w Telegramie i uruchom to ponownie.');
    process.exit(1);
  }
  const chatId = String(msg.message.chat.id);
  let text = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  text = /^TELEGRAM_CHAT_ID=.*$/m.test(text) ? text.replace(/^TELEGRAM_CHAT_ID=.*$/m, `TELEGRAM_CHAT_ID=${chatId}`) : `${text.trimEnd()}\nTELEGRAM_CHAT_ID=${chatId}\n`;
  fs.writeFileSync(envFile, text);
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: '✅ XAU AI Desk połączony. Tu będą przychodzić sygnały.' }),
  });
  console.log(`Gotowe: zapisano TELEGRAM_CHAT_ID=${chatId} w .env i wysłano wiadomość testową. Uruchom ponownie start.bat.`);
}

main().catch((err) => {
  console.error('Błąd połączenia z Telegramem:', err.message);
  process.exit(1);
});
