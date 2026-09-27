# XAU AI Desk

Samouczący się desk tradingowy dla złota (**XAUUSD**). Uczy się bez przerwy na prawdziwych danych z Twojego **cTradera**, testuje równolegle kilka strategii i podpowiada **KUPNO / SPRZEDAŻ / CZEKAJ** z wejściem, stop lossem, take profitem i **wielkością pozycji w lotach**.

Działa na zasadach, na których pracują systemy w instytucjach, i ma trzy „mózgi”: **desk** (modele rynku), **osobisty trener** (uczy się z Twoich transakcji) i **analityka AI** (Claude), który wszystko tłumaczy po polsku.

Zasady desku:
- modele uczą się na danych,
- skuteczność jest mierzona wyłącznie na danych, których model wcześniej nie widział,
- strategia musi udowodnić przewagę statystycznie (z poprawką na testowanie wielu strategii naraz),
- warstwa zarządzania ryzykiem decyduje, czy sygnał w ogóle trafi do człowieka.

Decyzję o transakcji podejmujesz Ty. System niczego nie otwiera sam.

## Architektura

```
cTrader (cBot XauAiFeeder)
  │  świece M15: XAUUSD + EURUSD, XAGUSD, USDJPY · cena · spread · saldo konta
  ▼
Laboratorium strategii ── M15 → H1, H4 (agregacja)
  │  6 strategii (interwał × profil SL/TP), każda z własnymi modelami:
  │    sieć neuronowa · drzewa gradientowe (GBDT) · regresja logistyczna · zespół
  │  ocena każdej prognozy przed nauką → handel na papierze → dowód przewagi
  ▼
Desk ── wybór strategii, konflikty, wielkość pozycji, blokady ryzyka, 1 pozycja naraz
  ▼
Przeglądarka: decyzja, wyniki (krzywa kapitału w R), laboratorium, dane · powiadomienia
```

### Dane
cBot `ctrader/XauAiFeeder.cs` wysyła (najpierw Twoje transakcje, potem rynki powiązane, na końcu złoto):
- świece M15 złota i trzech rynków powiązanych: **EURUSD** jako miara dolara, **XAGUSD** (srebro), **USDJPY** (rentowności/ryzyko),
- bieżącą cenę i spread złota,
- saldo konta i parametry symbolu,
- Twoje transakcje i otwarte pozycje na złocie (dla osobistego trenera).

Na start wysyła do 100 000 świec historii (ok. 4 lata M15). Serwer w każdej odpowiedzi podaje, jakie świece już ma. Po restarcie cBot nie wysyła więc wszystkiego od nowa, a po wyczyszczeniu pamięci AI sam dośle całą historię.

### Cechy rynku (26)
- **Momentum i trend:** ruch z 1/4/16/64 świec, EMA20/EMA50 i ich nachylenie, odległość od SMA200.
- **Oscylatory i zmienność:** RSI, Bollinger, ATR teraz względem średniej, wielkość świecy, wolumen tickowy.
- **Poziomy dnia:** pozycja w dzisiejszym zakresie i względem wczorajszego high/low.
- **Pora dnia:** sesja azjatycka, londyńska, nowojorska.
- **Rynki powiązane:** ruch EURUSD, srebra i USDJPY w ostatniej świecy i w ostatnich 4 świecach, mierzony w ich własnej zmienności.

Wszystko jest liczone tylko z przeszłości (sprawdzają to testy), a odległości cenowe w jednostkach ATR.

### Modele
Każda strategia ma osobne modele dla KUPNA i SPRZEDAŻY. Każdy szacuje szansę, że transakcja dojdzie do TP przed SL:

| Model | Jak się uczy | Mocna strona |
|---|---|---|
| **Drzewa gradientowe (GBDT)**, ta sama rodzina co XGBoost/LightGBM | co ok. 10 dni rynku trening od nowa na ostatnich 4000 wynikach | zależności nieliniowe, progi, interakcje cech |
| **Sieć neuronowa** (26 → 16 → 1) | po każdej świecy (online) | szybka adaptacja, nieliniowość |
| **Regresja logistyczna** | po każdej świecy (online) | stabilność, odporność na szum |
| **Zespół** | średnia powyższych | zwykle najrówniejszy |

