// Saves the Anthropic API key in .env for the AI analyst and checks that it works.
//   analityk.bat   (or: node scripts/set-anthropic-key.js)

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const envFile = path.join(__dirname, '..', '.env');

function saveKey(key) {
  let text = fs.existsSync(envFile)
    ? fs.readFileSync(envFile, 'utf8')
    : fs.readFileSync(path.join(__dirname, '..', '.env.example'), 'utf8');
  text = /^ANTHROPIC_API_KEY=.*$/m.test(text)
    ? text.replace(/^ANTHROPIC_API_KEY=.*$/m, `ANTHROPIC_API_KEY=${key}`)
    : `${text.trimEnd()}\nANTHROPIC_API_KEY=${key}\n`;
  fs.writeFileSync(envFile, text);
}

async function checkKey(key) {
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch {
    return 'Brak biblioteki: uruchom najpierw start.bat (zainstaluje ją), potem ten plik jeszcze raz.';
  }
  try {
    // Listing models is free and proves the key is valid.
    await new Anthropic({ apiKey: key }).models.list({ limit: 1 });
    return null;
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return 'Klucz jest nieprawidłowy. Skopiuj go jeszcze raz w całości z console.anthropic.com.';
    if (err instanceof Anthropic.PermissionDeniedError) return 'Klucz nie ma uprawnień. Sprawdź w console.anthropic.com, czy jest aktywny.';
    if (err instanceof Anthropic.APIConnectionError) return 'Brak połączenia z internetem albo z api.anthropic.com.';
    return `Błąd sprawdzania klucza: ${err.message}`;
  }
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.question('Wklej klucz API Anthropic (zaczyna się od sk-ant-) i naciśnij Enter:\n> ', async (answer) => {
  rl.close();
  const key = String(answer || '').trim().replace(/^["']|["']$/g, '');
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) {
    console.log('\nTo nie wygląda na klucz Anthropic (powinien zaczynać się od sk-ant- i być długi). Nic nie zapisano.');
    process.exit(1);
  }
  const problem = await checkKey(key);
  if (problem) {
    console.log(`\n${problem}\nNic nie zapisano.`);
    process.exit(1);
  }
  saveKey(key);
  console.log('\nKlucz działa i został zapisany w pliku .env.');
  console.log('Zamknij czarne okno start.bat (jeśli jest otwarte) i uruchom start.bat ponownie. Analityk AI będzie włączony.');
});
