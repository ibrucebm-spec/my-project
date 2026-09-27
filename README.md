# XAU AI Advisor

Twój własny, samouczący się doradca AI do handlu złotem (**XAUUSD**). Uczy się bez przerwy na prawdziwych świecach z Twojego **cTradera** (albo MetaTradera 5) i podpowiada **KUPNO / SPRZEDAŻ / CZEKAJ** razem z poziomem wejścia, stop lossem i take profitem.

Działa jak systemy wspomagania decyzji w instytucjach: model uczy się na danych, jego skuteczność jest stale mierzona na danych, których wcześniej nie widział, a sygnał trafia do człowieka dopiero wtedy, gdy model udowodni przewagę. Decyzję o transakcji podejmujesz Ty. System niczego nie otwiera sam.

## Jak to działa

```
cTrader (cBot XauAiFeeder) ──świece + cena──▶ serwer AI ──▶ przeglądarka (podpowiedzi, skuteczność, powiadomienia)
                                           │
                                           └─ data/model-XAUUSD-M15.json (pamięć modelu)
```

1. **Dane.** cBot `ctrader/XauAiFeeder.cs` (albo EA `mt5/XauAiFeeder.mq5`) przy starcie wysyła historię (domyślnie 20 000 świec M15, czyli około 10 miesięcy), a potem każdą nową zamkniętą świecę i bieżącą cenę.
2. **Cechy rynku.** Dla każdej świecy AI liczy 17 cech: ruch ceny z 1/4/16/64 świec, RSI, odległość od EMA20/EMA50 i ich nachylenie, zmienność (ATR) teraz względem średniej, pozycję w zakresie 50 świec, odchylenie Bollingera, wolumen tickowy i porę dnia (sesja azjatycka, londyńska, nowojorska). Odległości są liczone w ATR, więc model działa tak samo przy złocie po 1800 $ i po 5000 $.
3. **Modele AI.** Trzy modele osobno dla KUPNA i SPRZEDAŻY szacują szansę, że transakcja dojdzie do TP przed SL:
   - **regresja logistyczna** (stabilna, szybko łapie proste zależności),
   - **sieć neuronowa** (warstwa ukryta z 16 neuronami, łapie zależności nieliniowe, np. „RSI skrajny, ale tylko w silnym trendzie”),
   - **zespół** (średnia obu).
   Używany jest ten, który ostatnio przewidywał najlepiej.
4. **Ciągła nauka.** Każda prognoza jest zapisywana. Gdy rynek pokaże wynik (TP, SL albo koniec czasu), AI porównuje go ze swoją prognozą i dopiero wtedy się na nim uczy. Model uczy się więc z każdą świecą, nigdy nie przestaje i dopasowuje się, gdy rynek zmienia charakter. Wiedza jest zapisywana na dysku i przetrwa restart.
5. **Bramka bezpieczeństwa.** AI podpowiada transakcję tylko wtedy, gdy spełnione są wszystkie warunki:
   - przeszło okres nauki (`AI_MIN_SAMPLES` wyników),
   - szansa na TP przekracza próg opłacalności (po uwzględnieniu spreadu) o `AI_MIN_EDGE`,
   - jego **handel na papierze** jest zyskowny w sposób statystycznie istotny. Handel na papierze to symulowane transakcje na nowych danych, ze spreadem i bez pieniędzy. Warunek sprawdza t-stat ≥ `AI_MIN_TSTAT` na ostatnich 100 transakcjach.

   W przeciwnym razie mówi **CZEKAJ** i wyjaśnia dlaczego. Na rynku bez wzorca (czysty przypadek) AI nie da ani jednego sygnału, co sprawdzają testy.

## Uruchomienie

**Najprościej (Windows):** zainstaluj Node.js LTS z https://nodejs.org, a potem kliknij dwukrotnie `start.bat`. Plik sam utworzy ustawienia, wygeneruje token (wyświetli go w czarnym oknie), uruchomi AI i otworzy przeglądarkę. Okno musi zostać otwarte, dopóki AI ma działać.