Używany jest model, który na ostatnich 1000 wynikach przewidywał najlepiej, mierzone jako przewaga nad zgadywaniem średniej.

### Dowód przewagi (governance)
1. Każda prognoza jest zapisywana, a gdy rynek pokaże wynik (TP, SL albo koniec czasu), najpierw jest oceniana, a dopiero potem model się na niej uczy. Wszystkie statystyki pochodzą więc z danych, których model nie widział.
2. Strategia handluje **na papierze**, czyli symuluje transakcje ze spreadem, bez pieniędzy, jedną naraz. Do desku trafia dopiero, gdy spełni wszystkie warunki:
   - ma co najmniej 50 transakcji papierowych,
   - średni wynik ostatnich (do 250) transakcji jest dodatni,
   - t-stat tego wyniku przekracza próg,
   - wynik z całej historii strategii też jest na plusie.
3. **Poprawka na wielokrotne testowanie (Bonferroni).** Im więcej strategii testujemy, tym łatwiej o jedną, która „wygrała” przypadkiem. Dlatego bazowy próg `AI_MIN_TSTAT = 1,5` jest automatycznie podnoszony. Przy 6 strategiach wynosi 2,29.

W testach na rynku czysto losowym desk przez półtora roku danych praktycznie milczy. Na rynku z prawdziwym wzorcem znajduje go i zarabia na danych, których nie widział.

### Reżimy rynku
Każda transakcja papierowa jest zapisywana razem ze stanem rynku, w którym została otwarta. Stan to kierunek trendu (wzrostowy, spadkowy, konsolidacja) i zmienność (spokojnie, nerwowo), razem 6 reżimów. Jeśli strategia na ostatnich 60 transakcjach w danym reżimie jest na minusie, w tym reżimie jej sygnały są odrzucane. Desk mówi wtedy wprost, dlaczego czeka. Stare straty wygasają, więc strategia może wrócić do reżimu, gdy zacznie w nim zarabiać.

### Osobisty trener AI (uczy się z Twoich transakcji)
cBot przesyła Twoje zamknięte transakcje i otwarte pozycje na złocie. Dla każdej transakcji AI odtwarza rynek z chwili wejścia (te same 26 cech co desk) i uczy **osobny model: o Tobie**. Model ocenia, w jakich warunkach Twoje decyzje kończą się zyskiem.
- **Uczciwy test:** każda transakcja jest oceniana modelem, który znał wyniki tylko tych transakcji, które były już zamknięte w chwili jej otwarcia. Widzisz też, ile byś zyskał lub stracił, pomijając transakcje ocenione poniżej 40%.
- **Gdzie zarabiasz, a gdzie tracisz:** podział według sesji (Azja/Londyn/Nowy Jork), kierunku, reżimu rynku, czasu trzymania i zgodności z deskiem.
- **Przy otwartej pozycji:** jak w podobnych warunkach szło Ci wcześniej, co na to desk, jaki jest reżim, oraz ostrzeżenie, jeśli pozycja nie ma stop lossa.
- Model jest silnie regularyzowany, bo trader ma dziesiątki lub setki transakcji, a nie tysiące. W testach dla tradera bez przewagi (losowe transakcje) nie wymyśla wzorców.

Modele desku i tak uczą się z każdej świecy rynku. Twoje transakcje nie „psują” ich nauki, tylko uczą trenera, jak Ty handlujesz.

### Analityk AI (Claude, opcjonalnie)
Na ekranie możesz zadać pytanie po polsku („dlaczego czekamy?”, „oceń moje transakcje”, „co z moją pozycją?”). Analityk odpowiada na podstawie aktualnego stanu desku, laboratorium i Twojego dziennika, bez wymyślania danych. Wymaga klucza API Anthropic:
1. Załóż konto na https://console.anthropic.com, doładuj środki (Billing) i utwórz klucz API (API Keys).
2. Kliknij dwukrotnie `analityk.bat`, wklej klucz i naciśnij Enter. Skrypt sprawdzi, czy klucz działa, i zapisze go w `.env`.
3. Uruchom ponownie `start.bat`.

