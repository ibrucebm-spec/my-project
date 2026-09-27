// XauAiFeeder – cBot dla cTrader Automate.
//
// Wysyła zamknięte świece XAUUSD do XAU AI Advisor (POST /api/bars).
// Przy starcie wysyła historię, żeby AI mogło się na niej nauczyć, potem
// każdą nową zamkniętą świecę i co kilka sekund bieżącą cenę.
//
// cBot NIE otwiera żadnych transakcji: tylko przesyła dane.
//
// Instalacja: cTrader -> Algo -> cBots -> New -> wklej ten plik -> Build.
// Uruchom na wykresie XAUUSD i ustaw "Ingest token" taki jak INGEST_TOKEN w .env.
// Przy starcie cTrader zapyta o zgodę na pełny dostęp (AccessRights.FullAccess):
// jest potrzebny, żeby cBot mógł wysyłać dane przez HTTP do Twojego serwera.

using System;
using System.Globalization;
using System.Net.Http;
using System.Text;
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

        [Parameter("History bars", DefaultValue = 20000, MinValue = 200)]
        public int HistoryBars { get; set; }

        [Parameter("Bars per request", DefaultValue = 1000, MinValue = 50, MaxValue = 5000)]
        public int ChunkBars { get; set; }

        [Parameter("Price interval (s)", DefaultValue = 2, MinValue = 1)]
        public int IntervalSec { get; set; }

        private static readonly HttpClient Client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        private Bars _bars;
        private string _tf;
        private DateTime _lastSent = DateTime.MinValue; // open time of the last closed bar sent

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
                Log("obsługiwane interwały to Minute5, Minute15, Minute30, Hour, Hour4, Daily");
                Stop();
                return;
            }
            var name = SymbolName.ToUpperInvariant();
            if (!name.Contains("XAU") && !name.Contains("GOLD"))
                Log("UWAGA – uruchom cBota na wykresie XAUUSD, teraz jest " + SymbolName);

            _bars = MarketData.GetBars(BarsTimeFrame);
            while (_bars.Count < HistoryBars + 1)
            {
                if (_bars.LoadMoreHistory() <= 0) break; // broker has no older data
            }
            Log("dostępne świece historii: " + (_bars.Count - 1));

            SyncBars();
            _bars.BarOpened += args => SyncBars(); // the previous bar has just closed
            Timer.Start(TimeSpan.FromSeconds(IntervalSec));
        }

        protected override void OnTimer()
        {
            // Retry bars that failed to send earlier; otherwise just send the price.
            if (_bars.Count >= 2 && _bars.OpenTimes[_bars.Count - 2] > _lastSent)
                SyncBars();
            else
                Post(Payload(""));
        }

        private static string TimeFrameName(TimeFrame tf)
        {
            if (tf == TimeFrame.Minute5) return "M5";
            if (tf == TimeFrame.Minute15) return "M15";
            if (tf == TimeFrame.Minute30) return "M30";
            if (tf == TimeFrame.Hour) return "H1";
            if (tf == TimeFrame.Hour4) return "H4";
            if (tf == TimeFrame.Daily) return "D1";
            return null;
        }

        private string Num(double v)
        {
            return v.ToString("F" + Symbol.Digits, CultureInfo.InvariantCulture);
        }

        private string Payload(string bars)
        {
            return "{\"symbol\":\"" + SymbolName + "\",\"timeframe\":\"" + _tf + "\",\"price\":" + Num(Symbol.Bid) +
                   ",\"bars\":[" + bars + "]}";
        }

        // Sends every closed bar newer than _lastSent, oldest first, in chunks.
        // The last bar in the series is still forming, so it is never sent.
        private void SyncBars()
        {
            int lastClosed = _bars.Count - 2;
            int start = Math.Max(0, lastClosed + 1 - HistoryBars);
            while (start <= lastClosed && _bars.OpenTimes[start] <= _lastSent) start++;

            for (int i = start; i <= lastClosed; i += ChunkBars)
            {
                int end = Math.Min(lastClosed + 1, i + ChunkBars);
                var sb = new StringBuilder();
                for (int k = i; k < end; k++)
                {
                    if (k > i) sb.Append(',');
                    long t = new DateTimeOffset(DateTime.SpecifyKind(_bars.OpenTimes[k], DateTimeKind.Utc)).ToUnixTimeSeconds();
                    sb.Append('[').Append(t)
                      .Append(',').Append(Num(_bars.OpenPrices[k]))
                      .Append(',').Append(Num(_bars.HighPrices[k]))
                      .Append(',').Append(Num(_bars.LowPrices[k]))
                      .Append(',').Append(Num(_bars.ClosePrices[k]))
                      .Append(',').Append(((long)_bars.TickVolumes[k]).ToString(CultureInfo.InvariantCulture))
                      .Append(']');
                }
                if (!Post(Payload(sb.ToString()))) return; // try again on the next timer tick
                _lastSent = _bars.OpenTimes[end - 1];
                if (lastClosed + 1 - start > ChunkBars)
                    Log("wysłano " + (end - start) + " z " + (lastClosed + 1 - start) + " świec historii");
            }
        }

        // Print(string, params object[]) works like string.Format and would throw
        // on the braces of a JSON error message, so everything is logged via {0}.
        private void Log(string message)
        {
            Print("{0}", "XauAiFeeder: " + message);
        }

        private bool Post(string body)
        {
            try
            {
                using (var req = new HttpRequestMessage(HttpMethod.Post, ServerUrl))
                {
                    req.Headers.TryAddWithoutValidation("Authorization", "Bearer " + IngestToken);
                    req.Content = new StringContent(body, Encoding.UTF8, "application/json");
                    using (var res = Client.SendAsync(req).GetAwaiter().GetResult())
                    {
                        if (res.IsSuccessStatusCode) return true;
                        Log("HTTP " + (int)res.StatusCode + " " + res.Content.ReadAsStringAsync().GetAwaiter().GetResult());
                        return false;
                    }
                }
            }
            catch (Exception e)
            {
                Log("brak połączenia z serwerem (" + ServerUrl + "): " + e.GetBaseException().Message +
                      " – czy uruchomiłeś npm start?");
                return false;
            }
        }
    }
}