Ręcznie: wymagany Node.js 18+. Brak zależności npm: sieć neuronowa i cała reszta są napisane od zera.

```bash
cp .env.example .env      # ustaw INGEST_TOKEN (długi losowy ciąg)
npm start                 # http://localhost:3000
npm test
```

### Podłączenie cTradera

1. Otwórz cTrader → zakładka **Algo** → **cBots** → **New** (nowy cBot). Usuń cały przykładowy kod i wklej zawartość pliku `ctrader/XauAiFeeder.cs`, potem kliknij **Build**.
2. Otwórz wykres **XAUUSD** i dodaj do niego cBota **XauAiFeeder** (przycisk „+” przy cBocie → instancja na XAUUSD).
3. Ustaw parametry:
   - `Ingest token`: ten sam ciąg co `INGEST_TOKEN` w `.env`,
   - `Timeframe`: **Minute15** (musi pasować do `AI_TIMEFRAME=M15`; dla H1 wybierz `Hour`),
   - `Server URL`: zostaw `http://127.0.0.1:3000/api/bars`, jeśli serwer działa na tym samym komputerze.
4. Uruchom cBota (▶). cTrader zapyta o **pełny dostęp** (Full Access). Zgoda jest potrzebna, bo cBot wysyła dane przez HTTP do Twojego serwera. cBot niczego nie kupuje ani nie sprzedaje.
5. W zakładce **Log** zobaczysz, ile świec historii jest dostępnych i jak idzie wysyłanie. AI uczy się na nich od razu.

Wskazówki:
- Działa z cTraderem na komputerze (Windows/Mac). cTrader Web i mobilny nie uruchamiają cBotów przez noc; do ciągłej nauki cTrader musi być włączony, tak samo jak serwer (`npm start`).
- Jeśli broker udostępnia mniej historii niż 20 000 świec, cBot wyśle tyle, ile jest. Zwykle to i tak kilka miesięcy M15.
- Konto demo wystarczy: cBot tylko czyta ceny.

### Podłączenie MT5 (alternatywa)

1. Skopiuj `mt5/XauAiFeeder.mq5` do `MQL5/Experts` i skompiluj w MetaEditorze.
2. *Narzędzia → Opcje → Doradcy Expert → Zezwalaj na WebRequest* i dodaj `http://127.0.0.1:3000`.
3. Przeciągnij EA na wykres **XAUUSD**. Ustaw `IngestToken` (ten sam co w `.env`) i `Timeframe` (ten sam co `AI_TIMEFRAME`, domyślnie M15).
4. W zakładce „Eksperci” zobaczysz postęp wysyłania historii. AI uczy się na niej od razu, a po chwili w przeglądarce widać wynik nauki.

Jeśli terminal ma mało historii, przewiń wykres M15 mocno w lewo (MT5 dociągnie dane) albo zwiększ *Maks. słupków na wykresie* w opcjach.

### Nauka z pliku CSV (opcjonalnie)

Zwykle niepotrzebne, bo cBot sam wysyła historię. Jeśli masz dłuższą historię w CSV (np. wyeksportowaną z MT5: *Widok → Symbole → Słupki → Eksportuj*), możesz od razu nauczyć na niej model:

```bash
npm run train -- XAUUSD_M15.csv --dry              # tylko test: raport skuteczności, model bez zmian
npm run train -- XAUUSD_M15.csv --utc-offset=3     # nauka i zapis do modelu (plik w czasie brokera UTC+3)
```

Raport pokazuje skuteczność liczoną uczciwie: każda świeca jest najpierw prognozowana, a dopiero potem model się na niej uczy. Zatrzymaj serwer przed nauką z CSV, bo oba zapisują ten sam plik modelu.

## Jak czytać ekran

