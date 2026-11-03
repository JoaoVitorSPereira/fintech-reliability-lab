import { create } from 'zustand';

// Local UI state only. Server data (prices, balances, orders) lives in
// Apollo's normalized cache and is never copied here.
export type Timeframe = 'M1' | 'M5' | 'M15' | 'H1' | 'H4' | 'D1' | 'W1' | 'MN1';
export type ChartMode = 'line' | 'candles';
export type MarketTab = 'CRYPTO' | 'STOCK' | 'ETF';
export type MarketSort = 'MARKET_CAP' | 'PRICE' | 'CHANGE_24H' | 'VOLUME';

type UiState = {
  timeframe: Timeframe;
  chartMode: ChartMode;
  marketTab: MarketTab;
  marketSort: MarketSort;
  setTimeframe: (timeframe: Timeframe) => void;
  setChartMode: (mode: ChartMode) => void;
  setMarketTab: (tab: MarketTab) => void;
  setMarketSort: (sort: MarketSort) => void;
};

export const useUiStore = create<UiState>()((set) => ({
  timeframe: 'H1',
  chartMode: 'line',
  marketTab: 'CRYPTO',
  marketSort: 'MARKET_CAP',
  setTimeframe: (timeframe) => set({ timeframe }),
  setChartMode: (chartMode) => set({ chartMode }),
  setMarketTab: (marketTab) => set({ marketTab }),
  setMarketSort: (marketSort) => set({ marketSort }),
}));

/** How far back each timeframe looks: a sensible window, under the API's 1000-bar cap. */
export const TIMEFRAME_WINDOW_MS: Record<Timeframe, number> = {
  M1: 6 * 60 * 60_000,
  M5: 12 * 60 * 60_000,
  M15: 2 * 24 * 60 * 60_000,
  H1: 7 * 24 * 60 * 60_000,
  H4: 30 * 24 * 60 * 60_000,
  D1: 365 * 24 * 60 * 60_000,
  W1: 3 * 365 * 24 * 60 * 60_000,
  MN1: 10 * 365 * 24 * 60 * 60_000,
};
