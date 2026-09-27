// XauAiFeeder v2 – cBot dla cTrader Automate.
//
// Wysyła do XAU AI Desk (POST /api/bars):
//  - zamknięte świece XAUUSD (na start historię, potem każdą nową świecę),
//  - zamknięte świece rynków powiązanych (domyślnie EURUSD, XAGUSD, USDJPY),
//  - bieżącą cenę i spread złota,
//  - saldo konta i parametry symbolu, żeby AI mogło policzyć wielkość pozycji,
//  - Twoje zamknięte transakcje i otwarte pozycje na złocie, z których uczy
//    się osobisty trener AI (kiedy Twoje decyzje wychodzą, a kiedy nie).
// Serwer w odpowiedzi podaje, jakie świece już ma, więc po restarcie lub
// wyczyszczeniu pamięci AI cBot sam dośle brakującą historię.
//
// cBot NIE otwiera żadnych transakcji: tylko przesyła dane.
//
// Instalacja: cTrader -> Algo -> cBots -> New -> wklej ten plik -> Build.
// Uruchom na wykresie XAUUSD i ustaw "Ingest token" taki jak INGEST_TOKEN w .env.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.RegularExpressions;
using cAlgo.API;

namespace cAlgo.Robots
{
    [Robot(TimeZone = TimeZones.UTC, AccessRights = AccessRights.FullAccess)]
    public class XauAiFeeder : Robot
    {
        [Parameter("Server URL", DefaultValue = "http://127.0.0.1:3000/api/bars")]
        public string ServerUrl { get; set; }

        [Parameter("Ingest token", DefaultValue = "")]
        public string IngestToken { get; set; }

        [Parameter("Timeframe (jak AI_TIMEFRAME)", DefaultValue = "Minute15")]
        public TimeFrame BarsTimeFrame { get; set; }

        [Parameter("History bars", DefaultValue = 100000, MinValue = 500)]
        public int HistoryBars { get; set; }

        [Parameter("Related symbols", DefaultValue = "EURUSD,XAGUSD,USDJPY")]
        public string RelatedSymbols { get; set; }

        [Parameter("Bars per request", DefaultValue = 1000, MinValue = 50, MaxValue = 5000)]
        public int ChunkBars { get; set; }

        [Parameter("Price interval (s)", DefaultValue = 2, MinValue = 1)]
        public int IntervalSec { get; set; }

        private class Feed
        {
            public string Name;
            public Bars Bars;
            public int Digits;
            public DateTime LastSent = DateTime.MinValue; // open time of the last bar the server has
        }

        private static readonly HttpClient Client = new HttpClient { Timeout = TimeSpan.FromSeconds(30) };
        private Feed _gold;
        private readonly List<Feed> _aux = new List<Feed>();
        private string _tf;
        private TimeSpan _span;
        private DateTime _lastTradeClose = DateTime.MinValue; // newest of your closed trades the server has
        private int _ticks;

        protected override void OnStart()
        {
            if (string.IsNullOrWhiteSpace(IngestToken))
            {
                Log("ustaw parametr 'Ingest token' (INGEST_TOKEN z pliku .env)");
                Stop();
                return;
            }
            _tf = TimeFrameName(BarsTimeFrame);
            if (_tf == null)
            {
                Log("obsługiwane interwały to Minute5, Minute15, Minute30, Hour, Hour4");
                Stop();
                return;
            }
            _span = TimeFrameSpan(_tf);
            var name = SymbolName.ToUpperInvariant();
            if (!name.Contains("XAU") && !name.Contains("GOLD"))
                Log("UWAGA – uruchom cBota na wykresie XAUUSD, teraz jest " + SymbolName);

            _gold = new Feed { Name = SymbolName, Bars = LoadBars(SymbolName), Digits = Symbol.Digits };
            foreach (var raw in (RelatedSymbols ?? "").Split(','))
            {
                var sym = raw.Trim();
                if (sym.Length == 0) continue;
                if (!Symbols.Exists(sym))
                {
                    Log("broker nie ma symbolu " + sym + " – pomijam");
                    continue;
                }
                _aux.Add(new Feed { Name = sym, Bars = LoadBars(sym), Digits = Symbols.GetSymbol(sym).Digits });
            }

            // Ask the server what it already has, then send only what is missing.
            var hello = Post(Payload(null, null, "", null));
            if (hello != null) Reconcile(hello);
            SyncAll();
            SyncTrades();
            _gold.Bars.BarOpened += args => SyncAll(); // the previous bar has just closed
            Positions.Closed += args => SyncTrades();   // learn from your trade right away
            Timer.Start(TimeSpan.FromSeconds(IntervalSec));
        }

