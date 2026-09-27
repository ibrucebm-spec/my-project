// Working fake of the cTrader runtime (same member names/types as the stub),
// so the real cBot code can run against the real server.
using System;
using System.Collections;
using System.Collections.Generic;
namespace cAlgo.API
{
    public enum AccessRights { None, FullAccess }
    public static class TimeZones { public const string UTC = "UTC"; }
    [AttributeUsage(AttributeTargets.Class)] public class RobotAttribute : Attribute { public string TimeZone { get; set; } public AccessRights AccessRights { get; set; } }
    [AttributeUsage(AttributeTargets.Property)] public class ParameterAttribute : Attribute { public ParameterAttribute(string name) { } public object DefaultValue { get; set; } public double MinValue { get; set; } public double MaxValue { get; set; } }
    public sealed class TimeFrame { public static readonly TimeFrame Minute5 = new TimeFrame(), Minute15 = new TimeFrame(), Minute30 = new TimeFrame(), Hour = new TimeFrame(), Hour4 = new TimeFrame(), Daily = new TimeFrame(); }
    public enum TradeType { Buy, Sell }
    public enum HttpMethod { Get, Post }
    public class Series<T> { public List<T> L = new List<T>(); public T this[int i] { get { return L[i]; } } public int Count { get { return L.Count; } } }
    public class DataSeries : Series<double> { }
    public class TimeSeries : Series<DateTime> { }
    public class BarOpenedEventArgs { }
    public class Bars
    {
        public TimeSeries OpenTimes = new TimeSeries(); public DataSeries OpenPrices = new DataSeries(), HighPrices = new DataSeries(), LowPrices = new DataSeries(), ClosePrices = new DataSeries(), TickVolumes = new DataSeries();
        public int Count { get { return OpenTimes.Count; } }
        public event Action<BarOpenedEventArgs> BarOpened;
        public int LoadMoreHistory() { return 0; }
        public void Add(DateTime t, double o, double h, double l, double c, double v) { OpenTimes.L.Add(t); OpenPrices.L.Add(o); HighPrices.L.Add(h); LowPrices.L.Add(l); ClosePrices.L.Add(c); TickVolumes.L.Add(v); }
        public void FireOpened() { if (BarOpened != null) BarOpened(new BarOpenedEventArgs()); }
    }
    public class MarketData { public Dictionary<string, Bars> ByName = new Dictionary<string, Bars>(); public Bars GetBars(TimeFrame tf) { return null; } public Bars GetBars(TimeFrame tf, string symbolName) { return ByName[symbolName]; } }
    public class Symbol { public string Name { get; set; } public int Digits { get; set; } public double Bid { get; set; } public double Spread { get; set; } public double LotSize { get; set; } public double PipValue { get; set; } public double PipSize { get; set; } public double VolumeInUnitsMin { get; set; } public double VolumeInUnitsStep { get; set; } }
    public class Symbols { public Dictionary<string, Symbol> M = new Dictionary<string, Symbol>(); public bool Exists(string s) { return M.ContainsKey(s); } public Symbol GetSymbol(string s) { return M[s]; } }
    public class Asset { public string Name { get; set; } }
    public class IAccount { public double Balance { get; set; } public Asset Asset { get; set; } }
    public class HistoricalTrade { public int ClosingDealId { get; set; } public int PositionId { get; set; } public string SymbolName { get; set; } public TradeType TradeType { get; set; } public double VolumeInUnits { get; set; } public DateTime EntryTime { get; set; } public double EntryPrice { get; set; } public DateTime ClosingTime { get; set; } public double ClosingPrice { get; set; } public double NetProfit { get; set; } }
    public class History : IEnumerable<HistoricalTrade> { public List<HistoricalTrade> L = new List<HistoricalTrade>(); public IEnumerator<HistoricalTrade> GetEnumerator() { return L.GetEnumerator(); } IEnumerator IEnumerable.GetEnumerator() { return L.GetEnumerator(); } }
    public class Position { public int Id { get; set; } public string SymbolName { get; set; } public TradeType TradeType { get; set; } public DateTime EntryTime { get; set; } public double EntryPrice { get; set; } public double VolumeInUnits { get; set; } public double? StopLoss { get; set; } public double? TakeProfit { get; set; } public double NetProfit { get; set; } }
    public class PositionClosedEventArgs { }
    public class Positions : IEnumerable<Position> { public List<Position> L = new List<Position>(); public event Action<PositionClosedEventArgs> Closed; public void FireClosed() { if (Closed != null) Closed(new PositionClosedEventArgs()); } public IEnumerator<Position> GetEnumerator() { return L.GetEnumerator(); } IEnumerator IEnumerable.GetEnumerator() { return L.GetEnumerator(); } }
    public class Timer { public void Start(TimeSpan interval) { } }
    public class Server { public DateTime Time { get; set; } }
    public abstract class Robot
    {
        protected virtual void OnStart() { }
        protected virtual void OnTimer() { }
        public bool Stopped;
        public void Stop() { Stopped = true; }
        public void Print(object value) { Console.WriteLine(value); }
        public void Print(string message, params object[] parameters) { Console.WriteLine(string.Format(message, parameters)); }
        public Symbol Symbol { get; set; }
        public string SymbolName { get; set; }
        public Symbols Symbols { get; set; }
        public MarketData MarketData { get; set; }
        public IAccount Account { get; set; }
        public History History { get; set; }
        public Positions Positions { get; set; }
        public Timer Timer { get; set; }
        public Server Server { get; set; }
        public void RunStart() { OnStart(); }
        public void RunTimer() { OnTimer(); }
    }
}
