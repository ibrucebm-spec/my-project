// Test harness: runs the real cBot (../XauAiFeeder.cs) against CAlgoFake.cs and a local server.
using System;
using cAlgo.API;
using cAlgo.Robots;
public static class Harness
{
    static Bars Gen(int n, DateTime start, double p, int seed, double scale)
    {
        var r = new Random(seed); var b = new Bars(); double prev = 0;
        for (int i = 0; i < n; i++) { double ret = 0.25 * prev + (r.NextDouble() - 0.5) * 4 * scale; prev = ret; double o = p, c = p + ret; b.Add(start.AddMinutes(15 * i), o, Math.Max(o, c) + r.NextDouble() * scale, Math.Min(o, c) - r.NextDouble() * scale, c, 100 + r.Next(50)); p = c; }
        return b;
    }
    public static void Main(string[] args)
    {
        int n = 3000;
        var now = DateTime.UtcNow; var slot = new DateTime(now.Year, now.Month, now.Day, now.Hour, now.Minute / 15 * 15, 0, DateTimeKind.Utc);
        var start = slot.AddMinutes(-15 * (n - 1)); // last bar = the one forming now
        var md = new MarketData();
        md.ByName["XAUUSD"] = Gen(n, start, 2000, 1, 1);
        md.ByName["EURUSD"] = Gen(n, start, 1.1, 2, 0.0005);
        md.ByName["XAGUSD"] = Gen(n, start, 25, 3, 0.02);
        var syms = new Symbols();
        syms.M["XAUUSD"] = new Symbol { Name = "XAUUSD", Digits = 2, Bid = 2001.5, Spread = 0.28, LotSize = 100, PipValue = 0.01, PipSize = 0.01, VolumeInUnitsMin = 1, VolumeInUnitsStep = 1 };
        syms.M["EURUSD"] = new Symbol { Name = "EURUSD", Digits = 5 }; syms.M["XAGUSD"] = new Symbol { Name = "XAGUSD", Digits = 3 };
        var hist = new History();
        for (int k = 0; k < 40; k++) { var et = start.AddMinutes(15 * (400 + k * 60)); hist.L.Add(new HistoricalTrade { PositionId = 100 + k, ClosingDealId = 900 + k, SymbolName = "XAUUSD", TradeType = k % 2 == 0 ? TradeType.Buy : TradeType.Sell, VolumeInUnits = 10, EntryTime = et, EntryPrice = 2000, ClosingTime = et.AddMinutes(45), ClosingPrice = 2001, NetProfit = k % 3 == 0 ? -12.5 : 20 }); }
        hist.L.Add(new HistoricalTrade { PositionId = 1, ClosingDealId = 2, SymbolName = "EURUSD", EntryTime = start, ClosingTime = start.AddHours(1) }); // other symbol: ignored
        var pos = new Positions(); pos.L.Add(new Position { Id = 555, SymbolName = "XAUUSD", TradeType = TradeType.Buy, EntryTime = now.AddMinutes(-3), EntryPrice = 2001, VolumeInUnits = 20, StopLoss = null, TakeProfit = 2010, NetProfit = -3.1 });
        var bot = new XauAiFeeder
        {
            ServerUrl = "http://127.0.0.1:3456/api/bars", IngestToken = "test-token-1234567890", BarsTimeFrame = TimeFrame.Minute15,
            HistoryBars = 100000, RelatedSymbols = "EURUSD,XAGUSD,USDJPY", ChunkBars = 1000, IntervalSec = 2,
            Symbol = syms.M["XAUUSD"], SymbolName = "XAUUSD", Symbols = syms, MarketData = md,
            Account = new IAccount { Balance = 25000, Asset = new Asset { Name = "PLN" } }, History = hist, Positions = pos, Timer = new Timer(), Server = new Server { Time = now },
        };
        bot.RunStart();
        Console.WriteLine("stopped=" + bot.Stopped);
        // A new bar closes: the forming one is finished and a new one appears.
        bot.Server.Time = slot.AddMinutes(15).AddSeconds(5);
        foreach (var name in new[] { "XAUUSD", "EURUSD", "XAGUSD" }) { var b = md.ByName[name]; double c = b.ClosePrices[b.Count - 1]; b.Add(slot.AddMinutes(15), c, c, c, c, 1); }
        md.ByName["XAUUSD"].FireOpened();
        // You close a trade.
        hist.L.Add(new HistoricalTrade { PositionId = 555, ClosingDealId = 7777, SymbolName = "XAUUSD", TradeType = TradeType.Buy, VolumeInUnits = 20, EntryTime = now.AddMinutes(-3), EntryPrice = 2001, ClosingTime = now, ClosingPrice = 2004, NetProfit = 55 });
        pos.L.Clear(); pos.FireClosed();
        for (int i = 0; i < 3; i++) bot.RunTimer();
        Console.WriteLine("harness done");
    }
}