        protected override void OnTimer()
        {
            if (NeedsSync())
                SyncAll(); // new bar or an earlier send failed
            else
            {
                var resp = Post(Payload(null, null, "", null));
                if (resp != null) Reconcile(resp);
            }
            if (++_ticks % 30 == 0) SyncTrades(); // fallback, e.g. after the server restarted
        }

        private Bars LoadBars(string symbol)
        {
            var bars = MarketData.GetBars(BarsTimeFrame, symbol);
            while (bars.Count < HistoryBars + 1)
            {
                if (bars.LoadMoreHistory() <= 0) break; // broker has no older data
            }
            Log(symbol + ": dostępne świece historii: " + bars.Count);
            return bars;
        }

        private static string TimeFrameName(TimeFrame tf)
        {
            if (tf == TimeFrame.Minute5) return "M5";
            if (tf == TimeFrame.Minute15) return "M15";
            if (tf == TimeFrame.Minute30) return "M30";
            if (tf == TimeFrame.Hour) return "H1";
            if (tf == TimeFrame.Hour4) return "H4";
            return null;
        }

        private static TimeSpan TimeFrameSpan(string tf)
        {
            switch (tf)
            {
                case "M5": return TimeSpan.FromMinutes(5);
                case "M15": return TimeSpan.FromMinutes(15);
                case "M30": return TimeSpan.FromMinutes(30);
                case "H1": return TimeSpan.FromHours(1);
                default: return TimeSpan.FromHours(4);
            }
        }

        // Index of the newest bar whose time is over (the last one may still be forming).
        private int LastClosedIndex(Feed f)
        {
            int i = f.Bars.Count - 1;
            while (i >= 0 && f.Bars.OpenTimes[i] + _span > Server.Time) i--;
            return i;
        }

        private bool NeedsSync()
        {
            foreach (var f in AllFeeds())
            {
                int last = LastClosedIndex(f);
                if (last >= 0 && f.Bars.OpenTimes[last] > f.LastSent) return true;
            }
            return false;
        }

        private IEnumerable<Feed> AllFeeds()
        {
            foreach (var f in _aux) yield return f;
            yield return _gold;
        }

        // Related markets first, so the AI has them when the gold bar arrives.
        private void SyncAll()
        {
            foreach (var f in _aux)
                if (!SyncFeed(f, true)) return;
            SyncFeed(_gold, false);
        }

        private bool SyncFeed(Feed f, bool isAux)
        {
            int last = LastClosedIndex(f);
            int start = Math.Max(0, last + 1 - HistoryBars);
            while (start <= last && f.Bars.OpenTimes[start] <= f.LastSent) start++;
            int total = last + 1 - start;

            for (int i = start; i <= last; i += ChunkBars)
            {
                int end = Math.Min(last + 1, i + ChunkBars);
                string rows = Rows(f, i, end);
                string resp = Post(isAux ? Payload(f.Name, rows, "", null) : Payload(null, null, rows, null));
                if (resp == null) return false; // try again on the next timer tick
                f.LastSent = f.Bars.OpenTimes[end - 1];
                Reconcile(resp);
                if (total > ChunkBars)
                    Log(f.Name + ": wysłano " + (end - start) + " z " + total + " świec historii");
            }
            return true;
        }