Każde pytanie to jedno zapytanie do modelu Claude Opus 5 (zwykle kilka centów). Analityk działa tylko ze strony desku na Twoim komputerze: inne strony w przeglądarce nie mogą go wywołać.

### Powiadomienia na telefon (Telegram, opcjonalnie)
1. W Telegramie napisz do **@BotFather** `/newbot` i skopiuj token.
2. Dopisz do `.env`: `TELEGRAM_BOT_TOKEN=token`, potem napisz dowolną wiadomość do swojego nowego bota.
3. Kliknij dwukrotnie `telegram.bat` (albo `npm run telegram`). Skrypt sam znajdzie Twój czat i wyśle wiadomość testową.
4. Uruchom ponownie `start.bat`. Sygnały desku i wyniki podpowiedzi na żywo będą przychodzić na telefon.

### Desk i ryzyko
- Z sygnałów bieżącej świecy desk wybiera strategię z najmocniejszym dowodem. Pozostałe zgodne pokazuje jako potwierdzenia, a przy **sprzecznych sygnałach** każe czekać.
- **Wielkość pozycji:** liczona z salda konta, ryzyka `AI_RISK_PCT` (domyślnie 1%) i odległości do SL. Działa w walucie Twojego konta (np. PLN), bo cBot przesyła wartość punktu.
- **Blokada spreadu:** brak sygnałów, gdy spread przekracza `AI_MAX_SPREAD_X` × zakładany koszt, np. przy newsach.
- **Dzienny limit straty:** po stracie `AI_DAILY_LOSS_R` (domyślnie 3R) desk przestaje podpowiadać do końca dnia.
- **Jedna pozycja naraz:** wynik każdej podpowiedzi trafia do wyników desku (krzywa kapitału w R, profit factor, maksymalne obsunięcie). Transakcje z nauki na historii (symulacja) i te na żywo są raportowane osobno.
- **Prawdziwy spread:** AI mierzy medianę spreadu z ostatnich 24 h. Jeśli jest wyższa niż `AI_COST_USD`, ekran podpowiada nową wartość, bo inaczej wyniki byłyby zbyt optymistyczne.
- **Spóźnione wejście:** jeśli podpowiedź wygasła albo cena odjechała o 0,3 R lub więcej, ekran ostrzega, żeby nie gonić ruchu.

## Uruchomienie

**Windows:** zainstaluj Node.js LTS z https://nodejs.org i kliknij dwukrotnie `start.bat`. Za pierwszym razem plik doinstaluje biblioteki (potrzebny internet), potem utworzy ustawienia, wygeneruje token (wyświetli go w czarnym oknie), uruchomi AI i otworzy przeglądarkę. Okno musi zostać otwarte, dopóki AI ma działać. Zamknięcie okna lub Ctrl+C zapisuje pamięć AI.

Ręcznie (Node.js 18+):

```bash
npm install               # biblioteka Anthropic dla analityka AI (reszta nie ma zależności)
cp .env.example .env      # ustaw INGEST_TOKEN
npm start                 # http://localhost:3000
npm test
```

### Podłączenie cTradera

1. cTrader → **Algo** → **cBots** → **New**. Usuń przykładowy kod, wklej całą zawartość `ctrader/XauAiFeeder.cs` i kliknij **Build**.
2. Dodaj instancję cBota na **XAUUSD** i ustaw parametry:
   - `Ingest token`: token z czarnego okna,
   - `Timeframe`: **Minute15**,
   - `History bars`: 100000,
   - `Related symbols`: EURUSD,XAGUSD,USDJPY.
3. Uruchom (▶) i zgódź się na **pełny dostęp**, potrzebny do wysyłania danych przez HTTP do Twojego serwera.
4. W zakładce **Log** zobaczysz, ile historii ma broker i jak idzie wysyłanie. Pierwsza nauka na 100 000 świec trwa ok. 2 minuty.

