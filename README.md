# Gold Copy Radar

Aplikacja web, która na żywo pokazuje otwarte pozycje **XAUUSD** wybranych traderów. Ranking przepuszcza tylko tych, którzy mają trwałe wyniki przy kontrolowanym ryzyku.

Aplikacja pokazuje wyłącznie prawdziwe dane z podłączonych źródeł. Nie ma w niej żadnych symulowanych traderów.

## Uruchomienie

Wymagany Node.js 18+. Aplikacja nie ma żadnych zależności npm.

```bash
cp .env.example .env      # ustaw INGEST_TOKEN i ewentualnie dane Myfxbook
npm start                 # http://localhost:3000
npm test
```

## Test połączenia z Myfxbook

```bash
npm run check:myfxbook    # loguje się do Myfxbook API i wypisuje Twoje prawdziwe konta + otwarte pozycje na złocie
```

Skrypt bierze dane z `.env` i nigdy nie wypisuje hasła. Most MT5 testuje się na prawdziwym terminalu: po podłączeniu EA w oknie „Eksperci” w MT5 nie powinno być błędów, a pozycje sygnału pojawią się w aplikacji.

## Skąd biorą się dane

Nie istnieje publiczne API, które udostępnia na żywo pozycje „wszystkich najlepszych traderów świata”. MQL5, eToro i ZuluTrade nie dają dostępu do cudzych pozycji, a scrapowanie ich stron łamie regulaminy. Dlatego aplikacja ma dwa legalne źródła (`DATA_SOURCES` w `.env`):

| Źródło | Co daje | Konfiguracja |
|---|---|---|
| `mt5` | Pozycje z Twojego terminala MT5 na żywo (co ~2 s i natychmiast przy każdej transakcji) | EA `mt5/GoldCopyRadarBridge.mq5` + `INGEST_TOKEN` |
| `myfxbook` | Konta z Twojego portfolio Myfxbook (statystyki + otwarte transakcje), odświeżane co 60 s | `MYFXBOOK_EMAIL`, `MYFXBOOK_PASSWORD` |

### Most MT5: jak śledzić sygnały MQL5 na żywo

1. W MT5 zasubskrybuj wybrane sygnały XAUUSD (może to być konto demo u brokera: transakcje tradera są prawdziwe, ryzykujesz tylko wirtualne pieniądze; jedno konto = jeden sygnał).
2. Skopiuj `mt5/GoldCopyRadarBridge.mq5` do `MQL5/Experts`, skompiluj w MetaEditorze.
3. *Narzędzia → Opcje → Doradcy Expert → Zezwalaj na WebRequest* i dodaj adres serwera (np. `http://127.0.0.1:3000`).
4. Przeciągnij EA na wykres **XAUUSD** (z niego EA bierze cenę złota). Ustaw `IngestToken` i nazwę, a statystyki sygnału (wzrost %, max DD %, wiek w tygodniach, PF) przepisz ze strony sygnału.

Każda pozycja skopiowana z sygnału pojawi się w aplikacji w ciągu sekund. Jeśli serwer stoi w internecie, używaj HTTPS i długiego losowego tokenu.

## Ranking i filtry

Wynik 0–100 w `server/scoring.js`:

- **zwrot względem ryzyka** (roczny zwrot / max drawdown): do 50 pkt,
- **wiek konta** (pełne punkty od 2 lat): do 20 pkt,
- **profit factor**: do 15 pkt,
- **używanie stop lossów**: do 15 pkt.

Trader jest **odrzucany** (i domyślnie ukrywany), gdy:

- konto jest młodsze niż `MIN_AGE_WEEKS` (domyślnie 26 tygodni),
- drawdown przekracza `MAX_DRAWDOWN_PCT` (30%),
- wykryto **martingale** (dokładanie pozycji po gorszej cenie z rosnącym lotem) albo **grid** (5+ stratnych pozycji w jedną stronę). Taka flaga zostaje zapamiętana po zamknięciu koszyka,
- win rate wynosi ≥ 90% (typowe dla ukrytego martingale),
- wynik jest niższy niż `MIN_SCORE`.

## API

- `GET /api/stream`: Server-Sent Events (`state` co 1 s, `opened`, `closed`)
- `GET /api/state`: bieżący stan (JSON)
- `POST /api/ingest`: snapshot pozycji jednego konta (nagłówek `Authorization: Bearer <INGEST_TOKEN>`)

```json
{
  "account": { "id": "123", "name": "Sygnał X", "stats": { "growthPct": 140, "maxDrawdownPct": 11, "ageWeeks": 90, "profitFactor": 1.8 } },
  "price": 5120.5,
  "positions": [{ "id": "9001", "symbol": "XAUUSD", "side": "buy", "lots": 0.3, "openPrice": 5118.2, "openTime": 1790000000000, "sl": 5105, "tp": 5140, "profit": 54 }]
}
```

## Wiarygodność danych

- **Nieaktualne dane są oznaczane.** Jeśli EA z MT5 milczy dłużej niż 30 s albo Myfxbook nie odpowiada przez 3 cykle odświeżania, pozycje tego tradera są wyszarzone z etykietą „nieaktualne”, a na górze pojawia się ostrzeżenie. Cena złota bez aktualizacji przez 60 s jest przekreślona.
- **Przy każdym traderze widać źródło danych** (MT5 na żywo / Myfxbook API), typ konta (REAL / DEMO) i czas ostatniej aktualizacji. Statystyki wpisane ręcznie w EA są wyraźnie opisane.
- **Brakujące statystyki nie są wysyłane jako 0.** Trader bez danych o drawdownie lub wieku konta jest odrzucany, zamiast dostawać zawyżony wynik.
- **Zwrot roczny liczony jest tylko dla kont z co najmniej rokiem historii.** Krótsze okresy nie są przeliczane na rok.
- **Wykryty martingale/grid jest zapamiętywany na dysku** (`data/risk-memory.json`) i pozostaje oznaczony po restarcie.
- **Godziny rynku:** w weekend i w dziennej przerwie aplikacja pokazuje komunikat „Rynek zamknięty”.
- **Czas otwarcia pozycji z MT5 jest przeliczany z czasu serwera brokera na UTC.**
- **Aplikacja jest dostępna tylko na Twoim komputerze** (127.0.0.1). Żeby udostępnić ją w sieci, ustaw `HOST=0.0.0.0`, ale wtedy koniecznie z mocnym `INGEST_TOKEN`.

## Ograniczenia

- Adapter Myfxbook korzysta z oficjalnego API, ale nie był testowany na żywym koncie. Sprawdź logi przy pierwszym uruchomieniu.
- EA dla MT5 nie był kompilowany w tym środowisku (brak MetaEditora).
- Stan jest trzymany w pamięci i znika po restarcie serwera.

> To narzędzie informacyjne, nie porada inwestycyjna. Wyniki historyczne nie gwarantują przyszłych zysków, a CFD na złoto niosą wysokie ryzyko utraty kapitału.