        private static long UnixSec(DateTime t)
        {
            return new DateTimeOffset(DateTime.SpecifyKind(t, DateTimeKind.Utc)).ToUnixTimeSeconds();
        }

        // Your closed gold trades newer than what the server has, oldest first.
        private void SyncTrades()
        {
            var list = new List<HistoricalTrade>();
            foreach (HistoricalTrade h in History)
                if (h.SymbolName == SymbolName && h.ClosingTime > _lastTradeClose) list.Add(h);
            list.Sort((a, b) => a.ClosingTime.CompareTo(b.ClosingTime));
            for (int i = 0; i < list.Count; i += 500)
            {
                var sb = new StringBuilder();
                int end = Math.Min(list.Count, i + 500);
                for (int k = i; k < end; k++)
                {
                    var h = list[k];
                    if (k > i) sb.Append(',');
                    sb.Append('[').Append(Str(h.PositionId + ":" + h.ClosingDealId))
                      .Append(',').Append(h.TradeType == TradeType.Buy ? "1" : "-1")
                      .Append(',').Append(UnixSec(h.EntryTime))
                      .Append(',').Append(Num(h.EntryPrice))
                      .Append(',').Append(UnixSec(h.ClosingTime))
                      .Append(',').Append(Num(h.ClosingPrice))
                      .Append(',').Append(Num(h.VolumeInUnits))
                      .Append(',').Append(Num(h.NetProfit))
                      .Append(']');
                }
                string resp = Post(Payload(null, null, "", sb.ToString()));
                if (resp == null) return;
                _lastTradeClose = list[end - 1].ClosingTime;
                Reconcile(resp);
                if (list.Count > 500) Log("wysłano " + end + " z " + list.Count + " Twoich transakcji");
            }
        }

        private string PositionRows()
        {
            var sb = new StringBuilder();
            foreach (var p in Positions)
            {
                if (p.SymbolName != SymbolName) continue;
                if (sb.Length > 0) sb.Append(',');
                sb.Append('[').Append(Str(p.Id.ToString(CultureInfo.InvariantCulture)))
                  .Append(',').Append(p.TradeType == TradeType.Buy ? "1" : "-1")
                  .Append(',').Append(UnixSec(p.EntryTime))
                  .Append(',').Append(Num(p.EntryPrice))
                  .Append(',').Append(Num(p.VolumeInUnits))
                  .Append(',').Append(Num(p.StopLoss.HasValue ? p.StopLoss.Value : 0))
                  .Append(',').Append(Num(p.TakeProfit.HasValue ? p.TakeProfit.Value : 0))
                  .Append(',').Append(Num(p.NetProfit))
                  .Append(']');
            }
            return sb.ToString();
        }

        private string Rows(Feed f, int from, int to)
        {
            var sb = new StringBuilder();
            string fmt = "F" + f.Digits;
            for (int k = from; k < to; k++)
            {
                if (k > from) sb.Append(',');
                long t = new DateTimeOffset(DateTime.SpecifyKind(f.Bars.OpenTimes[k], DateTimeKind.Utc)).ToUnixTimeSeconds();
                sb.Append('[').Append(t)
                  .Append(',').Append(f.Bars.OpenPrices[k].ToString(fmt, CultureInfo.InvariantCulture))
                  .Append(',').Append(f.Bars.HighPrices[k].ToString(fmt, CultureInfo.InvariantCulture))
                  .Append(',').Append(f.Bars.LowPrices[k].ToString(fmt, CultureInfo.InvariantCulture))
                  .Append(',').Append(f.Bars.ClosePrices[k].ToString(fmt, CultureInfo.InvariantCulture))
                  .Append(',').Append(((long)f.Bars.TickVolumes[k]).ToString(CultureInfo.InvariantCulture))
                  .Append(']');
            }
            return sb.ToString();
        }

        private static string Num(double v)
        {
            if (double.IsNaN(v) || double.IsInfinity(v)) return "0";
            return v.ToString("R", CultureInfo.InvariantCulture);
        }