- **Podpowiedź AI**: KUPNO / SPRZEDAŻ / CZEKAJ, wejście, SL, TP, ryzyko w $/oz i oczekiwany wynik w R. Paski pokazują szansę na TP dla obu kierunków, a pionowa kreska to próg opłacalności. Poniżej widać, które cechy rynku najbardziej wpłynęły na ocenę.
- **Nauka modelu**: ile świec i wyników AI przerobiło. **Przewaga nad zgadywaniem** porównuje błąd prognoz modelu z błędem prostego zgadywania średniej: wartość > 0% oznacza, że model naprawdę coś wie. Pogrubiony jest model używany teraz.
- **Skuteczność podpowiedzi**: każda podpowiedź, którą AI pokazało, i jej prawdziwy wynik w **R** (wielokrotność ryzyka: +1,5 R to TP, −1 R to SL, spread odjęty).

Włącz powiadomienia w przeglądarce, a dostaniesz alert przy każdym nowym sygnale.

## Ustawienia (`.env`)

| Zmienna | Domyślnie | Znaczenie |
|---|---|---|
| `AI_TIMEFRAME` | `M15` | Interwał świec (M5, M15, M30, H1, H4); taki sam w cBocie (Minute15, Hour…) |
| `AI_HORIZON_BARS` | `16` | Maksymalny czas transakcji w świecach (16 × M15 = 4 h) |
| `AI_SL_ATR` / `AI_TP_ATR` | `1.0` / `1.5` | SL i TP w wielokrotnościach ATR(14) |
| `AI_COST_USD` | `0.35` | Spread + prowizja na uncję. Wpisz wartość swojego brokera |
| `AI_MIN_SAMPLES` | `1000` | Okres nauki przed pierwszą podpowiedzią |
| `AI_MIN_EDGE` | `0.05` | Wymagana przewaga szansy nad progiem opłacalności |
| `AI_MIN_TSTAT` | `1.5` | Jak pewny musi być zysk na papierze (wyżej = mniej sygnałów, ale pewniejsze) |

Zmiana interwału, SL/TP, horyzontu lub kosztu oznacza, że stare lekcje przestają pasować. Model uczy się wtedy od nowa na zapisanych świecach (albo, przy zmianie interwału, na nowej historii z cTradera lub MT5).

## Uczciwie o możliwościach

- To prawdziwe uczenie maszynowe, ale nie ma magii. Rynek złota jest w dużej mierze losowy, a przewaga nawet najlepszych funduszy jest mała. Dlatego system mierzy swoją skuteczność i milczy, gdy jej nie ma. Długie okresy z samym „CZEKAJ” są normalne i świadczą o tym, że zabezpieczenia działają.
- Skuteczność jest liczona na świecach zamknięcia (TP/SL sprawdzane po high/low świecy; gdy świeca dotknie obu, liczy się strata). Realny poślizg i zmienny spread przy newsach mogą pogorszyć wynik.
- Model nie zna kalendarza makro (NFP, FOMC, CPI). W dniu ważnych danych zachowaj szczególną ostrożność.
- W MT5 czas świec jest przeliczany z czasu brokera na UTC według bieżącego przesunięcia, więc historia sprzed zmiany czasu letniego/zimowego może być przesunięta o godzinę (w cTraderze tego problemu nie ma).
- cBot i EA nie były kompilowane w tym środowisku (brak cTradera i MetaEditora). Przy pierwszym uruchomieniu sprawdź zakładkę Log w cTraderze (albo „Eksperci” w MT5). Format danych, które wysyłają, jest sprawdzony testami serwera.
- cBot pobiera czasy świec w UTC (`TimeZone = UTC`), więc godziny sesji są liczone poprawnie przez cały rok.
- Aplikacja domyślnie działa tylko na Twoim komputerze (127.0.0.1). Żeby udostępnić ją w sieci, ustaw `HOST=0.0.0.0` i koniecznie mocny `INGEST_TOKEN`.

> To narzędzie informacyjne, nie porada inwestycyjna. AI może się mylić, a wyniki historyczne nie gwarantują przyszłych zysków. CFD na złoto niosą wysokie ryzyko utraty kapitału. Zacznij od konta demo.
