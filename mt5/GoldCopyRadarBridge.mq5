//+------------------------------------------------------------------+
//| GoldCopyRadarBridge.mq5                                          |
//| Wysyła otwarte pozycje XAUUSD z tego konta MT5 do Gold Copy      |
//| Radar (POST /api/ingest).                                        |
//|                                                                  |
//| Typowe użycie: konto demo/real subskrybujące sygnał MQL5 (albo   |
//| konto samego tradera). Każda pozycja skopiowana z sygnału pojawi |
//| się w aplikacji na żywo.                                         |
//|                                                                  |
//| WAŻNE: Narzędzia -> Opcje -> Doradcy Expert -> "Zezwalaj na      |
//| WebRequest dla wymienionych URL" -> dodaj adres serwera, np.     |
//| http://127.0.0.1:3000                                            |
//+------------------------------------------------------------------+
#property copyright "Gold Copy Radar"
#property version   "1.00"
#property strict

input string ServerUrl      = "http://127.0.0.1:3000/api/ingest"; // Adres endpointu
input string IngestToken    = "";            // INGEST_TOKEN z pliku .env
input string TraderName     = "";            // Nazwa (np. nazwa sygnału); puste = login konta
input int    IntervalSec    = 2;             // Co ile sekund wysyłać
// Statystyki tradera przepisane ze strony sygnału (MQL5 / Myfxbook):
input double SignalGrowthPct   = 0;          // Wzrost % (Growth)
input double SignalMaxDDPct    = 0;          // Maksymalny drawdown %
input int    SignalAgeWeeks    = 0;          // Wiek sygnału w tygodniach
input double SignalProfitFactor = 0;         // Profit factor (0 = brak)

bool IsGold(const string sym)
{
   string s = sym;
   StringToUpper(s);
   return StringFind(s, "XAU") >= 0 || StringFind(s, "GOLD") >= 0;
}

string JsonEscape(const string s)
{
   string r = s;
   StringReplace(r, "\\", "\\\\");
   StringReplace(r, "\"", "\\\"");
   return r;
}

string Num(const double v, const int digits) { return DoubleToString(v, digits); }

string BuildPayload(double &goldPrice)
{
   string positions = "";
   goldPrice = 0;
   int total = PositionsTotal();
   for(int i = 0; i < total; i++)
   {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0 || !PositionSelectByTicket(ticket)) continue;
      string sym = PositionGetString(POSITION_SYMBOL);
      if(!IsGold(sym)) continue;

      int digits = (int)SymbolInfoInteger(sym, SYMBOL_DIGITS);
      long type  = PositionGetInteger(POSITION_TYPE);
      double cur = PositionGetDouble(POSITION_PRICE_CURRENT);
      if(goldPrice == 0) goldPrice = SymbolInfoDouble(sym, SYMBOL_BID);

      string p = StringFormat(
         "{\"id\":\"%I64u\",\"symbol\":\"%s\",\"side\":\"%s\",\"lots\":%s,\"openPrice\":%s,"
         "\"openTime\":%I64d000,\"sl\":%s,\"tp\":%s,\"currentPrice\":%s,\"profit\":%s}",
         ticket, JsonEscape(sym), type == POSITION_TYPE_BUY ? "buy" : "sell",
         Num(PositionGetDouble(POSITION_VOLUME), 2),
         Num(PositionGetDouble(POSITION_PRICE_OPEN), digits),
         (long)PositionGetInteger(POSITION_TIME),
         Num(PositionGetDouble(POSITION_SL), digits),
         Num(PositionGetDouble(POSITION_TP), digits),
         Num(cur, digits),
         Num(PositionGetDouble(POSITION_PROFIT) + PositionGetDouble(POSITION_SWAP), 2));
      if(positions != "") positions += ",";
      positions += p;
   }

   string name = TraderName != "" ? TraderName : IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   string stats = StringFormat(
      "{\"growthPct\":%s,\"maxDrawdownPct\":%s,\"ageWeeks\":%d,\"balance\":%s,\"equity\":%s%s}",
      Num(SignalGrowthPct, 2), Num(SignalMaxDDPct, 2), SignalAgeWeeks,
      Num(AccountInfoDouble(ACCOUNT_BALANCE), 2), Num(AccountInfoDouble(ACCOUNT_EQUITY), 2),
      SignalProfitFactor > 0 ? ",\"profitFactor\":" + Num(SignalProfitFactor, 2) : "");

   return StringFormat(
      "{\"account\":{\"id\":\"%I64d\",\"name\":\"%s\",\"stats\":%s},\"price\":%s,\"positions\":[%s]}",
      AccountInfoInteger(ACCOUNT_LOGIN), JsonEscape(name), stats, Num(goldPrice, 2), positions);
}

void Send()
{
   double price;
   string body = BuildPayload(price);
   char data[], result[];
   string resultHeaders;
   int len = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(data, len - 1); // drop trailing NUL
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + IngestToken + "\r\n";

   ResetLastError();
   int code = WebRequest("POST", ServerUrl, headers, 5000, data, result, resultHeaders);
   if(code == -1)
      Print("GoldCopyRadar: WebRequest błąd ", GetLastError(), " – dodaj URL do dozwolonych w opcjach terminala");
   else if(code != 200)
      Print("GoldCopyRadar: HTTP ", code, " ", CharArrayToString(result));
}

int OnInit()
{
   if(IngestToken == "")
   {
      Print("GoldCopyRadar: ustaw IngestToken");
      return INIT_PARAMETERS_INCORRECT;
   }
   EventSetTimer(MathMax(1, IntervalSec));
   Send();
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }
void OnTimer() { Send(); }
void OnTradeTransaction(const MqlTradeTransaction &t, const MqlTradeRequest &r, const MqlTradeResult &res)
{
   // Send immediately when a position opens/closes, not only on the timer.
   if(t.type == TRADE_TRANSACTION_DEAL_ADD) Send();
}
//+------------------------------------------------------------------+