Jeśli broker nie ma któregoś symbolu powiązanego, cBot go pominie, a AI potraktuje te cechy jako puste. Do ciągłej nauki cTrader (wersja na komputer) i `start.bat` muszą działać jednocześnie.

### MT5 (alternatywa)
`mt5/XauAiFeeder.mq5` wysyła tylko świece złota i cenę, bez rynków powiązanych i danych konta, więc bez wielkości pozycji. Instalacja: skopiuj do `MQL5/Experts`, skompiluj, dodaj adres serwera w *Narzędzia → Opcje → Doradcy Expert → WebRequest*, uruchom na XAUUSD M15.

### Nauka z CSV (opcjonalnie)

```bash
npm run train -- XAUUSD_M15.csv --dry              # raport laboratorium, pamięć AI bez zmian
npm run train -- XAUUSD_M15.csv --utc-offset=3     # nauka i zapis (plik w czasie brokera UTC+3)
```

Plik CSV zawiera tylko złoto, więc cechy rynków powiązanych będą puste. Przed nauką z CSV zatrzymaj serwer.

## Ustawienia (`.env`)

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `AI_TIMEFRAME` | `M15` | Interwał świec z cBota; H1/H4 AI buduje samo |
| `AI_STRATEGIES` | 6 strategii | `INTERWAŁ:SL_ATR:TP_ATR:MAKS_ŚWIEC`, po przecinku |
| `AI_AUX_SYMBOLS` | `EURUSD,XAGUSD,USDJPY` | Rynki powiązane (maks. 3), te same co w cBocie |
| `AI_COST_USD` | `0.35` | Spread + prowizja na uncję. Wpisz wartość swojego brokera |
| `AI_MIN_SAMPLES` | `1000` | Wyniki do przerobienia, zanim strategia może podpowiadać |
| `AI_MIN_EDGE` | `0.05` | Wymagana przewaga szansy nad progiem opłacalności |
| `AI_MIN_TSTAT` | `1.5` | Bazowy próg dowodu (podnoszony o poprawkę na liczbę strategii) |
| `AI_RISK_PCT` | `1` | Ryzyko na transakcję w % salda |
| `AI_DAILY_LOSS_R` | `3` | Dzienny limit straty w R |
| `AI_MAX_SPREAD_X` | `2` | Blokada, gdy spread > tyle × `AI_COST_USD` |
| `ANTHROPIC_API_KEY` | – | Włącza analityka AI (Claude) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | – | Powiadomienia na telefon (`telegram.bat` ustawia chat id) |

Pamięć AI jest w folderze `data/`. Dodana albo zmieniona strategia uczy się automatycznie na zapisanej historii. Usunięcie folderu `data/` oznacza naukę od zera: cBot sam dośle historię.

## Uczciwie o możliwościach

- To prawdziwe uczenie maszynowe, ale nie ma magii. Rynek złota jest w dużej mierze losowy, a przewaga nawet dużych funduszy jest niewielka. Dlatego system mierzy swoją skuteczność i milczy, gdy jej nie ma. Długie okresy „CZEKAJ” to znak, że zabezpieczenia działają.
- Wyniki są liczone na świecach: TP/SL sprawdzane po high/low, a gdy świeca dotknie obu, liczy się strata. Realny poślizg i zmienny spread przy newsach mogą je pogorszyć.
- AI nie zna kalendarza makro (NFP, FOMC, CPI). Blokada spreadu łapie część takich momentów, ale nie wszystkie.
- cBot jest kompilowany i uruchamiany w testach z imitacją API cTradera (`ctrader/test/run.sh`, wymaga Mono). Imitacja odtwarza wcześniejszy błąd z prawdziwego cTradera, ale nie jest prawdziwym cTraderem. Jeśli cTrader zgłosi błąd przy Build, skopiuj jego treść.
- Aplikacja domyślnie działa tylko na Twoim komputerze (127.0.0.1).

> To narzędzie informacyjne, nie porada inwestycyjna. AI może się mylić, a wyniki historyczne nie gwarantują przyszłych zysków. CFD na złoto niosą wysokie ryzyko utraty kapitału. Zacznij od konta demo.
