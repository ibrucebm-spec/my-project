//+------------------------------------------------------------------+
//| XauAiFeeder.mq5                                                  |
//| Wysyła zamknięte świece XAUUSD do XAU AI Desk                    |
//| (POST /api/bars). Przy starcie wysyła historię, żeby AI mogło    |
//| się na niej nauczyć, potem każdą nową świecę i bieżącą cenę.     |
//|                                                                  |
//| EA NIE otwiera żadnych transakcji: tylko przesyła dane.          |
//|                                                                  |
//| WAŻNE: Narzędzia -> Opcje -> Doradcy Expert -> "Zezwalaj na      |
//| WebRequest dla wymienionych URL" -> dodaj adres serwera, np.     |
//| http://127.0.0.1:3000                                            |
//+------------------------------------------------------------------+
#property copyright "XAU AI Desk"
#property version   "1.00"

input string          ServerUrl   = "http://127.0.0.1:3000/api/bars"; // Adres endpointu
input string          IngestToken = "";          // INGEST_TOKEN z pliku .env
input ENUM_TIMEFRAMES Timeframe   = PERIOD_M15;  // Interwał (taki sam jak AI_TIMEFRAME)
input int             HistoryBars = 20000;       // Ile świec historii wysłać na start
input int             ChunkBars   = 1000;        // Świec w jednym zapytaniu
input int             IntervalSec = 2;           // Co ile sekund wysyłać cenę

datetime g_lastSent = 0;   // czas otwarcia ostatniej wysłanej zamkniętej świecy
datetime g_lastCheck = 0;  // czas otwarcia bieżącej świecy przy ostatnim sprawdzeniu

string TfName()
{
   string s = EnumToString(Timeframe == PERIOD_CURRENT ? (ENUM_TIMEFRAMES)_Period : Timeframe);
   StringReplace(s, "PERIOD_", "");
   return s;
}

// Broker server time -> UTC offset in seconds, rounded to 15 minutes.
long ServerUtcOffset()
{
   return (long)MathRound((double)(TimeTradeServer() - TimeGMT()) / 900.0) * 900;
}

bool Post(const string body)
{
   char data[], result[];
   string resultHeaders;
   int len = StringToCharArray(body, data, 0, WHOLE_ARRAY, CP_UTF8);
   ArrayResize(data, len - 1); // drop trailing NUL
   string headers = "Content-Type: application/json\r\nAuthorization: Bearer " + IngestToken + "\r\n";
   ResetLastError();
   int code = WebRequest("POST", ServerUrl, headers, 15000, data, result, resultHeaders);
   if(code == -1)
   {
      Print("XauAiFeeder: WebRequest błąd ", GetLastError(), " – dodaj URL do dozwolonych w opcjach terminala i uruchom serwer");
      return false;
   }
   if(code != 200)
   {
      Print("XauAiFeeder: HTTP ", code, " ", CharArrayToString(result));
      return false;
   }
   return true;
}

string Payload(const string bars)
{
   double bid = SymbolInfoDouble(_Symbol, SYMBOL_BID);
   return StringFormat("{\"symbol\":\"%s\",\"timeframe\":\"%s\",\"price\":%s,\"bars\":[%s]}",
                       _Symbol, TfName(), DoubleToString(bid, _Digits), bars);
}

// Sends every closed bar newer than g_lastSent, oldest first, in chunks.
void SyncBars()
{
   MqlRates rates[];
   ArraySetAsSeries(rates, false);
   int n = CopyRates(_Symbol, Timeframe, 1, HistoryBars, rates); // from 1 = only closed bars
   if(n <= 0)
   {
      Print("XauAiFeeder: brak historii świec (", GetLastError(), "), spróbuję ponownie");
      return;
   }
   long offset = ServerUtcOffset();
   int start = 0;
   while(start < n && rates[start].time <= g_lastSent) start++;

   for(int i = start; i < n; i += ChunkBars)
   {
      int end = MathMin(n, i + ChunkBars);
      string bars = "";
      for(int k = i; k < end; k++)
      {
         if(k > i) bars += ",";
         bars += StringFormat("[%I64d,%s,%s,%s,%s,%I64d]",
            (long)rates[k].time - offset,
            DoubleToString(rates[k].open, _Digits), DoubleToString(rates[k].high, _Digits),
            DoubleToString(rates[k].low, _Digits), DoubleToString(rates[k].close, _Digits),
            rates[k].tick_volume);
      }
      if(!Post(Payload(bars))) return; // try again on the next timer tick
      g_lastSent = rates[end - 1].time;
      if(n - start > ChunkBars)
         Print("XauAiFeeder: wysłano ", end - start, " z ", n - start, " świec historii");
   }
}

int OnInit()
{
   if(IngestToken == "")
   {
      Print("XauAiFeeder: ustaw IngestToken");
      return INIT_PARAMETERS_INCORRECT;
   }
   string s = _Symbol;
   StringToUpper(s);
   if(StringFind(s, "XAU") < 0 && StringFind(s, "GOLD") < 0)
      Print("XauAiFeeder: UWAGA – uruchom EA na wykresie XAUUSD/GOLD, teraz jest ", _Symbol);
   EventSetTimer(MathMax(1, IntervalSec));
   SyncBars();
   g_lastCheck = iTime(_Symbol, Timeframe, 0);
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { EventKillTimer(); }

void OnTimer()
{
   datetime cur = iTime(_Symbol, Timeframe, 0);
   datetime lastClosed = iTime(_Symbol, Timeframe, 1);
   if(cur != g_lastCheck || lastClosed > g_lastSent)
   {
      g_lastCheck = cur;
      SyncBars();          // new bar closed (or an earlier send failed)
   }
   else
      Post(Payload(""));   // price only
}
//+------------------------------------------------------------------+