        private static string Str(string s)
        {
            return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
        }

        // Every payload lists all related symbols (with bars only for the one
        // being sent), so the server reports what it has for each of them.
        private string Payload(string auxName, string auxRows, string goldRows, string tradeRows)
        {
            var sb = new StringBuilder();
            sb.Append("{\"symbol\":").Append(Str(SymbolName));
            sb.Append(",\"timeframe\":").Append(Str(_tf));
            sb.Append(",\"price\":").Append(Num(Symbol.Bid));
            sb.Append(",\"spread\":").Append(Num(Symbol.Spread));
            sb.Append(",\"account\":{\"balance\":").Append(Num(Account.Balance))
              .Append(",\"currency\":").Append(Str(Account.Asset.Name))
              .Append(",\"lotSize\":").Append(Num(Symbol.LotSize))
              .Append(",\"valuePerUnit\":").Append(Num(Symbol.PipValue / Symbol.PipSize))
              .Append(",\"minUnits\":").Append(Num(Symbol.VolumeInUnitsMin))
              .Append(",\"stepUnits\":").Append(Num(Symbol.VolumeInUnitsStep))
              .Append('}');
            sb.Append(",\"aux\":{");
            bool first = true;
            foreach (var f in _aux)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append(Str(f.Name)).Append(":[").Append(f.Name == auxName ? auxRows : "").Append(']');
            }
            sb.Append("},\"positions\":[").Append(PositionRows()).Append(']');
            if (tradeRows != null) sb.Append(",\"trades\":[").Append(tradeRows).Append(']');
            sb.Append(",\"bars\":[").Append(goldRows ?? "").Append("]}");
            return sb.ToString();
        }

        // The server answers {"last":{"XAUUSD":<ms>|null,"EURUSD":...}}: the
        // newest bar it has stored per symbol. Behind us = its memory was
        // cleared, so resend; ahead of us = we restarted, so skip what it has.
        private void Reconcile(string resp)
        {
            foreach (var f in AllFeeds())
            {
                var m = Regex.Match(resp, "\"" + Regex.Escape(f.Name) + "\":(\\d+|null)");
                if (!m.Success) continue;
                DateTime server = m.Groups[1].Value == "null"
                    ? DateTime.MinValue
                    : DateTimeOffset.FromUnixTimeMilliseconds(long.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture)).UtcDateTime;
                if (server < f.LastSent)
                    Log(f.Name + ": serwer nie ma części świec – wysyłam je ponownie");
                f.LastSent = server;
            }
            var tm = Regex.Match(resp, "\"trades\":(\\d+|null)");
            if (tm.Success)
            {
                _lastTradeClose = tm.Groups[1].Value == "null"
                    ? DateTime.MinValue
                    : DateTimeOffset.FromUnixTimeMilliseconds(long.Parse(tm.Groups[1].Value, CultureInfo.InvariantCulture)).UtcDateTime;
            }
        }

        // Print(string, params object[]) works like string.Format and would throw
        // on the braces of a JSON error message, so everything is logged via {0}.
        private void Log(string message)
        {
            Print("{0}", "XauAiFeeder: " + message);
        }

        private string Post(string body)
        {
            try
            {
                using (var req = new HttpRequestMessage(System.Net.Http.HttpMethod.Post, ServerUrl))
                {
                    req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + IngestToken);
                    req.Content = new StringContent(body, Encoding.UTF8, "application/json");
                    using (var res = Client.SendAsync(req).GetAwaiter().GetResult())
                    {
                        string text = res.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                        if (res.IsSuccessStatusCode) return text;
                        Log("HTTP " + (int)res.StatusCode + " " + text);
                        return null;
                    }
                }
            }
            catch (Exception e)
            {
                Log("brak połączenia z serwerem (" + ServerUrl + "): " + e.GetBaseException().Message +
                    " – czy uruchomiłeś start.bat?");
                return null;
            }
        }
    }
}
